import { PricingTier } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase";
import { json } from "@/lib/validation";

const createSchema = z.object({
  companyName: z.string().min(1),
  contactEmail: z.string().email(),
  contactPhone: z.string().optional().nullable(),
  contactName: z.string().optional(),
  pricingTier: z.nativeEnum(PricingTier).optional(),
  billingAddress: z.record(z.unknown()).default({}),
  shippingAddress: z.record(z.unknown()).optional().nullable(),
  vatRegistered: z.boolean().default(false),
  vatNumber: z.string().optional().nullable(),
});

export async function GET(req: Request) {
  try {
    await requireRole(req, ["admin"]);
    const url = new URL(req.url);
    const status = url.searchParams.get("isActive") === "false" ? undefined : "active";
    const tier = url.searchParams.get("tier")?.toLowerCase() as PricingTier | undefined;
    const clients = await prisma.clients.findMany({
      where: {
        status,
        pricing_tier_override: tier,
        soft_deleted_at: null,
      },
      include: {
        _count: { select: { users: true } },
        shipments: { orderBy: { created_at: "desc" }, take: 1, select: { created_at: true } },
      },
      orderBy: { created_at: "desc" },
    });
    return success(clients);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireRole(req, ["admin"]);
    const body = await json(req, createSchema);
    const client = await prisma.clients.create({
      data: {
        company_name: body.companyName,
        contact_name: body.contactName ?? body.companyName,
        email: body.contactEmail,
        phone: body.contactPhone ?? null,
        billing_address: body.billingAddress as Prisma.InputJsonValue,
        shipping_address: body.shippingAddress as Prisma.InputJsonValue | undefined,
        vat_registered: body.vatRegistered,
        vat_number: body.vatNumber ?? null,
        pricing_tier_override: body.pricingTier ?? undefined,
        created_by: user.userId,
      },
    });
    await prisma.audit_logs.create({
      data: {
        user_id: user.userId,
        user_email: user.email,
        user_role: user.role,
        action: "client.created",
        entity_type: "client",
        entity_id: client.id,
        after_value: JSON.parse(JSON.stringify(client)),
      },
    });
    let inviteError = false;
    try {
      const invite = await supabaseAdmin.auth.admin.inviteUserByEmail(body.contactEmail, {
        data: { role: "client", clientId: client.id, name: body.contactName ?? body.companyName },
      });
      if (invite.error || !invite.data.user?.id) {
        inviteError = true;
        console.error(invite.error ?? new Error("Supabase user id was not returned"));
      } else {
        await prisma.users.upsert({
          where: { email: body.contactEmail },
          update: {
            full_name: body.contactName ?? body.companyName,
            role: "client",
            client_id: client.id,
            active: true,
          },
          create: {
            id: invite.data.user.id,
            email: body.contactEmail,
            full_name: body.contactName ?? body.companyName,
            role: "client",
            client_id: client.id,
          },
        });
      }
    } catch (err) {
      inviteError = true;
      console.error(err);
    }
    return success(inviteError ? { ...client, inviteError: true } : client, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
