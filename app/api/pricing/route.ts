import { PricingTier, Prisma } from "@prisma/client";
import { z } from "zod";
import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole, requireUser } from "@/lib/auth";
import { normalizeServiceCode } from "@/lib/businessLogic";
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

function jsonObject(value: unknown): Prisma.InputJsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry === null || ["string", "number", "boolean"].includes(typeof entry)),
  ) as Prisma.InputJsonObject;
}

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
    const serviceType = normalizeServiceCode(body.serviceType);
    if (body.clientId) {
      const price = await prisma.client_price_lists.create({
        data: {
          client_id: body.clientId,
          service_code: serviceType,
          tier: body.tier,
          rate: body.pricePerUnit,
          effective_from: body.effectiveFrom ?? new Date(),
          notes: body.notes ?? null,
          created_by: user.userId,
        },
      });
      return success(price, 201);
    }
    const existingService = await prisma.service_catalog.findUnique({
      where: { code: serviceType },
      select: { default_tier_pricing: true },
    });
    const currentPricing = jsonObject(existingService?.default_tier_pricing);
    const nextPricing = body.tier
      ? { ...currentPricing, [body.tier]: body.pricePerUnit }
      : { ...currentPricing, rate: body.pricePerUnit };
    const service = await prisma.service_catalog.upsert({
      where: { code: serviceType },
      update: { default_tier_pricing: nextPricing },
      create: {
        code: serviceType,
        display_name: body.serviceType,
        unit_type: "per_unit",
        pricing_type: body.tier ? "tiered" : "flat",
        default_tier_pricing: nextPricing,
        vat_applicable: false,
        sort_order: 999,
      },
    });
    return success(service);
  } catch (err) {
    return handleApiError(err);
  }
}
