import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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
