import { Prisma, ShipmentStatus, SubShipmentStatus } from "@prisma/client";
import { ApiError } from "./apiResponse";

type Db = Prisma.TransactionClient;

type LineForPrep = {
  id: string;
  qty_expected: number;
  qty_received: number | null;
  dispatch_qty: number | null;
  services_selected: Prisma.JsonValue;
  service_status: Prisma.JsonValue;
};

type SubShipmentLineInput = {
  shipmentItemId: string;
  quantity: number;
};

const activeSubShipmentStatuses: SubShipmentStatus[] = [
  "draft",
  "awaiting_fba_labels",
  "ready_to_dispatch",
  "dispatched",
  "completed",
];

export function isLineItemPrepared(item: LineForPrep) {
  const selected = item.services_selected as string[] | null;
  const statuses = item.service_status as Record<string, string> | null;
  return (selected ?? []).every((service) => statuses?.[service] === "DONE" || statuses?.[service] === "done");
}

export async function getSubShipmentAvailability(prisma: Db, shipmentId: string) {
  const [items, subItems] = await Promise.all([
    prisma.shipment_line_items.findMany({
      where: { shipment_id: shipmentId },
      include: { products: true },
      orderBy: { created_at: "asc" },
    }),
    prisma.sub_shipment_items.findMany({
      where: {
        sub_shipments: {
          parent_shipment_id: shipmentId,
          status: { in: activeSubShipmentStatuses },
        },
      },
    }),
  ]);

  const assignedByItem = new Map<string, number>();
  for (const subItem of subItems) {
    assignedByItem.set(
      subItem.shipment_line_item_id,
      (assignedByItem.get(subItem.shipment_line_item_id) ?? 0) + subItem.quantity,
    );
  }

  return items.map((item) => {
    const receivedQty = item.qty_received ?? 0;
    const assignedQty = assignedByItem.get(item.id) ?? 0;
    const remainingQty = Math.max(receivedQty - assignedQty, 0);
    const prepared = isLineItemPrepared(item);
    return {
      shipmentItemId: item.id,
      sku: item.products.sku,
      productName: item.products.product_name,
      expectedQty: item.qty_expected,
      receivedQty,
      dispatchQty: item.dispatch_qty ?? receivedQty,
      assignedQty,
      remainingQty,
      prepared,
      availableQty: prepared ? remainingQty : 0,
    };
  });
}

export async function assertSubShipmentItemsAvailable(
  prisma: Db,
  shipmentId: string,
  items: SubShipmentLineInput[],
) {
  const availability = await getSubShipmentAvailability(prisma, shipmentId);
  const availabilityById = new Map(availability.map((item) => [item.shipmentItemId, item]));

  for (const requested of items) {
    const available = availabilityById.get(requested.shipmentItemId);
    if (!available) throw new ApiError("Shipment item not found", 404);
    if (!available.prepared) throw new ApiError(`SKU ${available.sku} is not fully prepped yet`, 422);
    if (requested.quantity > available.remainingQty) {
      throw new ApiError(
        `Cannot add ${requested.quantity} units for SKU ${available.sku}. Remaining available: ${available.remainingQty}`,
        422,
      );
    }
  }
}

export async function refreshParentShipmentDispatchStatus(prisma: Db, shipmentId: string) {
  const shipment = await prisma.shipments.findUnique({
    where: { id: shipmentId },
    include: {
      shipment_line_items: true,
      sub_shipments: {
        where: { status: { in: activeSubShipmentStatuses } },
        include: { sub_shipment_items: true },
      },
    },
  });
  if (!shipment) return null;

  const totalReceived = shipment.shipment_line_items.reduce((sum, item) => sum + (item.qty_received ?? 0), 0);
  const assignedQty = shipment.sub_shipments
    .flatMap((subShipment) => subShipment.sub_shipment_items)
    .reduce((sum, item) => sum + item.quantity, 0);
  const allAssigned = totalReceived > 0 && assignedQty >= totalReceived;
  const allSubShipmentsDispatched =
    shipment.sub_shipments.length > 0 &&
    shipment.sub_shipments.every((subShipment) => subShipment.status === "dispatched" || subShipment.status === "completed");

  if (allAssigned && allSubShipmentsDispatched && shipment.status !== "dispatched" && shipment.status !== "completed") {
    return prisma.shipments.update({
      where: { id: shipmentId },
      data: {
        status: "dispatched" as ShipmentStatus,
        dispatched_date: shipment.dispatched_date ?? new Date(),
        updated_at: new Date(),
      },
    });
  }

  return shipment;
}

export async function refreshSubShipmentStatusFromBoxes(prisma: Db, subShipmentId: string, dispatchedBy?: string) {
  const subShipment = await prisma.sub_shipments.findUnique({
    where: { id: subShipmentId },
    include: { outbound_boxes: true },
  });
  if (!subShipment || subShipment.status === "completed" || subShipment.status === "cancelled") return subShipment;

  const boxes = subShipment.outbound_boxes;
  if (boxes.length === 0) return subShipment;

  const allDispatched = boxes.every((box) => box.dispatched_at !== null);
  const allLabelsUploaded = boxes.every((box) => box.fba_shipping_label_file_id !== null);
  const nextStatus: SubShipmentStatus = allDispatched
    ? "dispatched"
    : allLabelsUploaded
      ? "ready_to_dispatch"
      : "awaiting_fba_labels";

  const updated = await prisma.sub_shipments.update({
    where: { id: subShipmentId },
    data: {
      status: nextStatus,
      updated_at: new Date(),
      dispatched_at: allDispatched ? subShipment.dispatched_at ?? new Date() : subShipment.dispatched_at,
      dispatched_by: allDispatched ? dispatchedBy ?? subShipment.dispatched_by : subShipment.dispatched_by,
    },
  });

  if (updated.status === "dispatched") {
    await refreshParentShipmentDispatchStatus(prisma, updated.parent_shipment_id);
  }

  return updated;
}
