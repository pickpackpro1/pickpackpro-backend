import { z } from "zod";
import { handleApiError, success } from "@/lib/apiResponse";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const patchSchema = z.object({
  ids: z.array(z.string().uuid()).min(1),
});

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const url = new URL(req.url);
    const unreadOnly = url.searchParams.get("unreadOnly") === "true";
    const [notifications, unreadCount] = await Promise.all([
      prisma.notifications.findMany({
        where: { user_id: user.userId, read_at: unreadOnly ? null : undefined },
        orderBy: { created_at: "desc" },
      }),
      prisma.notifications.count({ where: { user_id: user.userId, read_at: null } }),
    ]);
    return success({ notifications, unreadCount });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(req: Request) {
  try {
    const user = await requireUser(req);
    const body = await json(req, patchSchema);
    const result = await prisma.notifications.updateMany({
      where: { user_id: user.userId, id: { in: body.ids } },
      data: { read_at: new Date() },
    });
    return success({ updated: result.count });
  } catch (err) {
    return handleApiError(err);
  }
}
