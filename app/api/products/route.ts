import { Prisma } from "@prisma/client";
import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { withDefaultFnskuLabelFile } from "@/lib/productFnskuLabels";
import { json } from "@/lib/validation";

const productSchema = z
  .object({
    clientId: z.string().uuid().optional(),
    productName: z.string().min(1),
    sku: z.string().min(1),
    defaultFnsku: z.string().optional().nullable(),
    lengthCm: z.coerce.number().nonnegative(),
    widthCm: z.coerce.number().nonnegative(),
    heightCm: z.coerce.number().nonnegative(),
    weightKg: z.coerce.number().nonnegative(),
    hazmatFlag: z.boolean().default(false),
    expiryTracked: z.boolean().default(false),
    lotTracked: z.boolean().default(false),
    needsBundling: z.boolean().default(false),
    bundleSize: z.coerce.number().int().positive().optional().nullable(),
    active: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.needsBundling && !value.bundleSize) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bundleSize"],
        message: "bundleSize is required when needsBundling is true",
      });
    }
  });

export async function GET(req: Request) {
  try {
    const user = await requireRole(req, ["admin", "client"]);
    const url = new URL(req.url);
    const activeParam = url.searchParams.get("active");
    const clientId = user.role === "client" ? user.clientId : url.searchParams.get("clientId");

    if (user.role === "client" && !user.clientId) throw new ApiError("Client user has no clientId", 403);

    const products = await prisma.products.findMany({
      where: {
        client_id: clientId ?? undefined,
        soft_deleted_at: null,
        active: activeParam === null ? true : activeParam === "true",
      },
      select: {
        id: true,
        sku: true,
        product_name: true,
        default_fnsku: true,
        default_fnsku_label_file_id: true,
        length_cm: true,
        width_cm: true,
        height_cm: true,
        weight_kg: true,
        hazmat_flag: true,
        expiry_tracked: true,
        lot_tracked: true,
        needs_bundling: true,
        bundle_size: true,
        active: true,
        created_at: true,
        client_id: true,
        clients: { select: { id: true, company_name: true } },
        uploaded_files_products_default_fnsku_label_file_idTouploaded_files: true,
      },
      orderBy: { created_at: "desc" },
    });

    return success(products.map((product) => withDefaultFnskuLabelFile(product, null)));
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireRole(req, ["admin", "client"]);
    const body = await json(req, productSchema);
    const clientId = user.role === "client" ? user.clientId : body.clientId;
    if (!clientId) throw new ApiError("clientId is required", 400);

    const client = await prisma.clients.findFirst({ where: { id: clientId, soft_deleted_at: null } });
    if (!client) throw new ApiError("Client not found", 404);

    const product = await prisma.products.create({
      data: {
        client_id: clientId,
        product_name: body.productName,
        sku: body.sku,
        default_fnsku: body.defaultFnsku ?? null,
        length_cm: body.lengthCm,
        width_cm: body.widthCm,
        height_cm: body.heightCm,
        weight_kg: body.weightKg,
        hazmat_flag: body.hazmatFlag,
        expiry_tracked: body.expiryTracked,
        lot_tracked: body.lotTracked,
        needs_bundling: body.needsBundling,
        bundle_size: body.needsBundling ? body.bundleSize ?? null : null,
        active: body.active,
      },
      include: {
        clients: true,
        uploaded_files_products_default_fnsku_label_file_idTouploaded_files: true,
      },
    });

    await prisma.audit_logs.create({
      data: {
        user_id: user.userId,
        user_role: user.role,
        user_email: user.email,
        action: "product.create",
        entity_type: "product",
        entity_id: product.id,
        after_value: product as Prisma.InputJsonValue,
      },
    });

    return success(withDefaultFnskuLabelFile(product, null), 201);
  } catch (err) {
    return handleApiError(err);
  }
}
