import { Prisma, PrismaClient, ShipmentStatus } from "@prisma/client";
import { ApiError } from "./apiResponse";
import { areDispatchableBoxesDispatched } from "./pallets";

export function calculateDispatchQty(receivedQty: number, bundleSize = 1) {
  return Math.floor(receivedQty / Math.max(bundleSize, 1));
}

export function getBillingUnits(item: { qty_received: number | null }) {
  return item.qty_received ?? 0;
}

const serviceCodeAliases: Record<string, string> = {
  FNSKU_LABEL: "fnsku_label",
  fnsku_label: "fnsku_label",
  POLY_BAG: "polybag",
  poly_bag: "polybag",
  polybag: "polybag",
  BUBBLE_WRAP: "bubble_wrap",
  bubble_wrap: "bubble_wrap",
  BUNDLING: "bundling",
  bundling: "bundling",
  LEAFLET_INSERTION: "leaflet_insertion",
  MARKETING_LEAFLET_INSERTION: "leaflet_insertion",
  leaflet_insertion: "leaflet_insertion",
  OVERSIZE_SURCHARGE: "oversize_surcharge",
  OVERSIZED_ITEMS: "oversize_surcharge",
  oversize_surcharge: "oversize_surcharge",
  oversized_items: "oversize_surcharge",
  RETURN_PROCESSING: "return_processing",
  return_processing: "return_processing",
  PALLET_STORAGE: "pallet_storage",
  PALLET_STORAGE_WEEKLY: "pallet_storage",
  pallet_storage: "pallet_storage",
  pallet_storage_weekly: "pallet_storage",
  MEDIUM_BOX: "medium_box",
  medium_box: "medium_box",
  LARGE_BOX: "large_box",
  large_box: "large_box",
  PALLET_FORWARDING: "pallet_forwarding",
  pallet_forwarding: "pallet_forwarding",
  ONLY_BOX_FORWARDING: "box_forwarding",
  BOX_FORWARDING: "box_forwarding",
  only_box_forwarding: "box_forwarding",
  box_forwarding: "box_forwarding",
};

export function normalizeServiceCode(serviceCode: string) {
  const trimmed = String(serviceCode || "").trim();
  if (!trimmed) return "";
  const compact = trimmed
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return serviceCodeAliases[trimmed] ?? serviceCodeAliases[trimmed.toUpperCase()] ?? serviceCodeAliases[compact] ?? compact;
}

const validTransitions: Record<ShipmentStatus, ShipmentStatus[]> = {
  draft: ["submitted", "pending_arrival"],
  submitted: ["pending_arrival", "received"],
  pending_arrival: ["received"],
  received: ["in_progress"],
  in_progress: ["prepped"],
  prepped: ["dispatched"],
  dispatched: ["completed"],
  completed: [],
};

export async function validateStatusTransition(
  prisma: PrismaClient | Prisma.TransactionClient,
  shipment: Prisma.shipmentsGetPayload<{ include: { shipment_line_items: true } }>,
  newStatus: ShipmentStatus,
) {
  if (!validTransitions[shipment.status]?.includes(newStatus)) {
    return { valid: false, reason: `Cannot transition from ${shipment.status} to ${newStatus}` };
  }
  if (newStatus === "received" && shipment.shipment_line_items.some((i) => i.qty_received === null)) {
    return { valid: false, reason: "Not all items have been received yet" };
  }
  if (newStatus === "prepped") {
    const allDone = shipment.shipment_line_items.every((item) => {
      const statuses = item.service_status as Record<string, string> | null;
      const selected = item.services_selected as string[] | null;
      return (selected ?? []).every((service) => statuses?.[service] === "DONE" || statuses?.[service] === "done");
    });
    if (!allDone) return { valid: false, reason: "Not all service tasks are completed" };
  }
  if (newStatus === "dispatched") {
    const subShipments = await prisma.sub_shipments.findMany({
      where: { parent_shipment_id: shipment.id, status: { not: "cancelled" } },
      include: { sub_shipment_items: true },
    });
    if (subShipments.length > 0) {
      const totalReceived = shipment.shipment_line_items.reduce((sum, item) => sum + (item.qty_received ?? 0), 0);
      const assignedQty = subShipments
        .flatMap((subShipment) => subShipment.sub_shipment_items)
        .reduce((sum, item) => sum + item.quantity, 0);
      if (assignedQty < totalReceived) return { valid: false, reason: "Not all received units are assigned to sub-shipments" };
      if (subShipments.some((subShipment) => subShipment.status !== "dispatched" && subShipment.status !== "completed")) {
        return { valid: false, reason: "Not all sub-shipments have been dispatched" };
      }
      return { valid: true };
    }
    const boxes = await prisma.outbound_boxes.findMany({ where: { shipment_id: shipment.id, sub_shipment_id: null } });
    if (boxes.length === 0) return { valid: false, reason: "No boxes created for this shipment" };
    if (!areDispatchableBoxesDispatched(boxes)) {
      return { valid: false, reason: "Not all dispatchable boxes or pallets have been dispatched" };
    }
  }
  return { valid: true };
}

