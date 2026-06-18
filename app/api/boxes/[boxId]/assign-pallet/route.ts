import { z } from "zod";
import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { attachBoxesToPallet, serializeBoxOwnership } from "@/lib/pallets";
import { prisma } from "@/lib/prisma";
import { refreshSubShipmentStatusFromBoxes } from "@/lib/subShipments";
import { json } from "@/lib/validation";

const schema = z.object({ palletId: z.string().uuid() });

export async function PATCH(req: Request, { params }: { params: { boxId: string } }) {
  try {
    await requireRole(req, ["admin", "staff"]);
    const body = await json(req, schema);
    const box = await prisma.$transaction(async (tx) => {
      const pallet = await attachBoxesToPallet(tx, body.palletId, [params.boxId]);
      if (pallet.sub_shipment_id) {
        await refreshSubShipmentStatusFromBoxes(tx, pallet.sub_shipment_id);
      }
      return tx.outbound_boxes.findUniqueOrThrow({
        where: { id: params.boxId },
        include: {
          pallet: true,
          uploaded_files: true,
          sub_shipments: { select: { id: true, reference: true, status: true, sequence_no: true } },
        },
      });
    });
    return success(serializeBoxOwnership(box));
  } catch (err) {
    return handleApiError(err);
  }
}
