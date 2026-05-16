import { z } from "zod";
import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const schema = z.object({ trackingCode: z.string().optional().nullable() });

export async function PATCH(req: Request, { params }: { params: { boxId: string } }) {
  try {
    const user = await requireRole(req, ["admin", "staff"]);
    await json(req, schema);
    const box = await prisma.outbound_boxes.update({
      where: { id: params.boxId },
      data: { dispatched_at: new Date() },
    });
    await prisma.audit_logs.create({
      data: {
        user_id: user.userId,
        user_email: user.email,
        user_role: user.role,
        action: "box.dispatched",
        entity_type: "box",
        entity_id: params.boxId,
        after_value: JSON.parse(JSON.stringify(box)),
      },
    });
    return success(box);
  } catch (err) {
    return handleApiError(err);
  }
}
