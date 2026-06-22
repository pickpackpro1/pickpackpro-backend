import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    await requireRole(req, ["admin"]);
    const url = new URL(req.url);
    const userId = url.searchParams.get("userId") ?? undefined;
    const entityType = url.searchParams.get("entityType") ?? undefined;
    const entityId = url.searchParams.get("entityId") ?? undefined;
    const action = url.searchParams.get("action") ?? undefined;
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const page = Math.max(Number(url.searchParams.get("page") ?? 1), 1);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 100);
    const timestamp = from || to ? {
      gte: from ? new Date(from) : undefined,
      lte: to ? new Date(to) : undefined,
    } : undefined;

    const where = {
      user_id: userId,
      entity_type: entityType,
      entity_id: entityId,
      action,
      timestamp,
    };

    const [logs, total] = await Promise.all([
      prisma.audit_logs.findMany({
        where,
        orderBy: { timestamp: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.audit_logs.count({ where }),
    ]);

    return success({ logs, rows: logs, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    return handleApiError(err);
  }
}
