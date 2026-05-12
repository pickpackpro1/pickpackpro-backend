import { PricingTier } from "@prisma/client";
import { z } from "zod";
import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const schema = z.object({
  clientId: z.string().uuid().optional(),
  tier: z.nativeEnum(PricingTier).optional(),
  serviceType: z.string().min(1),
  pricePerUnit: z.number().nonnegative(),
  effectiveFrom: z.coerce.date().optional(),
  notes: z.string().optional().nullable(),
});

export async function GET(req: Request) {
  try {
    await requireUser(req);
    const [catalog, clientPrices] = await Promise.all([
      prisma.service_catalog.findMany({ orderBy: { sort_order: "asc" } }),
      prisma.client_price_lists.findMany({ include: { clients: true, service_catalog: true } }),
    ]);
    return success({ catalog, clientPrices });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireRole(req, ["admin"]);
    const body = await json(req, schema);
    if (body.clientId) {
      const price = await prisma.client_price_lists.create({
        data: {
          client_id: body.clientId,
          service_code: body.serviceType,
          tier: body.tier,
          rate: body.pricePerUnit,
          effective_from: body.effectiveFrom ?? new Date(),
          notes: body.notes ?? null,
          created_by: user.userId,
        },
      });
      return success(price, 201);
    }
    const service = await prisma.service_catalog.upsert({
      where: { code: body.serviceType },
      update: { default_tier_pricing: { [body.tier ?? "silver"]: body.pricePerUnit } },
      create: {
        code: body.serviceType,
        display_name: body.serviceType,
        unit_type: "per_unit",
        pricing_type: "tiered",
        default_tier_pricing: { [body.tier ?? "silver"]: body.pricePerUnit },
        vat_applicable: false,
        sort_order: 999,
      },
    });
    return success(service);
  } catch (err) {
    return handleApiError(err);
  }
}
