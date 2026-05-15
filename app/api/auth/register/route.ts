import { Role } from "@prisma/client";
import { z } from "zod";
import { error, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase";
import { json } from "@/lib/validation";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
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

    const auth = await supabaseAdmin.auth.admin.createUser({
      email: body.email,
      password: body.password,
      email_confirm: true,
      user_metadata: { role: body.role, clientId: resolvedClientId, name: body.name },
      app_metadata: { role: body.role, clientId: resolvedClientId },
    });
    if (auth.error) return error(auth.error.message, 400);
    if (!auth.data.user?.id) return error("Supabase user id was not returned", 400);

    const user = await prisma.users.create({
      data: {
        id: auth.data.user.id,
        email: body.email,
        full_name: body.name,
        role: body.role,
        client_id: resolvedClientId,
      },
    });
    return success(user, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
