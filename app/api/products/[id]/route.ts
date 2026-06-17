import { Prisma } from "@prisma/client";
import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { withDefaultFnskuLabelFile } from "@/lib/productFnskuLabels";
import { json } from "@/lib/validation";

const patchSchema = z
  .object({
    productName: z.string().min(1).optional(),
    defaultFnsku: z.string().optional().nullable(),
    lengthCm: z.coerce.number().nonnegative().optional(),
    widthCm: z.coerce.number().nonnegative().optional(),
    heightCm: z.coerce.number().nonnegative().optional(),
    weightKg: z.coerce.number().nonnegative().optional(),
    hazmatFlag: z.boolean().optional(),
    expiryTracked: z.boolean().optional(),
    lotTracked: z.boolean().optional(),
    needsBundling: z.boolean().optional(),
    bundleSize: z.coerce.number().int().positive().optional().nullable(),
    active: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.needsBundling === true && value.bundleSize === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bundleSize"],
        message: "bundleSize is required when needsBundling is true",
      });
    }
  });

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireRole(req, ["admin", "client"]);
    const product = await prisma.products.findFirst({
      where: { id: params.id, soft_deleted_at: null },
      include: {
        clients: true,
        uploaded_files_products_default_fnsku_label_file_idTouploaded_files: true,
      },
    });
    if (!product) throw new ApiError("Product not found", 404);
    if (user.role === "client" && product.client_id !== user.clientId) {
      throw new ApiError("Cannot access another client's product", 403);
    }
    return success(withDefaultFnskuLabelFile(product, null));
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireRole(req, ["admin", "client"]);
    const body = await json(req, patchSchema);
    const before = await prisma.products.findFirst({ where: { id: params.id, soft_deleted_at: null } });
    if (!before) throw new ApiError("Product not found", 404);
    if (user.role === "client" && before.client_id !== user.clientId) {
      throw new ApiError("Cannot edit another client's product", 403);
    }

    const effectiveNeedsBundling = body.needsBundling ?? before.needs_bundling;
    const effectiveBundleSize = body.bundleSize === undefined ? before.bundle_size : body.bundleSize;
    if (effectiveNeedsBundling && !effectiveBundleSize) {
      throw new ApiError("bundleSize is required when needsBundling is true", 422);
    }

    const product = await prisma.products.update({
      where: { id: params.id },
      data: {
        product_name: body.productName,
        default_fnsku: body.defaultFnsku,
        length_cm: body.lengthCm,
        width_cm: body.widthCm,
        height_cm: body.heightCm,
        weight_kg: body.weightKg,
        hazmat_flag: body.hazmatFlag,
        expiry_tracked: body.expiryTracked,
        lot_tracked: body.lotTracked,
        needs_bundling: body.needsBundling,
        bundle_size: body.needsBundling === false ? null : body.bundleSize,
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
        action: "product.update",
        entity_type: "product",
        entity_id: product.id,
        before_value: before as Prisma.InputJsonValue,
        after_value: product as Prisma.InputJsonValue,
      },
    });

    return success(withDefaultFnskuLabelFile(product, null));
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireRole(req, ["admin"]);
    const before = await prisma.products.findFirst({ where: { id: params.id, soft_deleted_at: null } });
    if (!before) throw new ApiError("Product not found", 404);

    const product = await prisma.products.update({
      where: { id: params.id },
      data: { soft_deleted_at: new Date(), active: false },
      include: { clients: true },
    });

    await prisma.audit_logs.create({
      data: {
        user_id: user.userId,
        user_role: user.role,
        user_email: user.email,
        action: "product.soft_delete",
        entity_type: "product",
        entity_id: product.id,
        before_value: before as Prisma.InputJsonValue,
        after_value: product as Prisma.InputJsonValue,
      },
    });

    return success(product);
  } catch (err) {
    return handleApiError(err);
  }
}
