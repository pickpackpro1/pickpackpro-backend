import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { serializeTimeEntry, timeEntrySelect } from "@/lib/timeEntries";

function positiveInt(value: string | null, fallback: number, max?: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return max ? Math.min(parsed, max) : parsed;
}

export async function GET(req: Request) {
  try {
    const user = await requireRole(req, ["admin", "staff"]);
    const url = new URL(req.url);
    const limit = positiveInt(url.searchParams.get("limit"), 25, 100);
    const staffId = user.role === "staff" ? user.userId : url.searchParams.get("staffId") ?? undefined;
    const entries = await prisma.staff_check_ins.findMany({
      where: {
        user_id: staffId,
        shipment_id: url.searchParams.get("shipmentId") ?? undefined,
        checked_in_at: {
          gte: url.searchParams.get("from") ? new Date(url.searchParams.get("from")!) : undefined,
          lte: url.searchParams.get("to") ? new Date(url.searchParams.get("to")!) : undefined,
        },
      },
      select: timeEntrySelect(),
      orderBy: { checked_in_at: "desc" },
      take: limit,
    });
    const now = new Date();
    const normalizedEntries = entries.map((entry) => serializeTimeEntry(entry, now));
    const activeEntry = normalizedEntries.find((entry) => entry.status === "active") ?? null;

    return success({
      entries: normalizedEntries,
      rows: normalizedEntries,
      activeEntry,
      active_entry: activeEntry,
      isCheckedIn: Boolean(activeEntry),
      is_checked_in: Boolean(activeEntry),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
