import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const schema = z.object({ shipmentId: z.string().uuid(), notes: z.string().optional().nullable() });

export async function POST(req: Request) {
  try {
    const user = await requireRole(req, ["staff"]);
    const body = await json(req, schema);
    const open = await prisma.staff_check_ins.findFirst({ where: { user_id: user.userId, checked_out_at: null } });
    if (open) throw new ApiError("Staff user already has an open time entry", 422);
    const entry = await prisma.staff_check_ins.create({
      data: { user_id: user.userId, shipment_id: body.shipmentId, notes: body.notes ?? null },
    });
    return success(entry, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
