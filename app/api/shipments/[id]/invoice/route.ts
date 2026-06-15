import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { ensureShipmentDraftInvoice } from "@/lib/invoicing";
import { prisma } from "@/lib/prisma";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireRole(req, ["admin"]);
    const invoice = await ensureShipmentDraftInvoice(prisma, params.id, user.userId);
    await prisma.audit_logs.create({
      data: {
        user_id: user.userId,
        user_email: user.email,
        user_role: user.role,
        action: "invoice.generated",
        entity_type: "shipment",
        entity_id: params.id,
        after_value: { invoiceId: invoice.id, invoiceNumber: invoice.invoice_number },
      },
    });
    return success(invoice);
  } catch (err) {
    return handleApiError(err);
  }
}
