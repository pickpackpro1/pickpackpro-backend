import { handleApiError, success } from "@/lib/apiResponse";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const result = await prisma.notifications.updateMany({
      where: { user_id: user.userId, read_at: null },
      data: { read_at: new Date() },
    });
    return success({ updated: result.count });
  } catch (err) {
    return handleApiError(err);
  }
}
