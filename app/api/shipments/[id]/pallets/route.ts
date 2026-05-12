import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    await requireRole(req, ["admin", "staff"]);
    const count = await prisma.outbound_boxes.count({ where: { shipment_id: params.id, box_type: "pallet" } });
    const pallet = await prisma.outbound_boxes.create({
      data: {
        shipment_id: params.id,
        box_number: count + 1,
        box_type: "pallet",
        length_cm: 0,
        width_cm: 0,
        height_cm: 0,
        weight_kg: 0,
        contents: [],
      },
    });
    return success(pallet, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
