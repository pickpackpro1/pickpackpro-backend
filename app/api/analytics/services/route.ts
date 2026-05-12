import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    await requireRole(req, ["admin"]);
    const items = await prisma.shipment_line_items.findMany();
    const stats: Record<string, { total: number; done: number }> = {};
    for (const item of items) {
      const selected = item.services_selected as string[] | null;
      const statuses = item.service_status as Record<string, string> | null;
      for (const service of selected ?? []) {
        stats[service] ??= { total: 0, done: 0 };
        stats[service].total += 1;
        if (statuses?.[service] === "DONE") stats[service].done += 1;
      }
    }
    return success(Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { ...v, completionRate: v.total ? v.done / v.total : 0 }])));
  } catch (err) {
    return handleApiError(err);
  }
}
