import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { ApiError } from "./apiResponse";

type Db = Prisma.TransactionClient;
type JsonRecord = Record<string, unknown>;

type NormalizedAllocation = {
  shipmentItemId: string;
  quantity: number;
  sku?: string;
  productName?: string;
};

const ALLOCATION_KEYS = ["items", "boxItems", "box_items", "contents"] as const;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function firstPresent(...values: unknown[]) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "");
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function rowShipmentItemId(row: JsonRecord) {
  return text(
    firstPresent(
      row.shipmentItemId,
      row.shipment_item_id,
      row.shipmentLineItemId,
      row.shipment_line_item_id,
      row.lineItemId,
      row.line_item_id,
      row.itemId,
      row.item_id,
    ),
  );
}

function rowQuantity(row: JsonRecord) {
  return positiveInteger(firstPresent(row.quantity, row.qty, row.units, row.qtyPacked, row.qty_packed));
}

function rowSku(row: JsonRecord) {
  return text(firstPresent(row.sku, row.sellerSku, row.seller_sku, row.productSku, row.product_sku));
}

function rowProductName(row: JsonRecord) {
  return text(firstPresent(row.productName, row.product_name, row.name, row.title));
}

export function extractBoxAllocationInputs(body: Record<string, unknown>) {
  for (const key of ALLOCATION_KEYS) {
    const value = body[key];
    if (Array.isArray(value) && value.length) return value.filter(isRecord);
  }

  return [];
}

function normalizeAllocations(rows: JsonRecord[]) {
  const byLineItem = new Map<string, NormalizedAllocation>();

  rows.forEach((row, index) => {
    const shipmentItemId = rowShipmentItemId(row);
    const quantity = rowQuantity(row);
    if (!shipmentItemId) throw new ApiError(`Box allocation row ${index + 1} is missing shipmentItemId`, 400);
    if (!quantity) throw new ApiError(`Box allocation row ${index + 1} must have a positive whole quantity`, 400);

    const existing = byLineItem.get(shipmentItemId);
    if (existing) {
      existing.quantity += quantity;
      if (!existing.sku) existing.sku = rowSku(row);
      if (!existing.productName) existing.productName = rowProductName(row);
    } else {
      byLineItem.set(shipmentItemId, {
        shipmentItemId,
        quantity,
        sku: rowSku(row),
        productName: rowProductName(row),
      });
    }
  });

  return [...byLineItem.values()];
}

function contentRows(contents: Prisma.JsonValue | null | undefined): JsonRecord[] {
  return Array.isArray(contents) ? (contents.filter(isRecord) as JsonRecord[]) : [];
}

function contentShipmentItemId(content: JsonRecord) {
  return text(
    firstPresent(
      content.shipmentItemId,
      content.shipment_item_id,
      content.shipmentLineItemId,
      content.shipment_line_item_id,
      content.lineItemId,
      content.line_item_id,
      content.itemId,
      content.item_id,
    ),
  );
}

function contentQuantity(content: JsonRecord) {
  return Number(firstPresent(content.quantity, content.qty, content.units, content.qtyPacked, content.qty_packed) ?? 0) || 0;
}

function addToMap(map: Map<string, number>, key: string, value: number) {
  map.set(key, (map.get(key) ?? 0) + value);
}

