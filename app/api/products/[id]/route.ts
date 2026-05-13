import { Prisma } from "@prisma/client";
import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const patchSchema = z
  .object({
    productName: z.string().min(1).optional(),
    defaultFnsku: z.string().optional().nullable(),
    lengthCm: z.number().nonnegative().optional(),
    widthCm: z.number().nonnegative().optional(),
    heightCm: z.number().nonnegative().optional(),
    weightKg: z.number().nonnegative().optional(),
    hazmatFlag: z.boolean().optional(),
    expiryTracked: z.boolean().optional(),
    lotTracked: z.boolean().optional(),
    needsBundling: z.boolean().optional(),
    bundleSize: z.number().int().positive().optional().nullable(),
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
    const user = await requireUser(req);
    const product = await prisma.products.findFirst({
      where: { id: params.id, soft_deleted_at: null },
      include: { clients: true },
    });
    if (!product) throw new ApiError("Product not found", 404);
    if (user.role === "client" && product.client_id !== user.clientId) {
      throw new ApiError("Cannot access another client's product", 403);
    }
    return success(product);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireRole(req, ["admin"]);
    const body = await json(req, patchSchema);
    const before = await prisma.products.findFirst({ where: { id: params.id, soft_deleted_at: null } });
    if (!before) throw new ApiError("Product not found", 404);

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
        bundle_size: body.bundleSize,
        active: body.active,
      },
      include: { clients: true },
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

    return success(product);
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
