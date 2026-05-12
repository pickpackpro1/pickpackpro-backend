import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(req: Request) {
  try {
    const user = await requireRole(req, ["staff"]);
    const open = await prisma.staff_check_ins.findFirst({ where: { user_id: user.userId, checked_out_at: null } });
    if (!open) throw new ApiError("No open time entry found", 404);
    const checkedOut = new Date();
    const duration = Math.round((checkedOut.getTime() - open.checked_in_at.getTime()) / 60000);
    const entry = await prisma.staff_check_ins.update({
      where: { id: open.id },
      data: { checked_out_at: checkedOut, duration_minutes: duration },
    });
    return success(entry);
  } catch (err) {
    return handleApiError(err);
  }
}
