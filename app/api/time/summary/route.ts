import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    await requireRole(req, ["admin"]);
    const url = new URL(req.url);
    const rows = await prisma.staff_check_ins.groupBy({
      by: ["user_id", "shipment_id"],
      where: {
        user_id: url.searchParams.get("staffId") ?? undefined,
        shipment_id: url.searchParams.get("shipmentId") ?? undefined,
        checked_in_at: {
          gte: url.searchParams.get("from") ? new Date(url.searchParams.get("from")!) : undefined,
          lte: url.searchParams.get("to") ? new Date(url.searchParams.get("to")!) : undefined,
        },
      },
      _sum: { duration_minutes: true },
    });
    return success(rows.map((row) => ({ ...row, hours: (row._sum.duration_minutes ?? 0) / 60 })));
  } catch (err) {
    return handleApiError(err);
  }
}
