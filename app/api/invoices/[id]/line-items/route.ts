import { z } from "zod";
import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { addManualInvoiceLine } from "@/lib/invoicing";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const schema = z.object({
  description: z.string().trim().min(1),
  serviceCode: z.string().trim().optional().nullable(),
  qty: z.coerce.number().positive(),
  unitRate: z.coerce.number().nonnegative(),
  vatRate: z.coerce.number().min(0).max(1).optional().nullable(),
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireRole(req, ["admin"]);
    const body = await json(req, schema);
    const invoice = await addManualInvoiceLine(prisma, params.id, body);
    await prisma.audit_logs.create({
      data: {
        user_id: user.userId,
        user_email: user.email,
        user_role: user.role,
        action: "invoice.manual_line_added",
        entity_type: "invoice",
        entity_id: params.id,
        after_value: body,
      },
    });
    return success(invoice);
  } catch (err) {
    return handleApiError(err);
  }
}
