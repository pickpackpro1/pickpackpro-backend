import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    await requireRole(req, ["admin"]);
    const users = await prisma.users.findMany({ include: { clients: true }, orderBy: { created_at: "desc" } });
    return success(users);
  } catch (err) {
    return handleApiError(err);
  }
}
