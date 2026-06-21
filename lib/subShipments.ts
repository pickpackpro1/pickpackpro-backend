import { Prisma, ShipmentStatus, SubShipmentStatus } from "@prisma/client";
import { ApiError } from "./apiResponse";
import { areDispatchableBoxesDispatched, areDispatchableBoxLabelsReady } from "./pallets";

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

type BoxContentEntry = {
  shipmentItemId?: string;
  shipment_item_id?: string;
  shipmentLineItemId?: string;
  shipment_line_item_id?: string;
  lineItemId?: string;
  line_item_id?: string;
  itemId?: string;
  item_id?: string;
  quantity?: number | string | null;
  qty?: number | string | null;
  units?: number | string | null;
  qtyPacked?: number | string | null;
  qty_packed?: number | string | null;
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

function boxContents(contents: Prisma.JsonValue): BoxContentEntry[] {
  return Array.isArray(contents) ? (contents.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) as BoxContentEntry[]) : [];
}

function contentShipmentItemId(entry: BoxContentEntry) {
  return String(
    entry.shipmentItemId ??
      entry.shipment_item_id ??
      entry.shipmentLineItemId ??
      entry.shipment_line_item_id ??
      entry.lineItemId ??
      entry.line_item_id ??
      entry.itemId ??
      entry.item_id ??
      "",
  ).trim();
}

function contentQuantity(entry: BoxContentEntry) {
  const value = entry.quantity ?? entry.qty ?? entry.units ?? entry.qtyPacked ?? entry.qty_packed ?? 0;
  const quantity = Number(value);
  return Number.isFinite(quantity) ? quantity : 0;
}

function addQuantity(map: Map<string, number>, shipmentItemId: string, quantity: number) {
  if (!shipmentItemId || quantity <= 0) return;
  map.set(shipmentItemId, (map.get(shipmentItemId) ?? 0) + quantity);
}

export async function getSubShipmentAvailability(prisma: Db, shipmentId: string) {
  const [items, subItems, parentBoxes] = await Promise.all([
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
    prisma.outbound_boxes.findMany({
      where: {
        shipment_id: shipmentId,
        sub_shipment_id: null,
        box_type: "box",
      },
      select: { contents: true },
    }),
  ]);

  const assignedByItem = new Map<string, number>();
  for (const subItem of subItems) {
    addQuantity(assignedByItem, subItem.shipment_line_item_id, subItem.quantity);
  }

  const packedInParentBoxesByItem = new Map<string, number>();
  for (const box of parentBoxes) {
    for (const content of boxContents(box.contents)) {
      addQuantity(packedInParentBoxesByItem, contentShipmentItemId(content), contentQuantity(content));
    }
  }

  return items.map((item) => {
    const receivedQty = item.qty_received ?? 0;
    const assignedToSubShipments = assignedByItem.get(item.id) ?? 0;
    const packedInParentBoxes = packedInParentBoxesByItem.get(item.id) ?? 0;
    const consumedQty = assignedToSubShipments + packedInParentBoxes;
    const remainingQty = Math.max(receivedQty - consumedQty, 0);
    const prepared = isLineItemPrepared(item);
    const productName = item.product_name ?? item.products.product_name;
    return {
      shipmentItemId: item.id,
      sku: item.products.sku,
      productName,
      product_name: productName,
      expectedQty: item.qty_expected,
      receivedQty,
      dispatchQty: item.dispatch_qty ?? receivedQty,
      assignedQty: assignedToSubShipments,
      assignedToSubShipments,
      assigned_to_sub_shipments: assignedToSubShipments,
      packedInParentBoxes,
      packed_in_parent_boxes: packedInParentBoxes,
      consumedQty,
      consumed_qty: consumedQty,
      assignedDisplayQty: consumedQty,
      assigned_display_qty: consumedQty,
      remainingQty,
      remaining_qty: remainingQty,
      prepared,
      availableQty: prepared ? remainingQty : 0,
      available_qty: prepared ? remainingQty : 0,
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
    select: {
      id: true,
      status: true,
      dispatched_date: true,
      shipment_line_items: {
        select: {
          id: true,
          qty_received: true,
        },
      },
      outbound_boxes: {
        select: {
          box_type: true,
          contents: true,
          dispatched_at: true,
          sub_shipments: {
            select: {
              status: true,
            },
          },
        },
      },
    },
  });
  if (!shipment) return null;
  if (shipment.status === "dispatched" || shipment.status === "completed") return shipment;

  const requiredByItem = new Map<string, number>();
  for (const item of shipment.shipment_line_items) {
    const requiredQty = item.qty_received ?? 0;
    if (requiredQty > 0) requiredByItem.set(item.id, requiredQty);
  }

  const totalRequired = [...requiredByItem.values()].reduce((sum, quantity) => sum + quantity, 0);
  if (totalRequired <= 0) return shipment;

  const dispatchedByItem = new Map<string, number>();
  for (const box of shipment.outbound_boxes) {
    if (box.box_type !== "box") continue;
    if (!box.dispatched_at) continue;
    if (box.sub_shipments?.status === "cancelled") continue;

    for (const content of boxContents(box.contents)) {
      addQuantity(dispatchedByItem, contentShipmentItemId(content), contentQuantity(content));
    }
  }

  const allReceivedQuantitiesDispatched = [...requiredByItem.entries()].every(
    ([shipmentItemId, requiredQty]) => (dispatchedByItem.get(shipmentItemId) ?? 0) >= requiredQty,
  );

  if (allReceivedQuantitiesDispatched) {
    const updated = await prisma.shipments.update({
      where: { id: shipmentId },
      data: {
        status: "dispatched" as ShipmentStatus,
        dispatched_date: shipment.dispatched_date ?? new Date(),
        updated_at: new Date(),
      },
    });
    return updated;
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

  const allDispatched = areDispatchableBoxesDispatched(boxes);
  const allLabelsUploaded = areDispatchableBoxLabelsReady(boxes);
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