export async function buildValidatedBoxContents(
  prisma: Db,
  input: {
    shipmentId: string;
    subShipmentId?: string | null;
    rows: JsonRecord[];
  },
) {
  const allocations = normalizeAllocations(input.rows);
  if (!allocations.length) return [] as Prisma.InputJsonValue[];

  const shipmentItemIds = allocations.map((allocation) => allocation.shipmentItemId);
  const lineItems = await prisma.shipment_line_items.findMany({
    where: { id: { in: shipmentItemIds }, shipment_id: input.shipmentId },
    select: {
      id: true,
      product_name: true,
      qty_received: true,
      products: { select: { sku: true, product_name: true } },
    },
  });
  const lineItemsById = new Map(lineItems.map((item) => [item.id, item]));
  const missingLineItemId = shipmentItemIds.find((shipmentItemId) => !lineItemsById.has(shipmentItemId));
  if (missingLineItemId) throw new ApiError("Item not found", 404, { shipmentItemId: missingLineItemId });

  const notReceived = lineItems.find((item) => item.qty_received === null);
  if (notReceived) throw new ApiError("Item not yet received", 422, { shipmentItemId: notReceived.id });

  const maxAllocatableById = new Map<string, number>();

  if (input.subShipmentId) {
    const subShipmentItems = await prisma.sub_shipment_items.findMany({
      where: {
        sub_shipment_id: input.subShipmentId,
        shipment_line_item_id: { in: shipmentItemIds },
        sub_shipments: {
          parent_shipment_id: input.shipmentId,
          status: { not: "cancelled" },
        },
      },
      select: { shipment_line_item_id: true, quantity: true },
    });

    for (const item of subShipmentItems) {
      addToMap(maxAllocatableById, item.shipment_line_item_id, item.quantity);
    }

    const missingSubShipmentItem = shipmentItemIds.find((shipmentItemId) => !maxAllocatableById.has(shipmentItemId));
    if (missingSubShipmentItem) {
      throw new ApiError("Item is not part of this sub-shipment", 422, { shipmentItemId: missingSubShipmentItem });
    }
  } else {
    const subShipmentItems = await prisma.sub_shipment_items.findMany({
      where: {
        shipment_line_item_id: { in: shipmentItemIds },
        sub_shipments: {
          parent_shipment_id: input.shipmentId,
          status: { not: "cancelled" },
        },
      },
      select: { shipment_line_item_id: true, quantity: true },
    });
    const assignedToSubShipmentsById = new Map<string, number>();
    for (const item of subShipmentItems) {
      addToMap(assignedToSubShipmentsById, item.shipment_line_item_id, item.quantity);
    }

    for (const item of lineItems) {
      maxAllocatableById.set(item.id, Math.max((item.qty_received ?? 0) - (assignedToSubShipmentsById.get(item.id) ?? 0), 0));
    }
  }

  const boxes = await prisma.outbound_boxes.findMany({
    where: input.subShipmentId
      ? { sub_shipment_id: input.subShipmentId }
      : { shipment_id: input.shipmentId, sub_shipment_id: null },
    select: { contents: true },
  });
  const allocatedById = new Map<string, number>();
  for (const box of boxes) {
    for (const content of contentRows(box.contents)) {
      const shipmentItemId = contentShipmentItemId(content);
      if (!shipmentItemId) continue;
      addToMap(allocatedById, shipmentItemId, contentQuantity(content));
    }
  }

  for (const allocation of allocations) {
    const maxAllocatable = maxAllocatableById.get(allocation.shipmentItemId) ?? 0;
    const allocated = allocatedById.get(allocation.shipmentItemId) ?? 0;
    const remaining = Math.max(maxAllocatable - allocated, 0);
    if (allocation.quantity > remaining) {
      throw new ApiError(
        `Cannot allocate ${allocation.quantity} units. Max allocatable: ${remaining} (received/boxable quantity: ${maxAllocatable})`,
        422,
        { shipmentItemId: allocation.shipmentItemId, requested: allocation.quantity, remaining, maxAllocatable },
      );
    }
  }

  return allocations.map((allocation) => {
    const lineItem = lineItemsById.get(allocation.shipmentItemId);
    const sku = allocation.sku || lineItem?.products.sku || "";
    const productName = allocation.productName || lineItem?.product_name || lineItem?.products.product_name || "";

    return {
      id: randomUUID(),
      shipmentItemId: allocation.shipmentItemId,
      shipment_item_id: allocation.shipmentItemId,
      lineItemId: allocation.shipmentItemId,
      line_item_id: allocation.shipmentItemId,
      sku,
      sellerSku: sku,
      seller_sku: sku,
      productName,
      product_name: productName,
      quantity: allocation.quantity,
      qty: allocation.quantity,
      units: allocation.quantity,
    };
  }) as Prisma.InputJsonValue[];
}
