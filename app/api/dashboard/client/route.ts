import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    const user = await requireRole(req, ["client"]);
    if (!user.clientId) throw new ApiError("Client user has no clientId", 403);
    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const [client, activeShipments, recentShipments, openInvoices, spend, items, outstandingBalance] = await Promise.all([
      prisma.clients.findUnique({ where: { id: user.clientId } }),
      prisma.shipments.count({ where: { client_id: user.clientId, status: { notIn: ["completed", "dispatched"] } } }),
      prisma.shipments.findMany({ where: { client_id: user.clientId }, orderBy: { created_at: "desc" }, take: 5 }),
      prisma.invoices.findMany({ where: { client_id: user.clientId, status: { in: ["draft", "sent", "overdue"] } } }),
      prisma.invoices.aggregate({ where: { client_id: user.clientId, created_at: { gte: yearStart } }, _sum: { total: true } }),
      prisma.shipment_line_items.aggregate({
        where: { shipments: { client_id: user.clientId }, created_at: { gte: monthStart } },
        _sum: { qty_received: true },
      }),
      prisma.invoices.aggregate({
        where: {
          client_id: user.clientId,
          status: { in: ["sent", "overdue"] },
        },
        _sum: { total: true },
      }),
    ]);
    const units = items._sum.qty_received ?? 0;
    const tier = client?.pricing_tier_override ?? "silver";
    const next = tier === "silver" ? 2000 : tier === "gold" ? 5000 : null;
    return success({
      activeShipments,
      totalUnitsThisMonth: units,
      currentTier: tier,
      unitsToNextTier: next ? Math.max(next - units, 0) : 0,
      recentShipments,
      openInvoices,
      totalSpendThisYear: Number(spend._sum.total ?? 0),
      outstandingBalance: Number(outstandingBalance._sum.total ?? 0),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
