import { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;
type Actor = { userId: string; email: string; role: string };

// Once a shipment (or the sub-shipment a line sits in) is dispatched, an invoice has been generated
// from its quantities, so anything that changes those quantities is locked.
export const FINAL_SHIPMENT_STATUSES = ["dispatched", "completed"] as const;
export const FINAL_SUB_SHIPMENT_STATUSES = ["dispatched", "completed"] as const;

export function isFinalShipmentStatus(status: string | null | undefined) {
  return (FINAL_SHIPMENT_STATUSES as readonly string[]).includes(String(status ?? ""));
}

function contentRows(value: Prisma.JsonValue): Record<string, unknown>[] {
  return Array.isArray(value)
    ? (value.filter((row) => row && typeof row === "object" && !Array.isArray(row)) as Record<string, unknown>[])
    : [];
}

function rowLineItemId(row: Record<string, unknown>) {
  return String(
    row.shipmentItemId ??
      row.shipment_item_id ??
      row.shipmentLineItemId ??
      row.shipment_line_item_id ??
      row.lineItemId ??
      row.line_item_id ??
      row.itemId ??
      row.item_id ??
      "",
  ).trim();
}

function rowQuantity(row: Record<string, unknown>) {
  const quantity = Number(row.quantity ?? row.qty ?? row.units ?? row.qtyPacked ?? row.qty_packed ?? 0);
  return Number.isFinite(quantity) ? quantity : 0;
}

// How much of one shipment line is already committed to boxes or sub-shipments.
export async function getLineItemUsage(db: Db, shipmentId: string, lineItemId: string) {
  const [boxes, subItems] = await Promise.all([
    db.outbound_boxes.findMany({ where: { shipment_id: shipmentId, box_type: "box" }, select: { contents: true } }),
    db.sub_shipment_items.findMany({
      where: { shipment_line_item_id: lineItemId, sub_shipments: { status: { not: "cancelled" } } },
      select: { quantity: true, sub_shipments: { select: { status: true } } },
    }),
  ]);

  let boxedQty = 0;
  for (const box of boxes) {
    for (const row of contentRows(box.contents)) {
      if (rowLineItemId(row) === lineItemId) boxedQty += rowQuantity(row);
    }
  }
  const subShipmentQty = subItems.reduce((sum, item) => sum + item.quantity, 0);
  const inFinalSubShipment = subItems.some((item) =>
    (FINAL_SUB_SHIPMENT_STATUSES as readonly string[]).includes(item.sub_shipments.status),
  );

  return { boxedQty, subShipmentQty, inFinalSubShipment };
}

export function correctionAudit(
  actor: Actor,
  action: string,
  entityType: string,
  entityId: string,
  before: unknown,
  after: unknown,
) {
  return {
    user_id: actor.userId,
    user_email: actor.email,
    user_role: actor.role,
    action,
    entity_type: entityType,
    entity_id: entityId,
    before_value: before == null ? Prisma.JsonNull : (JSON.parse(JSON.stringify(before)) as Prisma.InputJsonValue),
    after_value: after == null ? Prisma.JsonNull : (JSON.parse(JSON.stringify(after)) as Prisma.InputJsonValue),
  };
}
