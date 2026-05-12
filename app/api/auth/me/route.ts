import { handleApiError, success } from "@/lib/apiResponse";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    const session = await requireUser(req);
    const user = await prisma.users.findUnique({
      where: { id: session.userId },
      include: { clients: true },
    });
    return success(user);
  } catch (err) {
    return handleApiError(err);
  }
}
