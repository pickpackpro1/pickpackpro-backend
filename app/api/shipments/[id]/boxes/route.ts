import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireClientAccess, requireRole, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const schema = z.object({
  weight: z.number().nonnegative().optional(),
  dimensions: z.object({ l: z.number().nonnegative(), w: z.number().nonnegative(), h: z.number().nonnegative() }).optional(),
  boxType: z.enum(["box", "pallet"]).default("box"),
  boxSize: z.enum(["small", "medium", "large", "oversize"]).optional(),
});

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser(req);
    const shipment = await prisma.shipments.findUnique({
      where: { id: params.id },
      include: { outbound_boxes: true, shipment_line_items: { include: { products: true } } },
    });
    if (!shipment) throw new ApiError("Shipment not found", 404);
    if (user.role === "client") await requireClientAccess(req, shipment.client_id);
    const allocationSummary = shipment.shipment_line_items.map((item) => {
      const allocated = shipment.outbound_boxes.reduce((sum, box) => {
        const contents = box.contents as Array<{ shipmentItemId?: string; quantity?: number }> | null;
        return sum + (contents ?? []).filter((c) => c.shipmentItemId === item.id).reduce((inner, c) => inner + (c.quantity ?? 0), 0);
      }, 0);
      return { shipmentItemId: item.id, sku: item.products.sku, dispatchQty: item.dispatch_qty, allocated };
    });
    return success({ boxes: shipment.outbound_boxes, allocationSummary });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    await requireRole(req, ["admin", "staff"]);
    const body = await json(req, schema);
    const count = await prisma.outbound_boxes.count({ where: { shipment_id: params.id } });
    const box = await prisma.outbound_boxes.create({
      data: {
        shipment_id: params.id,
        box_number: count + 1,
        box_type: body.boxType,
        box_size: body.boxSize,
        length_cm: body.dimensions?.l ?? 0,
        width_cm: body.dimensions?.w ?? 0,
        height_cm: body.dimensions?.h ?? 0,
        weight_kg: body.weight ?? 0,
        contents: [],
      },
    });
    return success(box, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
