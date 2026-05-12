import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    await requireRole(req, ["admin"]);
    const rows = await prisma.staff_check_ins.groupBy({
      by: ["shipment_id"],
      where: { user_id: params.id },
      _sum: { duration_minutes: true },
    });
    return success({
      staffId: params.id,
      totalHours: rows.reduce((sum, row) => sum + (row._sum.duration_minutes ?? 0), 0) / 60,
      byShipment: rows.map((row) => ({ shipmentId: row.shipment_id, hours: (row._sum.duration_minutes ?? 0) / 60 })),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
