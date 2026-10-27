import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { correctionAudit, isFinalShipmentStatus } from "@/lib/adminCorrections";
import { boxWeightOverrideFields, overrideFromBody, resolveBoxWeightFields, weightOverrideAuditData } from "@/lib/boxConstraints";
import { serializeBoxOwnership } from "@/lib/pallets";
import { prisma } from "@/lib/prisma";
import { refreshSubShipmentStatusFromBoxes } from "@/lib/subShipments";
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
      // Staff can't touch a sealed box; an admin can fix a wrong weight/size after the fact (billing
      // is driven by box contents, not dimensions, so this is safe).
      if (before.dispatched_at && user.role !== "admin") throw new ApiError("Dispatched boxes cannot be edited", 422);

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
          action: before.dispatched_at ? "box.corrected_after_dispatch" : "box.updated",
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
    const user = await requireRole(req, ["admin", "staff"]);
    const isAdmin = user.role === "admin";

    await prisma.$transaction(async (tx) => {
      const box = await tx.outbound_boxes.findUnique({
        where: { id: params.boxId },
        include: {
          shipments: { select: { status: true, reference: true } },
          sub_shipments: { select: { status: true, reference: true } },
        },
      });
      if (!box) throw new ApiError("Box not found", 404);

      if (box.dispatched_at) {
        if (!isAdmin) throw new ApiError("Cannot delete sealed box", 422);
        // An invoice is generated once the shipment (or its sub-shipment) is dispatched — don't pull boxes out from under it.
        const subFinal = box.sub_shipments && ["dispatched", "completed"].includes(box.sub_shipments.status);
        if (isFinalShipmentStatus(box.shipments.status) || subFinal) {
          throw new ApiError(
            "This box belongs to a shipment that has already been dispatched and invoiced, so it can't be deleted.",
            422,
            { code: "SHIPMENT_FINAL" },
          );
        }
      }
      if (box.pallet_id && !isAdmin) throw new ApiError("Remove the box from its pallet before deleting it", 422);

      await tx.outbound_boxes.delete({ where: { id: params.boxId } });

      if (box.sub_shipment_id) {
        await refreshSubShipmentStatusFromBoxes(tx, box.sub_shipment_id);
        // refresh leaves an emptied sub-shipment alone, so put it back to the start.
        const remaining = await tx.outbound_boxes.count({ where: { sub_shipment_id: box.sub_shipment_id } });
        if (remaining === 0) {
          await tx.sub_shipments.updateMany({
            where: { id: box.sub_shipment_id, status: { in: ["awaiting_fba_labels", "ready_to_dispatch"] } },
            data: { status: "draft", updated_at: new Date() },
          });
        }
      }

      await tx.audit_logs.create({
        data: correctionAudit(
          user,
          box.dispatched_at ? "box.deleted_after_dispatch" : "box.deleted",
          "box",
          box.id,
          {
            boxNumber: box.manual_box_number ?? box.box_number,
            boxType: box.box_type,
            lengthCm: Number(box.length_cm),
            widthCm: Number(box.width_cm),
            heightCm: Number(box.height_cm),
            weightKg: Number(box.weight_kg),
            contents: box.contents,
            shipmentReference: box.shipments.reference,
            subShipmentReference: box.sub_shipments?.reference ?? null,
            wasDispatched: Boolean(box.dispatched_at),
          },
          null,
        ),
      });
    });

    return success({ deleted: true });
  } catch (err) {
    return handleApiError(err);
  }
}
