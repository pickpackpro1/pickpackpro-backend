import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { validateBoxAllocation } from "@/lib/businessLogic";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const schema = z.object({ shipmentItemId: z.string().uuid(), quantity: z.number().int().positive() });

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
