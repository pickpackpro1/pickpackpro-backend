import { z } from "zod";
import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { deleteManualInvoiceLine, updateManualInvoiceLine } from "@/lib/invoicing";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const patchSchema = z
  .object({
    description: z.string().trim().min(1).optional(),
    serviceCode: z.string().trim().optional().nullable(),
    qty: z.coerce.number().positive().optional(),
    unitRate: z.coerce.number().nonnegative().optional(),
    vatRate: z.coerce.number().min(0).max(1).optional().nullable(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: "At least one field is required",
  });

export async function PATCH(req: Request, { params }: { params: { id: string; lineItemId: string } }) {
  try {
    const user = await requireRole(req, ["admin"]);
    const body = await json(req, patchSchema);
    const invoice = await updateManualInvoiceLine(prisma, params.id, params.lineItemId, body);
    await prisma.audit_logs.create({
      data: {
        user_id: user.userId,
        user_email: user.email,
        user_role: user.role,
        action: "invoice.manual_line_updated",
        entity_type: "invoice",
        entity_id: params.id,
        after_value: { lineItemId: params.lineItemId, ...body },
      },
    });
    return success(invoice);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string; lineItemId: string } }) {
  try {
    const user = await requireRole(req, ["admin"]);
    const invoice = await deleteManualInvoiceLine(prisma, params.id, params.lineItemId);
    await prisma.audit_logs.create({
      data: {
        user_id: user.userId,
        user_email: user.email,
        user_role: user.role,
        action: "invoice.manual_line_deleted",
        entity_type: "invoice",
        entity_id: params.id,
        after_value: { lineItemId: params.lineItemId },
      },
    });
    return success(invoice);
  } catch (err) {
    return handleApiError(err);
  }
}
