import { handleApiError, success } from "@/lib/apiResponse";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const url = new URL(req.url);
    const entries = await prisma.staff_check_ins.findMany({
      where: {
        user_id: user.role === "staff" ? user.userId : url.searchParams.get("staffId") ?? undefined,
        shipment_id: url.searchParams.get("shipmentId") ?? undefined,
        checked_in_at: {
          gte: url.searchParams.get("from") ? new Date(url.searchParams.get("from")!) : undefined,
          lte: url.searchParams.get("to") ? new Date(url.searchParams.get("to")!) : undefined,
        },
      },
      include: { users: true, shipments: true },
      orderBy: { checked_in_at: "desc" },
    });
    return success(entries);
  } catch (err) {
    return handleApiError(err);
  }
}
