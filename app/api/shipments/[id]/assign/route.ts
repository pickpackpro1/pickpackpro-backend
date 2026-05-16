import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const schema = z.object({ staffId: z.string().uuid() });

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireRole(req, ["admin"]);
    const body = await json(req, schema);
    const staff = await prisma.users.findUnique({ where: { id: body.staffId } });
    if (!staff || staff.role !== "staff") throw new ApiError("Staff user not found", 404);
    const shipment = await prisma.shipments.update({
      where: { id: params.id },
      data: { assigned_to: body.staffId, updated_at: new Date() },
    });
    await prisma.audit_logs.create({
      data: {
        user_id: user.userId,
        user_email: user.email,
        user_role: user.role,
        action: "shipment.assigned",
        entity_type: "shipment",
        entity_id: params.id,
        after_value: JSON.parse(JSON.stringify(shipment)),
      },
    });
    return success(shipment);
  } catch (err) {
    return handleApiError(err);
  }
}
