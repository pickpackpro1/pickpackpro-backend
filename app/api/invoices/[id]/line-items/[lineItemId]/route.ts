import { z } from "zod";
import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { deleteInvoiceLine, updateInvoiceLine } from "@/lib/invoicing";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const patchSchema = z
  .object({
    description: z.string().trim().min(1).optional(),
    serviceCode: z.string().trim().optional().nullable(),
    qty: z.coerce.number().positive().optional(),
    unitRate: z.coerce.number().nonnegative().optional(),
    vatRate: z.coerce.number().min(0).max(1).optional().nullable(),
    reason: z.string().trim().optional().nullable(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: "At least one field is required",
  });

export async function PATCH(req: Request, { params }: { params: { id: string; lineItemId: string } }) {
  try {
    const user = await requireRole(req, ["admin"]);
    const body = await json(req, patchSchema);
    const beforeLine = await prisma.invoice_line_items.findUnique({ where: { id: params.lineItemId } });
    const invoice = await updateInvoiceLine(prisma, params.id, params.lineItemId, {
      ...body,
      updatedBy: user.userId,
    });
    const afterLine = invoice.invoice_line_items.find((line) => line.id === params.lineItemId) ?? null;
    const isSystemLine = beforeLine?.line_source === "system";
    await prisma.audit_logs.create({
      data: {
        user_id: user.userId,
        user_email: user.email,
        user_role: user.role,
        action: isSystemLine ? "invoice.system_line_overridden" : "invoice.manual_line_updated",
        entity_type: "invoice",
        entity_id: params.id,
        before_value: beforeLine ? JSON.parse(JSON.stringify(beforeLine)) : null,
        after_value: JSON.parse(JSON.stringify({ lineItemId: params.lineItemId, ...body, line: afterLine })),
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
    const invoice = await deleteInvoiceLine(prisma, params.id, params.lineItemId);
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
