import { z } from "zod";
import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { serializeTimeEntry, timeEntrySelect } from "@/lib/timeEntries";
import { json } from "@/lib/validation";

const schema = z.object({
  shipmentId: z.string().uuid().optional().nullable(),
  shipment_id: z.string().uuid().optional().nullable(),
  notes: z.string().optional().nullable(),
});

export async function POST(req: Request) {
  try {
    const user = await requireRole(req, ["staff"]);
    const body = await json(req, schema);
    const open = await prisma.staff_check_ins.findFirst({
      where: { user_id: user.userId, checked_out_at: null },
      select: timeEntrySelect(),
      orderBy: { checked_in_at: "desc" },
    });
    if (open) return success(serializeTimeEntry(open));

    const shipmentId = body.shipmentId ?? body.shipment_id ?? null;
    const entry = await prisma.staff_check_ins.create({
      data: { user_id: user.userId, shipment_id: shipmentId, notes: body.notes ?? null },
      select: timeEntrySelect(),
    });
    return success(serializeTimeEntry(entry), 201);
  } catch (err) {
    return handleApiError(err);
  }
}
