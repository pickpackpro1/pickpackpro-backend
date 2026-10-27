import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { correctionAudit, isFinalShipmentStatus } from "@/lib/adminCorrections";
import { requireRole } from "@/lib/auth";
import { buildValidatedBoxContents } from "@/lib/boxAllocations";
import { serializeBoxOwnership } from "@/lib/pallets";
import { prisma } from "@/lib/prisma";
import { refreshSubShipmentStatusFromBoxes } from "@/lib/subShipments";
import { json } from "@/lib/validation";

const schema = z.object({
  items: z
    .array(z.object({ shipmentItemId: z.string().uuid(), quantity: z.coerce.number().int().positive().max(1_000_000) }))
    .min(1, "A box needs at least one item. Delete the box instead."),
});

// Admin correction of what is in a box (wrong SKU or wrong unit count). Replaces the box's contents
// using the same limits as creating a box: only received units, never more than is left unpacked.
export async function PUT(req: Request, { params }: { params: { boxId: string } }) {
  try {
    const user = await requireRole(req, ["admin"]);
    const body = await json(req, schema);

    const updated = await prisma.$transaction(async (tx) => {
      const box = await tx.outbound_boxes.findUnique({
        where: { id: params.boxId },
        include: {
          shipments: { select: { status: true, reference: true } },
          sub_shipments: { select: { status: true } },
        },
      });
      if (!box) throw new ApiError("Box not found", 404);
      if (box.box_type === "pallet") throw new ApiError("A pallet holds boxes, not products. Correct the boxes inside it.", 422);
      const subFinal = box.sub_shipments && ["dispatched", "completed"].includes(box.sub_shipments.status);
      if (isFinalShipmentStatus(box.shipments.status) || subFinal) {
        throw new ApiError(
          "This box belongs to a shipment that has already been dispatched and invoiced, so its contents can't be changed.",
          422,
          { code: "SHIPMENT_FINAL" },
        );
      }

      // Take this box's own units out of the count first, so re-entering the same units isn't
      // rejected as "already packed", then validate against what is genuinely left.
      await tx.outbound_boxes.update({ where: { id: box.id }, data: { contents: [] } });
      const contents = await buildValidatedBoxContents(tx, {
        shipmentId: box.shipment_id,
        subShipmentId: box.sub_shipment_id,
        rows: body.items,
      });

      const saved = await tx.outbound_boxes.update({ where: { id: box.id }, data: { contents } });
      if (box.sub_shipment_id) await refreshSubShipmentStatusFromBoxes(tx, box.sub_shipment_id);

      await tx.audit_logs.create({
        data: correctionAudit(
          user,
          box.dispatched_at ? "box.contents_corrected_after_dispatch" : "box.contents_corrected",
          "box",
          box.id,
          { contents: box.contents, shipmentReference: box.shipments.reference },
          { contents: saved.contents, shipmentReference: box.shipments.reference },
        ),
      });
      return saved;
    });

    return success(serializeBoxOwnership(updated));
  } catch (err) {
    return handleApiError(err);
  }
}
