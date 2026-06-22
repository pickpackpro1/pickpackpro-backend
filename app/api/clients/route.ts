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
  sendInvite: z.boolean().optional(),
  send_invite: z.boolean().optional(),
  inviteUser: z.boolean().optional(),
  invite_user: z.boolean().optional(),
  skipInvite: z.boolean().optional(),
  skip_invite: z.boolean().optional(),
  suppressInvite: z.boolean().optional(),
  suppress_invite: z.boolean().optional(),
  suppressInviteEmail: z.boolean().optional(),
  suppress_invite_email: z.boolean().optional(),
});

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
    const statusParam = url.searchParams.get("status")?.trim().toLowerCase();
    const status =
      statusParam === "all"
        ? undefined
        : statusParam === "active" || statusParam === "suspended"
          ? statusParam
          : url.searchParams.get("isActive") === "false"
            ? undefined
            : "active";
    const tierParam = url.searchParams.get("tier")?.trim().toLowerCase();
    const tier = tierParam && tierParam !== "all" ? (tierParam as PricingTier) : undefined;
    const where: Prisma.clientsWhereInput = {
      status,
      pricing_tier_override: tier,
      soft_deleted_at: null,
      ...(search
        ? {
            OR: [
              { company_name: { contains: search, mode: "insensitive" } },
              { contact_name: { contains: search, mode: "insensitive" } },
              { email: { contains: search, mode: "insensitive" } },
              { phone: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [clients, total] = await Promise.all([
      prisma.clients.findMany({
        where,
        include: {
          _count: { select: { users: true } },
          shipments: { orderBy: { created_at: "desc" }, take: 1, select: { created_at: true } },
        },
        orderBy: { created_at: "desc" },
        ...(hasPagination ? { skip: (page - 1) * limit, take: limit } : {}),
      }),
      hasPagination ? prisma.clients.count({ where }) : Promise.resolve(0),
    ]);

    if (hasPagination) {
      return success({
        clients,
        rows: clients,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      });
    }

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
    const shouldSendInvite =
      !(
        body.skipInvite ||
        body.skip_invite ||
        body.suppressInvite ||
        body.suppress_invite ||
        body.suppressInviteEmail ||
        body.suppress_invite_email ||
        body.sendInvite === false ||
        body.send_invite === false ||
        body.inviteUser === false ||
        body.invite_user === false
      );
    if (!shouldSendInvite) return success(client, 201);

    let inviteError = false;
    try {
      const invite = await supabaseAdmin.auth.admin.inviteUserByEmail(body.contactEmail, {
        redirectTo: `${process.env.FRONTEND_URL}/set-password`,
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
