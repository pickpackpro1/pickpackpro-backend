import { InvoiceStatus } from "@prisma/client";
import { z } from "zod";
import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { finalInvoiceDates } from "@/lib/invoicing";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const schema = z.object({ status: z.nativeEnum(InvoiceStatus) });

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireRole(req, ["admin"]);
    const body = await json(req, schema);
    const before = await prisma.invoices.findUnique({
      where: { id: params.id },
      select: { status: true },
    });
    const now = new Date();
    const finalDates = body.status === "sent" ? finalInvoiceDates(now) : null;
    const invoice = await prisma.invoices.update({
      where: { id: params.id },
      data: {
        status: body.status,
        invoice_date: finalDates?.invoiceDate,
        due_date: finalDates?.dueDate,
        sent_at: body.status === "sent" ? now : undefined,
        paid_at: body.status === "paid" ? now : undefined,
      },
    });
    await prisma.audit_logs.create({
      data: {
        user_id: user.userId,
        user_email: user.email,
        user_role: user.role,
        action: "invoice.status_changed",
        entity_type: "invoice",
        entity_id: params.id,
        before_value: { status: before?.status },
        after_value: { status: invoice.status },
      },
    });
    return success(invoice);
  } catch (err) {
    return handleApiError(err);
  }
}
