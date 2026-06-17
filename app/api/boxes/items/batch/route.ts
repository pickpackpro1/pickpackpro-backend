import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireClientAccess, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const MAX_BOX_LOOKUPS = 250;

const batchBoxItemsSchema = z.object({
  boxIds: z.array(z.string().uuid()).max(MAX_BOX_LOOKUPS).default([]),
});

function isContentRow(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function quantityValue(value: unknown) {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function uniqueValues(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function parseGetRequest(req: Request) {
  const url = new URL(req.url);
  const boxIds = uniqueValues([
    ...url.searchParams.getAll("boxId"),
    ...url.searchParams.getAll("boxIds").flatMap((value) => value.split(",")),
  ]);

  return batchBoxItemsSchema.parse({ boxIds });
}

function getBoxContents(contents: unknown) {
  return (Array.isArray(contents) ? contents.filter(isContentRow) : []) as Record<string, unknown>[];
}

async function getBatchBoxItems(req: Request, input: z.infer<typeof batchBoxItemsSchema>) {
  const user = await requireUser(req);
  if (user.role === "client" && !user.clientId) {
    throw new ApiError("Client user has no clientId", 403);
  }

  const boxIds = uniqueValues(input.boxIds);
  if (!boxIds.length) {
    return success({
      boxes: [],
      itemsByBoxId: {},
      totalBoxes: 0,
      totalItems: 0,
    });
  }

  const boxes = await prisma.outbound_boxes.findMany({
    where: { id: { in: boxIds } },
    select: {
      id: true,
      shipment_id: true,
      contents: true,
      shipments: { select: { client_id: true } },
    },
  });

  if (boxes.length !== boxIds.length) {
    throw new ApiError("One or more boxes were not found", 404);
  }

  if (user.role === "client") {
    const unauthorizedBox = boxes.find((box) => box.shipments.client_id !== user.clientId);
    if (unauthorizedBox) {
      await requireClientAccess(req, unauthorizedBox.shipments.client_id);
    }
  }

  const shipmentItemIds = uniqueValues(
    boxes.flatMap((box) =>
      getBoxContents(box.contents)
        .map((item) => stringValue(item.shipmentItemId) ?? stringValue(item.shipment_item_id))
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const shipmentIds = uniqueValues(boxes.map((box) => box.shipment_id));

  const shipmentItems = shipmentItemIds.length
    ? await prisma.shipment_line_items.findMany({
        where: {
          id: { in: shipmentItemIds },
          shipment_id: { in: shipmentIds },
        },
        select: {
          id: true,
          shipment_id: true,
          products: { select: { sku: true } },
        },
      })
    : [];
  const shipmentItemsById = new Map(shipmentItems.map((item) => [item.id, item]));
  const requestedBoxOrder = new Map(boxIds.map((boxId, index) => [boxId, index]));

  const boxRows = boxes
    .sort((left, right) => (requestedBoxOrder.get(left.id) ?? 0) - (requestedBoxOrder.get(right.id) ?? 0))
    .map((box) => {
      const items = getBoxContents(box.contents).map((item, index) => {
        const shipmentItemId = stringValue(item.shipmentItemId) ?? stringValue(item.shipment_item_id);
        const shipmentItem = shipmentItemId ? shipmentItemsById.get(shipmentItemId) : null;
        const sku = shipmentItem?.shipment_id === box.shipment_id ? shipmentItem.products.sku : stringValue(item.sku);

        return {
          id: stringValue(item.id) ?? String(index),
          shipmentItemId,
          shipment_item_id: shipmentItemId,
          sku,
          quantity: quantityValue(item.quantity),
        };
      });

      return {
        boxId: box.id,
        box_id: box.id,
        shipmentId: box.shipment_id,
        shipment_id: box.shipment_id,
        items,
      };
    });

  const itemsByBoxId = Object.fromEntries(boxRows.map((box) => [box.boxId, box.items]));

  return success({
    boxes: boxRows,
    itemsByBoxId,
    totalBoxes: boxRows.length,
    totalItems: boxRows.reduce((sum, box) => sum + box.items.length, 0),
  });
}

export async function GET(req: Request) {
  try {
    return await getBatchBoxItems(req, parseGetRequest(req));
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    return await getBatchBoxItems(req, await json(req, batchBoxItemsSchema));
  } catch (err) {
    return handleApiError(err);
  }
}
