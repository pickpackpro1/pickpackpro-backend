import { Prisma } from "@prisma/client";
import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const billingAddressSchema = z.union([z.string().trim().min(1), z.record(z.unknown())]);

const patchSchema = z.object({
  companyName: z.string().trim().min(1).optional(),
  company_name: z.string().trim().min(1).optional(),
  contactName: z.string().trim().min(1).optional(),
  contact_name: z.string().trim().min(1).optional(),
  email: z.string().trim().email().optional(),
  contactEmail: z.string().trim().email().optional(),
  contact_email: z.string().trim().email().optional(),
  phone: z.string().trim().optional().nullable(),
  contactPhone: z.string().trim().optional().nullable(),
  contact_phone: z.string().trim().optional().nullable(),
  vatNumber: z.string().trim().optional().nullable(),
  vat_number: z.string().trim().optional().nullable(),
  billingAddress: billingAddressSchema.optional(),
  billing_address: billingAddressSchema.optional(),
});

function firstDefined<T>(...values: Array<T | undefined>) {
  return values.find((value) => value !== undefined);
}

function serializeClient(client: {
  id: string;
  company_name: string;
  contact_name: string;
  email: string;
  phone: string | null;
  vat_registered: boolean;
  vat_number: string | null;
  billing_address: Prisma.JsonValue;
  pricing_tier_override: string | null;
  status: string;
  created_at: Date;
}) {
  return {
    ...client,
    companyName: client.company_name,
    company_name: client.company_name,
    contactName: client.contact_name,
    contact_name: client.contact_name,
    vatRegistered: client.vat_registered,
    vat_registered: client.vat_registered,
    vatNumber: client.vat_number,
    vat_number: client.vat_number,
    billingAddress: client.billing_address,
    billing_address: client.billing_address,
    pricingTier: client.pricing_tier_override,
    pricing_tier: client.pricing_tier_override,
    pricingTierOverride: client.pricing_tier_override,
    pricing_tier_override: client.pricing_tier_override,
    createdAt: client.created_at,
    created_at: client.created_at,
  };
}

export async function PATCH(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "client") throw new ApiError("Only client users can update their own profile", 403);
    if (!user.clientId) throw new ApiError("Client user has no client profile", 403);

    const body = await json(req, patchSchema);
    const before = await prisma.clients.findFirst({
      where: { id: user.clientId, soft_deleted_at: null },
      select: {
        id: true,
        company_name: true,
        contact_name: true,
        email: true,
        phone: true,
        vat_registered: true,
        vat_number: true,
        billing_address: true,
        pricing_tier_override: true,
        status: true,
        created_at: true,
      },
    });
    if (!before) throw new ApiError("Client profile not found", 404);

    const requestedEmail = firstDefined(body.email, body.contactEmail, body.contact_email);
    if (requestedEmail && requestedEmail.toLowerCase() !== before.email.toLowerCase()) {
      throw new ApiError("Email changes are not supported from the client profile page", 422);
    }

    const data: Prisma.clientsUpdateInput = {};
    const companyName = firstDefined(body.companyName, body.company_name);
    const contactName = firstDefined(body.contactName, body.contact_name);
    const phone = firstDefined(body.phone, body.contactPhone, body.contact_phone);
    const vatNumber = firstDefined(body.vatNumber, body.vat_number);
    const billingAddress = firstDefined(body.billingAddress, body.billing_address);

    if (companyName !== undefined) data.company_name = companyName;
    if (contactName !== undefined) data.contact_name = contactName;
    if (phone !== undefined) data.phone = phone || null;
    if (vatNumber !== undefined) data.vat_number = vatNumber || null;
    if (billingAddress !== undefined) data.billing_address = billingAddress as Prisma.InputJsonValue;

    const client = await prisma.clients.update({
      where: { id: user.clientId },
      data,
      select: {
        id: true,
        company_name: true,
        contact_name: true,
        email: true,
        phone: true,
        vat_registered: true,
        vat_number: true,
        billing_address: true,
        pricing_tier_override: true,
        status: true,
        created_at: true,
      },
    });

    await prisma.audit_logs.create({
      data: {
        user_id: user.userId,
        user_email: user.email,
        user_role: user.role,
        action: "client.self_update",
        entity_type: "client",
        entity_id: user.clientId,
        before_value: JSON.parse(JSON.stringify(before)),
        after_value: JSON.parse(JSON.stringify(client)),
      },
    });

    return success(serializeClient(client));
  } catch (err) {
    return handleApiError(err);
  }
}
