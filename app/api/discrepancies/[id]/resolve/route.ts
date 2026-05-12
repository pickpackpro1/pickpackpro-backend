import { z } from "zod";
import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const schema = z.object({ notes: z.string().optional().nullable() });

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    await requireRole(req, ["admin", "staff"]);
    const body = await json(req, schema);
    const item = await prisma.shipment_line_items.update({
      where: { id: params.id },
      data: { qty_discrepancy_flag: false, discrepancy_notes: body.notes ?? null, updated_at: new Date() },
    });
    return success(item);
  } catch (err) {
    return handleApiError(err);
  }
}
