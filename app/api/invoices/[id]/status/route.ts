import { InvoiceStatus } from "@prisma/client";
import { z } from "zod";
import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
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
    const invoice = await prisma.invoices.update({
      where: { id: params.id },
      data: {
        status: body.status,
        sent_at: body.status === "sent" ? new Date() : undefined,
        paid_at: body.status === "paid" ? new Date() : undefined,
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
