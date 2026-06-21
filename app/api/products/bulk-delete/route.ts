import { Prisma } from "@prisma/client";
import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const bulkDeleteSchema = z.object({
  productIds: z.array(z.string().uuid()).optional(),
  ids: z.array(z.string().uuid()).optional(),
  clientId: z.string().uuid().optional(),
});

async function bulkDelete(req: Request) {
  try {
    const user = await requireRole(req, ["admin", "client"]);
    const body = await json(req, bulkDeleteSchema);
    const productIds = [...new Set([...(body.productIds ?? []), ...(body.ids ?? [])])];
    if (productIds.length === 0) throw new ApiError("productIds are required", 400);
    if (productIds.length > 500) throw new ApiError("Cannot delete more than 500 products at once", 400);
    if (user.role === "client" && !user.clientId) throw new ApiError("Client user has no clientId", 403);

    const where: Prisma.productsWhereInput = {
      id: { in: productIds },
      soft_deleted_at: null,
      client_id: user.role === "client" ? user.clientId ?? undefined : body.clientId,
    };
    const products = await prisma.products.findMany({ where });
    if (products.length === 0) {
      return success({
        deletedCount: 0,
        deletedIds: [],
        skippedIds: productIds,
      });
    }

    const deletedAt = new Date();
    await prisma.products.updateMany({
      where: { id: { in: products.map((product) => product.id) } },
      data: { soft_deleted_at: deletedAt, active: false },
    });

    await prisma.audit_logs.create({
      data: {
        user_id: user.userId,
        user_role: user.role,
        user_email: user.email,
        action: "product.bulk_soft_delete",
        entity_type: "product",
        entity_id: products[0].id,
        before_value: products as Prisma.InputJsonValue,
        after_value: {
          deleted_at: deletedAt.toISOString(),
          deleted_ids: products.map((product) => product.id),
        },
      },
    });

    const deletedIds = products.map((product) => product.id);
    return success({
      deletedCount: deletedIds.length,
      deletedIds,
      skippedIds: productIds.filter((id) => !deletedIds.includes(id)),
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export const POST = bulkDelete;
export const DELETE = bulkDelete;
