import { Role } from "@prisma/client";
import { z } from "zod";
import { ApiError, error, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase";
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
    const actor = await requireRole(req, ["admin"]);
    if (actor.userId === params.id) {
      throw new ApiError("Cannot delete your own user account", 422);
    }

    const url = new URL(req.url);
    const permanent =
      url.searchParams.get("permanent") === "true" ||
      url.searchParams.get("hard") === "true";

    if (!permanent) {
      const user = await prisma.users.update({ where: { id: params.id }, data: { active: false } });
      return success(user);
    }

    const user = await prisma.users.findUnique({ where: { id: params.id } });
    if (!user) throw new ApiError("User not found", 404);

    const authUser = await supabaseAdmin.auth.admin.getUserById(user.id);
    const getAuthStatus = (authUser.error as { status?: number } | null)?.status;
    if (authUser.error && getAuthStatus !== 404) {
      throw new ApiError(`Could not verify Supabase Auth user before delete: ${authUser.error.message}`, 500);
    }
    const authUserId = authUser.data.user?.id ?? user.id;

    const deletedAuthUser = await supabaseAdmin.auth.admin.deleteUser(authUserId);
    const deleteAuthStatus = (deletedAuthUser.error as { status?: number } | null)?.status;
    if (deletedAuthUser.error && deleteAuthStatus !== 404) {
      throw new ApiError(`Supabase Auth delete failed: ${deletedAuthUser.error.message}`, 500);
    }

    await prisma.$transaction(async (tx) => {
      await tx.notifications.deleteMany({ where: { user_id: user.id } });
      await tx.audit_logs.deleteMany({ where: { user_id: user.id } });
      await tx.staff_check_ins.deleteMany({ where: { user_id: user.id } });
      await tx.sub_shipments.updateMany({ where: { created_by: user.id }, data: { created_by: null } });
      await tx.sub_shipments.updateMany({ where: { dispatched_by: user.id }, data: { dispatched_by: null } });
      await tx.shipments.updateMany({ where: { assigned_to: user.id }, data: { assigned_to: null } });
      await tx.shipments.updateMany({ where: { submitted_by: user.id }, data: { submitted_by: null } });
      await tx.shipments.updateMany({ where: { received_by: user.id }, data: { received_by: null } });
      await tx.users.delete({ where: { id: user.id } });
    });

    return success({ id: params.id, email: user.email, deleted: true });
  } catch (err) {
    return handleApiError(err);
  }
}
