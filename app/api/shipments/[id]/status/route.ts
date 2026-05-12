import { ShipmentStatus } from "@prisma/client";
import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { assertTransition } from "@/lib/businessLogic";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const schema = z.object({ status: z.nativeEnum(ShipmentStatus) });

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    await requireRole(req, ["admin", "staff"]);
    const body = await json(req, schema);
    const shipment = await prisma.shipments.findUnique({
      where: { id: params.id },
      include: { shipment_line_items: true },
    });
    if (!shipment) throw new ApiError("Shipment not found", 404);
    await assertTransition(prisma, shipment, body.status);
    const updated = await prisma.shipments.update({
      where: { id: params.id },
      data: {
        status: body.status,
        updated_at: new Date(),
        dispatched_date: body.status === "dispatched" ? new Date() : undefined,
        completed_date: body.status === "completed" ? new Date() : undefined,
      },
    });
    return success(updated);
  } catch (err) {
    return handleApiError(err);
  }
}
