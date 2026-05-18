import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireRole(req, ["admin"]);
    const invoice = await prisma.invoices.update({
      where: { id: params.id },
      data: { status: "sent", sent_at: new Date() },
    });
    const invoiceWithClient = await prisma.invoices.findUnique({
      where: { id: params.id },
      include: { clients: true },
    });
    if (invoiceWithClient) {
      const clientUser = await prisma.users.findFirst({
        where: { client_id: invoiceWithClient.client_id, role: "client" },
      });
      if (clientUser) {
        await prisma.notifications.create({
          data: {
            user_id: clientUser.id,
            type: "invoice_sent",
            title: "Invoice Sent",
            body: `Invoice ${invoiceWithClient.invoice_number} for £${invoiceWithClient.total} is due on ${invoiceWithClient.due_date}.`,
            link_url: "/invoices",
          },
        });
      }
    }
    await prisma.audit_logs.create({
      data: {
        user_id: user.userId,
        user_email: user.email,
        user_role: user.role,
        action: "invoice.sent",
        entity_type: "invoice",
        entity_id: params.id,
        after_value: JSON.parse(JSON.stringify(invoice)),
      },
    });
    return success({ invoice, emailQueued: false });
  } catch (err) {
    return handleApiError(err);
  }
}
