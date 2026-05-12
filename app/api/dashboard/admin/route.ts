import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    await requireRole(req, ["admin"]);
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const [totalClients, activeShipments, byStatus, revenue, topClients, staff] = await Promise.all([
      prisma.clients.count({ where: { status: "active", soft_deleted_at: null } }),
      prisma.shipments.count({ where: { status: { notIn: ["completed", "dispatched"] }, soft_deleted_at: null } }),
      prisma.shipments.groupBy({ by: ["status"], _count: true }),
      prisma.invoices.aggregate({ where: { created_at: { gte: monthStart } }, _sum: { total: true } }),
      prisma.invoices.groupBy({ by: ["client_id"], _sum: { total: true }, orderBy: { _sum: { total: "desc" } }, take: 5 }),
      prisma.staff_check_ins.groupBy({ by: ["user_id"], where: { checked_in_at: { gte: monthStart } }, _sum: { duration_minutes: true } }),
    ]);
    return success({
      totalClients,
      activeShipments,
      shipmentsByStatus: Object.fromEntries(byStatus.map((row) => [row.status, row._count])),
      revenueThisMonth: Number(revenue._sum.total ?? 0),
      topClients,
      staffActivity: staff.map((row) => ({ staffId: row.user_id, hoursThisMonth: (row._sum.duration_minutes ?? 0) / 60 })),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
