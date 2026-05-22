import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    await requireRole(req, ["admin"]);
    const users = await prisma.users.findMany({
      select: {
        id: true,
        email: true,
        full_name: true,
        role: true,
        active: true,
        created_at: true,
        last_login_at: true,
        client_id: true,
        clients: { select: { id: true, company_name: true } },
      },
      orderBy: { created_at: "desc" },
    });
    return success(users);
  } catch (err) {
    return handleApiError(err);
  }
}
