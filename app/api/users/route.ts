import { Role } from "@prisma/client";
import { z } from "zod";
import { error, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase";
import { json } from "@/lib/validation";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(6).optional(),
  name: z.string().min(1),
  role: z.nativeEnum(Role),
  clientId: z.string().uuid().optional().nullable(),
});

export async function GET(req: Request) {
  try {
    await requireRole(req, ["admin"]);
    const users = await prisma.users.findMany({ include: { clients: true }, orderBy: { created_at: "desc" } });
    return success(users);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    await requireRole(req, ["admin"]);
    const body = await json(req, schema);
    if (body.role === "client" && !body.clientId) return error("clientId is required for CLIENT users", 400);
    const auth = body.password
      ? await supabaseAdmin.auth.admin.createUser({ email: body.email, password: body.password, email_confirm: true })
      : await supabaseAdmin.auth.admin.inviteUserByEmail(body.email);
    if (auth.error) return error(auth.error.message, 400);
    if (!auth.data.user?.id) return error("Supabase user id was not returned", 400);
    const user = await prisma.users.create({
      data: { id: auth.data.user.id, email: body.email, full_name: body.name, role: body.role, client_id: body.clientId ?? null },
    });
    return success(user, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
