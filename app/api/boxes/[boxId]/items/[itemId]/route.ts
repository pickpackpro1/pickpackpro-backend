import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { assertBoxCanBeModified } from "@/lib/pallets";
import { prisma } from "@/lib/prisma";

export async function DELETE(req: Request, { params }: { params: { boxId: string; itemId: string } }) {
  try {
    await requireRole(req, ["admin", "staff"]);
    const box = await assertBoxCanBeModified(prisma, params.boxId);
    const contents = (box.contents as Array<{ id?: string }> | null) ?? [];
    const updated = await prisma.outbound_boxes.update({
      where: { id: params.boxId },
      data: { contents: contents.filter((item, index) => item.id !== params.itemId && String(index) !== params.itemId) },
    });
    return success(updated);
  } catch (err) {
    return handleApiError(err);
  }
}
