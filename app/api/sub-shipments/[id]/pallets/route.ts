import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { createPalletWithBoxes, serializePalletResponse } from "@/lib/pallets";
import { prisma } from "@/lib/prisma";
import { refreshSubShipmentStatusFromBoxes } from "@/lib/subShipments";
import { json } from "@/lib/validation";

const schema = z.object({
  boxIds: z.array(z.string().uuid()).optional(),
  childBoxIds: z.array(z.string().uuid()).optional(),
  selectedBoxIds: z.array(z.string().uuid()).optional(),
  palletNumber: z.string().optional().nullable(),
  pallet_number: z.string().optional().nullable(),
  weight: z.coerce.number().nonnegative().optional(),
  dimensions: z
    .object({
      l: z.coerce.number().nonnegative().optional(),
      w: z.coerce.number().nonnegative().optional(),
      h: z.coerce.number().nonnegative().optional(),
    })
    .optional(),
});

function requestedBoxIds(body: z.infer<typeof schema>) {
  return body.boxIds ?? body.childBoxIds ?? body.selectedBoxIds ?? [];
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireRole(req, ["admin", "staff"]);
    const body = await json(req, schema);
    const pallet = await prisma.$transaction(async (tx) => {
      const subShipment = await tx.sub_shipments.findUnique({
        where: { id: params.id },
        select: { id: true, parent_shipment_id: true },
      });
      if (!subShipment) throw new ApiError("Sub-shipment not found", 404);

      const created = await createPalletWithBoxes(tx, {
        shipmentId: subShipment.parent_shipment_id,
        subShipmentId: subShipment.id,
        palletNumber: body.palletNumber ?? body.pallet_number,
        boxIds: requestedBoxIds(body),
        dimensions: body.dimensions,
        weight: body.weight,
      });
      await refreshSubShipmentStatusFromBoxes(tx, subShipment.id);
      await tx.audit_logs.create({
        data: {
          user_id: user.userId,
          user_email: user.email,
          user_role: user.role,
          action: "pallet.created",
          entity_type: "pallet",
          entity_id: created.id,
          after_value: JSON.parse(JSON.stringify(created)),
        },
      });
      return created;
    });

    return success(serializePalletResponse(pallet), 201);
  } catch (err) {
    return handleApiError(err);
  }
}
