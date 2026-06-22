import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { serializeTimeEntry, timeEntrySelect } from "@/lib/timeEntries";

export async function GET(req: Request) {
  try {
    const user = await requireRole(req, ["staff"]);
    const active = await prisma.staff_check_ins.findFirst({
      where: { user_id: user.userId, checked_out_at: null },
      select: timeEntrySelect(),
      orderBy: { checked_in_at: "desc" },
    });
    const activeEntry = active ? serializeTimeEntry(active) : null;

    return success({
      isCheckedIn: Boolean(activeEntry),
      is_checked_in: Boolean(activeEntry),
      activeEntry,
      active_entry: activeEntry,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
