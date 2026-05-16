import { PricingTier } from "@prisma/client";
import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireClientAccess, requireRole, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const patchSchema = z.object({
  companyName: z.string().min(1).optional(),
  contactEmail: z.string().email().optional(),
  contactPhone: z.string().optional().nullable(),
  contactName: z.string().optional(),
  pricingTier: z.nativeEnum(PricingTier).optional().nullable(),
  customPricing: z.unknown().optional(),
  status: z.enum(["active", "suspended"]).optional(),
});

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    await requireClientAccess(req, params.id);
    const client = await prisma.clients.findUnique({
      where: { id: params.id },
      include: {
        users: true,
        shipments: { orderBy: { created_at: "desc" }, take: 10 },
        invoices: { orderBy: { created_at: "desc" }, take: 10 },
      },
    });
    if (!client) throw new ApiError("Client not found", 404);
    return success(client);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireRole(req, ["admin"]);
    const body = await json(req, patchSchema);
    const before = await prisma.clients.findUnique({ where: { id: params.id } });
    if (!before) throw new ApiError("Client not found", 404);
    const client = await prisma.clients.update({
      where: { id: params.id },
      data: {
        company_name: body.companyName,
        contact_name: body.contactName,
        email: body.contactEmail,
        phone: body.contactPhone,
        pricing_tier_override: body.pricingTier,
        status: body.status,
      },
    });
    await prisma.audit_logs.create({
      data: {
        user_id: user.userId,
        user_email: user.email,
        user_role: user.role,
        action: "client.updated",
        entity_type: "client",
        entity_id: params.id,
        before_value: JSON.parse(JSON.stringify(before)),
        after_value: JSON.parse(JSON.stringify(client)),
      },
    });
    return success(client);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  try {
    await requireRole(req, ["admin"]);
    const session = await requireUser(req);
    const client = await prisma.clients.update({
      where: { id: params.id },
      data: { soft_deleted_at: new Date(), status: "suspended" },
    });
    await prisma.audit_logs.create({
      data: {
        user_id: session.userId,
        user_email: session.email,
        user_role: session.role,
        action: "client.soft_delete",
        entity_type: "client",
        entity_id: params.id,
        after_value: client,
      },
    });
    return success(client);
  } catch (err) {
    return handleApiError(err);
  }
}
