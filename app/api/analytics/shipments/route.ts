import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    await requireRole(req, ["admin"]);
    const url = new URL(req.url);
    const groupBy = url.searchParams.get("groupBy") ?? "month";
    const shipments = await prisma.shipments.findMany({
      where: {
        created_at: {
          gte: url.searchParams.get("from") ? new Date(url.searchParams.get("from")!) : undefined,
          lte: url.searchParams.get("to") ? new Date(url.searchParams.get("to")!) : undefined,
        },
      },
      select: { id: true, client_id: true, created_at: true, status: true },
    });
    const grouped = shipments.reduce<Record<string, number>>((acc, shipment) => {
      const key =
        groupBy === "client"
          ? shipment.client_id
          : groupBy === "week"
            ? `${shipment.created_at.getFullYear()}-W${Math.ceil(shipment.created_at.getDate() / 7)}`
            : shipment.created_at.toISOString().slice(0, 7);
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    return success(grouped);
  } catch (err) {
    return handleApiError(err);
  }
}
