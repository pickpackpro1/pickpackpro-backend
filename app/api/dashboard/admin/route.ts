import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    await requireRole(req, ["admin"]);
    const url = new URL(req.url);
    const arrivalsFilter = url.searchParams.get("arrivalsFilter") ?? "today";
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const arrivalsStart = new Date();
    arrivalsStart.setHours(0, 0, 0, 0);
    const arrivalsEnd = new Date(arrivalsStart);
    if (arrivalsFilter === "tomorrow") {
      arrivalsStart.setDate(arrivalsStart.getDate() + 1);
      arrivalsEnd.setDate(arrivalsStart.getDate());
    } else if (arrivalsFilter === "this_week") {
      const day = arrivalsStart.getDay();
      const mondayOffset = day === 0 ? -6 : 1 - day;
      arrivalsStart.setDate(arrivalsStart.getDate() + mondayOffset);
      arrivalsEnd.setTime(arrivalsStart.getTime());
      arrivalsEnd.setDate(arrivalsStart.getDate() + 6);
    }
    arrivalsEnd.setHours(23, 59, 59, 999);

    const [
      totalClients,
      activeShipments,
      byStatus,
      revenue,
      topClients,
      staff,
      arrivingShipments,
      outstandingClientShipments,
      unitsReceivedThisWeek,
      shipmentsPreppedhisWeek,
      shipmentsDispatchedThisWeek,
      discrepanciesFlaggedToday,
    ] = await Promise.all([
      prisma.clients.count({ where: { status: "active", soft_deleted_at: null } }),
      prisma.shipments.count({ where: { status: { notIn: ["completed", "dispatched"] }, soft_deleted_at: null } }),
      prisma.shipments.groupBy({ by: ["status"], _count: true }),
      prisma.invoices.aggregate({ where: { created_at: { gte: monthStart } }, _sum: { total: true } }),
      prisma.invoices.groupBy({ by: ["client_id"], _sum: { total: true }, orderBy: { _sum: { total: "desc" } }, take: 5 }),
      prisma.staff_check_ins.groupBy({ by: ["user_id"], where: { checked_in_at: { gte: monthStart } }, _sum: { duration_minutes: true } }),
      prisma.shipments.findMany({
        where: {
          status: { in: ["submitted", "pending_arrival"] },
          expected_arrival_date: { gte: arrivalsStart, lte: arrivalsEnd },
          soft_deleted_at: null,
        },
        include: { clients: true, shipment_line_items: { include: { products: true } } },
        orderBy: { expected_arrival_date: "asc" },
      }),
      prisma.shipments.count({
        where: { status: { in: ["received", "in_progress"] }, soft_deleted_at: null },
      }),
      prisma.shipment_line_items.aggregate({
        where: { shipments: { actual_arrival_date: { gte: weekStart } } },
        _sum: { qty_received: true },
      }),
      prisma.shipments.count({
        where: { status: "prepped", updated_at: { gte: weekStart } },
      }),
      prisma.shipments.count({
        where: { status: "dispatched", dispatched_date: { gte: weekStart } },
      }),
      prisma.shipment_line_items.count({
        where: {
          qty_discrepancy_flag: true,
          updated_at: { gte: todayStart },
        },
      }),
    ]);
    const staffUserIds = staff.map((row) => row.user_id);
    const staffUsers = await prisma.users.findMany({
      where: { id: { in: staffUserIds } },
      select: { id: true, full_name: true, email: true },
    });
    const staffNameMap = new Map(
      staffUsers.map((user) => [user.id, user.full_name || user.email])
    );
    return success({
      totalClients,
      activeShipments,
      outstandingClientShipments,
      arrivingShipments,
      unitsReceivedThisWeek,
      shipmentsPreppedhisWeek,
      shipmentsDispatchedThisWeek,
      discrepanciesFlaggedToday,
      shipmentsByStatus: Object.fromEntries(byStatus.map((row) => [row.status, row._count])),
      revenueThisMonth: Number(revenue._sum.total ?? 0),
      topClients,
      staffActivity: staff.map((row) => ({
        staffId: row.user_id,
        name: staffNameMap.get(row.user_id) ?? `Staff ${row.user_id.slice(0, 8)}`,
        hoursThisMonth: (row._sum.duration_minutes ?? 0) / 60,
      })),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
