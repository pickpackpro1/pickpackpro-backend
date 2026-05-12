import { z } from "zod";
import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const schema = z.object({ palletId: z.string().uuid() });

export async function PATCH(req: Request, { params }: { params: { boxId: string } }) {
  try {
    await requireRole(req, ["admin", "staff"]);
    const body = await json(req, schema);
    const box = await prisma.outbound_boxes.update({
      where: { id: params.boxId },
      data: { contents: { palletId: body.palletId } },
    });
    return success(box);
  } catch (err) {
    return handleApiError(err);
  }
}
