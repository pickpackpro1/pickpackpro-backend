import { Role } from "@prisma/client";
import { z } from "zod";
import { ApiError, error, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const schema = z.object({
  role: z.nativeEnum(Role).optional(),
  name: z.string().min(1).optional(),
  clientCompanyEmail: z.string().email().optional().nullable(),
  active: z.boolean().optional(),
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const actor = await requireRole(req, ["admin"]);
    const body = await json(req, schema);
    if (actor.userId === params.id && body.role && body.role !== actor.role) {
      throw new ApiError("Cannot change own role", 422);
    }
    let resolvedClientId: string | null | undefined = undefined;
    if (body.clientCompanyEmail !== undefined) {
      if (body.clientCompanyEmail === null) {
        resolvedClientId = null;
      } else {
        const client = await prisma.clients.findFirst({
          where: { email: body.clientCompanyEmail },
        });
        if (!client) return error("No client company found with that email", 404);
        resolvedClientId = client.id;
      }
    }
    const user = await prisma.users.update({
      where: { id: params.id },
      data: { role: body.role, full_name: body.name, client_id: resolvedClientId, active: body.active },
    });
    return success(user);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  try {
    await requireRole(req, ["admin"]);
    const user = await prisma.users.update({ where: { id: params.id }, data: { active: false } });
    return success(user);
  } catch (err) {
    return handleApiError(err);
  }
}