export async function assertTransition(
  prisma: PrismaClient | Prisma.TransactionClient,
  shipment: Prisma.shipmentsGetPayload<{ include: { shipment_line_items: true } }>,
  newStatus: ShipmentStatus,
) {
  const result = await validateStatusTransition(prisma, shipment, newStatus);
  if (!result.valid) throw new ApiError(result.reason ?? "Invalid status transition", 422);
}

function boxContentShipmentItemId(entry: {
  shipmentItemId?: string;
  shipment_item_id?: string;
  shipmentLineItemId?: string;
  shipment_line_item_id?: string;
  lineItemId?: string;
  line_item_id?: string;
  itemId?: string;
  item_id?: string;
}) {
  return (
    entry.shipmentItemId ??
    entry.shipment_item_id ??
    entry.shipmentLineItemId ??
    entry.shipment_line_item_id ??
    entry.lineItemId ??
    entry.line_item_id ??
    entry.itemId ??
    entry.item_id
  );
}

function boxContentQuantity(entry: {
  quantity?: number;
  qty?: number;
  units?: number;
  qtyPacked?: number;
  qty_packed?: number;
}) {
  const value = entry.quantity ?? entry.qty ?? entry.units ?? entry.qtyPacked ?? entry.qty_packed ?? 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export async function validateBoxAllocation(
  prisma: PrismaClient | Prisma.TransactionClient,
  shipmentItemId: string,
  boxId: string,
  quantityToAdd: number,
) {
  const [item, box] = await Promise.all([
    prisma.shipment_line_items.findUnique({ where: { id: shipmentItemId } }),
    prisma.outbound_boxes.findUnique({ where: { id: boxId } }),
  ]);
  if (!item) return { valid: false, error: "Item not found" };
  if (item.qty_received === null) return { valid: false, error: "Item not yet received" };
  if (!box) return { valid: false, error: "Box not found" };
  if (box.box_type === "pallet") return { valid: false, error: "Pallets cannot hold SKU contents directly" };
  if (box.pallet_id) return { valid: false, error: "Boxes inside a pallet cannot be modified individually" };
  if (box.shipment_id !== item.shipment_id) return { valid: false, error: "Box does not belong to item shipment" };

  let maxAllocatable = item.qty_received ?? item.qty_expected ?? item.dispatch_qty ?? 0;
  let boxesWhere: Prisma.outbound_boxesWhereInput = { shipment_id: item.shipment_id };

  if (box.sub_shipment_id) {
    const subShipmentItem = await prisma.sub_shipment_items.findFirst({
      where: {
        sub_shipment_id: box.sub_shipment_id,
        shipment_line_item_id: shipmentItemId,
        sub_shipments: { status: { not: "cancelled" } },
      },
    });
    if (!subShipmentItem) return { valid: false, error: "Item is not part of this sub-shipment" };
    maxAllocatable = subShipmentItem.quantity;
    boxesWhere = { sub_shipment_id: box.sub_shipment_id };
  } else {
    const subShipmentItems = await prisma.sub_shipment_items.findMany({
      where: {
        shipment_line_item_id: shipmentItemId,
        sub_shipments: {
          parent_shipment_id: item.shipment_id,
          status: { not: "cancelled" },
        },
      },
    });
    const assignedToSubShipments = subShipmentItems.reduce((sum, subItem) => sum + subItem.quantity, 0);
    maxAllocatable = Math.max((item.qty_received ?? 0) - assignedToSubShipments, 0);
    boxesWhere = { shipment_id: item.shipment_id, sub_shipment_id: null };
  }

  const boxes = await prisma.outbound_boxes.findMany({ where: boxesWhere });
  const allocated = boxes.reduce((sum, current) => {
    const contents = current.contents as Array<{
      shipmentItemId?: string;
      shipment_item_id?: string;
      shipmentLineItemId?: string;
      shipment_line_item_id?: string;
      lineItemId?: string;
      line_item_id?: string;
      itemId?: string;
      item_id?: string;
      quantity?: number;
      qty?: number;
      units?: number;
      qtyPacked?: number;
      qty_packed?: number;
    }> | null;
    return (
      sum +
      (contents ?? [])
        .filter((entry) => boxContentShipmentItemId(entry) === shipmentItemId)
        .reduce((inner, entry) => inner + boxContentQuantity(entry), 0)
    );
  }, 0);
  if (allocated + quantityToAdd > maxAllocatable) {
    return {
      valid: false,
      error: `Cannot allocate ${quantityToAdd} units. Max allocatable: ${maxAllocatable - allocated} (received/boxable quantity: ${maxAllocatable})`,
    };
  }
  return { valid: true };
}
