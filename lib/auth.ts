import { Role } from "@prisma/client";
import { prisma } from "./prisma";
import { supabaseAdmin } from "./supabase";
import { ApiError } from "./apiResponse";

export type SessionUser = {
  userId: string;
  authUserId: string;
  email: string;
  role: Role;
  clientId: string | null;
};

function bearer(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7);
  const cookie = req.headers.get("cookie") ?? "";
  const tokenCookie = cookie
    .split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith("sb-access-token=") || v.includes("-auth-token"));
  if (!tokenCookie) return null;
  const raw = decodeURIComponent(tokenCookie.split("=").slice(1).join("="));
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed[0] as string;
    if (typeof parsed === "object" && parsed?.access_token) return parsed.access_token as string;
  } catch {
    return raw;
  }
  return raw;
}

export async function getSessionUser(req: Request): Promise<SessionUser | null> {
  const forwardedId = req.headers.get("x-user-id");
  if (forwardedId) {
    const dbUser = await prisma.users.findUnique({ where: { id: forwardedId } });
    if (!dbUser || !dbUser.active) return null;
    return {
      userId: dbUser.id,
      authUserId: forwardedId,
      email: dbUser.email,
      role: dbUser.role,
      clientId: dbUser.client_id,
    };
  }

  const token = bearer(req);
  if (!token) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user?.email) return null;

  const dbUser = await prisma.users.findUnique({ where: { email: data.user.email } });
  if (!dbUser || !dbUser.active) return null;
  return {
    userId: dbUser.id,
    authUserId: data.user.id,
    email: dbUser.email,
    role: dbUser.role,
    clientId: dbUser.client_id,
  };
}

export async function requireUser(req: Request) {
  const user = await getSessionUser(req);
  if (!user) throw new ApiError("Not authenticated", 401);
  return user;
}

export async function requireRole(req: Request, allowedRoles: Role[]) {
  const user = await requireUser(req);
  if (!allowedRoles.includes(user.role)) throw new ApiError("Forbidden", 403);
  return user;
}

export async function requireClientAccess(req: Request, targetClientId: string) {
  const user = await requireUser(req);
  if (user.role === "admin" || user.role === "staff") return user;
  if (user.clientId !== targetClientId) throw new ApiError("Cannot access another client's data", 403);
  return user;
}
