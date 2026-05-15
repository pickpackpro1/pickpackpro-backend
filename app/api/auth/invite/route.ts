import { Role } from "@prisma/client";
import { z } from "zod";
import { error, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase";
import { json } from "@/lib/validation";

const schema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: z.nativeEnum(Role),
  clientCompanyEmail: z.string().email().optional().nullable(),
});

export async function POST(req: Request) {
  try {
    await requireRole(req, ["admin"]);
    const body = await json(req, schema);
    let resolvedClientId: string | null = null;
    if (body.clientCompanyEmail) {
      const client = await prisma.clients.findFirst({
        where: { email: body.clientCompanyEmail },
      });
      if (!client) return error("No client company found with that email", 404);
      resolvedClientId = client.id;
    }
    if (body.role === "client" && !resolvedClientId) {
      return error("clientCompanyEmail is required for client users", 400);
    }
    const invite = await supabaseAdmin.auth.admin.inviteUserByEmail(body.email, {
      data: { role: body.role, clientId: resolvedClientId, name: body.name },
    });
    if (invite.error) return error(invite.error.message, 400);
    if (!invite.data.user?.id) return error("Supabase user id was not returned", 400);
    const user = await prisma.users.upsert({
      where: { email: body.email },
      update: { full_name: body.name, role: body.role, client_id: resolvedClientId, active: true },
      create: { id: invite.data.user.id, email: body.email, full_name: body.name, role: body.role, client_id: resolvedClientId },
    });
    return success(user, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
