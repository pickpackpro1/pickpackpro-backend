import { Prisma, Role } from "@prisma/client";
import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

function positiveInt(value: string | null, fallback: number, max?: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return max ? Math.min(parsed, max) : parsed;
}

export async function GET(req: Request) {
  try {
    await requireRole(req, ["admin"]);
    const url = new URL(req.url);
    const hasPagination = url.searchParams.has("page") || url.searchParams.has("limit");
    const page = positiveInt(url.searchParams.get("page"), 1);
    const limit = positiveInt(url.searchParams.get("limit"), 25, 100);
    const search = url.searchParams.get("search")?.trim();
    const roleParam = url.searchParams.get("role")?.trim().toLowerCase();
    const role = roleParam && roleParam !== "all" ? (roleParam as Role) : undefined;
    const status = url.searchParams.get("status")?.trim().toLowerCase();
    const active = status === "active" ? true : status === "inactive" ? false : undefined;
    const where: Prisma.usersWhereInput = {
      role,
      active,
      ...(search
        ? {
            OR: [
              { email: { contains: search, mode: "insensitive" } },
              { full_name: { contains: search, mode: "insensitive" } },
              { clients: { is: { company_name: { contains: search, mode: "insensitive" } } } },
            ],
          }
        : {}),
    };
    const select = {
      id: true,
      email: true,
      full_name: true,
      role: true,
      active: true,
      created_at: true,
      last_login_at: true,
      client_id: true,
      clients: { select: { id: true, company_name: true } },
    } satisfies Prisma.usersSelect;
    const [users, total] = await Promise.all([
      prisma.users.findMany({
        where,
        select,
        orderBy: { created_at: "desc" },
        ...(hasPagination ? { skip: (page - 1) * limit, take: limit } : {}),
      }),
      hasPagination ? prisma.users.count({ where }) : Promise.resolve(0),
    ]);

    if (hasPagination) {
      return success({
        users,
        rows: users,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      });
    }

    return success(users);
  } catch (err) {
    return handleApiError(err);
  }
}
