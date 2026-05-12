import { z } from "zod";
import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const schema = z.object({ trackingCode: z.string().optional().nullable() });

export async function PATCH(req: Request, { params }: { params: { boxId: string } }) {
  try {
    await requireRole(req, ["admin", "staff"]);
    await json(req, schema);
    const box = await prisma.outbound_boxes.update({
      where: { id: params.boxId },
      data: { dispatched_at: new Date() },
    });
    return success(box);
  } catch (err) {
    return handleApiError(err);
  }
}
