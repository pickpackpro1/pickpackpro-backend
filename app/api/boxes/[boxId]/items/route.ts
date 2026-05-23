import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireClientAccess, requireRole, requireUser } from "@/lib/auth";
import { validateBoxAllocation } from "@/lib/businessLogic";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const schema = z.object({ shipmentItemId: z.string().uuid(), quantity: z.number().int().positive() });

function isContentRow(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function quantityValue(value: unknown) {
  return typeof value === "number" ? value : Number(value ?? 0);
}

export async function GET(req: Request, { params }: { params: { boxId: string } }) {
  try {
    const user = await requireUser(req);
    const box = await prisma.outbound_boxes.findUnique({
      where: { id: params.boxId },
      include: { shipments: { select: { client_id: true } } },
    });
    if (!box) throw new ApiError("Box not found", 404);
    if (user.role === "client") await requireClientAccess(req, box.shipments.client_id);

    const contents = (Array.isArray(box.contents) ? box.contents.filter(isContentRow) : []) as Record<
      string,
      unknown
    >[];
    const shipmentItemIds = Array.from(
      new Set(
        contents
          .map((item) => stringValue(item.shipmentItemId) ?? stringValue(item.shipment_item_id))
          .filter((id): id is string => Boolean(id)),
      ),
    );
    const shipmentItems = shipmentItemIds.length
      ? await prisma.shipment_line_items.findMany({
          where: { id: { in: shipmentItemIds }, shipment_id: box.shipment_id },
          include: { products: { select: { sku: true } } },
        })
      : [];
    const skuByShipmentItemId = new Map(shipmentItems.map((item) => [item.id, item.products.sku]));

    const items = contents.map((item, index) => {
      const shipmentItemId = stringValue(item.shipmentItemId) ?? stringValue(item.shipment_item_id);
      return {
        id: stringValue(item.id) ?? String(index),
        shipmentItemId,
        shipment_item_id: shipmentItemId,
        sku: (shipmentItemId ? skuByShipmentItemId.get(shipmentItemId) : null) ?? stringValue(item.sku),
        quantity: quantityValue(item.quantity),
      };
    });

    return success(items);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request, { params }: { params: { boxId: string } }) {
  try {
    await requireRole(req, ["admin", "staff"]);
    const body = await json(req, schema);
    const updated = await prisma.$transaction(async (tx) => {
      const box = await tx.outbound_boxes.findUnique({ where: { id: params.boxId } });
      if (!box) throw new ApiError("Box not found", 404);
      if (box.dispatched_at) throw new ApiError("Sealed boxes cannot be modified", 422);
      const validation = await validateBoxAllocation(tx, body.shipmentItemId, params.boxId, body.quantity);
      if (!validation.valid) throw new ApiError(validation.error ?? "Invalid allocation", 422);
      const item = await tx.shipment_line_items.findUnique({ where: { id: body.shipmentItemId }, include: { products: true } });
      const contents = (box.contents as unknown[] | null) ?? [];
      return tx.outbound_boxes.update({
        where: { id: params.boxId },
        data: {
          contents: [
            ...(contents as Prisma.InputJsonValue[]),
            {
              id: randomUUID(),
              shipmentItemId: body.shipmentItemId,
              sku: item?.products.sku,
              quantity: body.quantity,
            },
          ] as Prisma.InputJsonValue,
        },
      });
    });
    return success(updated, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
