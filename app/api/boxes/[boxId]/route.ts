import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { boxWeightOverrideFields, overrideFromBody, resolveBoxWeightFields, weightOverrideAuditData } from "@/lib/boxConstraints";
import { serializeBoxOwnership } from "@/lib/pallets";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const patchSchema = z.object({
  weight: z.coerce.number().nonnegative().optional(),
  weightKg: z.coerce.number().nonnegative().optional(),
  weight_kg: z.coerce.number().nonnegative().optional(),
  lengthCm: z.coerce.number().nonnegative().optional(),
  length_cm: z.coerce.number().nonnegative().optional(),
  widthCm: z.coerce.number().nonnegative().optional(),
  width_cm: z.coerce.number().nonnegative().optional(),
  heightCm: z.coerce.number().nonnegative().optional(),
  height_cm: z.coerce.number().nonnegative().optional(),
  ...boxWeightOverrideFields,
});

// Staff enter or correct a box's weight/dimensions after packing (e.g. when prompted at dispatch).
export async function PATCH(req: Request, { params }: { params: { boxId: string } }) {
  try {
    const user = await requireRole(req, ["admin", "staff"]);
    const body = await json(req, patchSchema);
    const updated = await prisma.$transaction(async (tx) => {
      const before = await tx.outbound_boxes.findUnique({ where: { id: params.boxId } });
      if (!before) throw new ApiError("Box not found", 404);
      if (before.dispatched_at) throw new ApiError("Dispatched boxes cannot be edited", 422);

      const requestedWeight = body.weightKg ?? body.weight_kg ?? body.weight;
      const weightFields =
        requestedWeight === undefined
          ? {}
          : resolveBoxWeightFields({
              weightKg: requestedWeight,
              boxType: before.box_type,
              ...overrideFromBody(body),
              userId: user.userId,
            });

      const box = await tx.outbound_boxes.update({
        where: { id: params.boxId },
        data: {
          ...weightFields,
          length_cm: body.lengthCm ?? body.length_cm,
          width_cm: body.widthCm ?? body.width_cm,
          height_cm: body.heightCm ?? body.height_cm,
        },
      });

      await tx.audit_logs.create({
        data: {
          user_id: user.userId,
          user_email: user.email,
          user_role: user.role,
          action: "box.updated",
          entity_type: "box",
          entity_id: box.id,
          before_value: JSON.parse(JSON.stringify(before)),
          after_value: JSON.parse(JSON.stringify(box)),
        },
      });
      if (box.weight_override && !before.weight_override) {
        await tx.audit_logs.create({ data: weightOverrideAuditData(user, box) });
      }
      return box;
    });
    return success(serializeBoxOwnership(updated));
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(req: Request, { params }: { params: { boxId: string } }) {
  try {
    await requireRole(req, ["admin", "staff"]);
    const box = await prisma.outbound_boxes.findUnique({ where: { id: params.boxId } });
    if (!box) throw new ApiError("Box not found", 404);
    if (box.dispatched_at) throw new ApiError("Cannot delete sealed box", 422);
    if (box.pallet_id) throw new ApiError("Remove the box from its pallet before deleting it", 422);
    await prisma.outbound_boxes.delete({ where: { id: params.boxId } });
    return success({ deleted: true });
  } catch (err) {
    return handleApiError(err);
  }
}
