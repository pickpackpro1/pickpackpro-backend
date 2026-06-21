import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { sendEmail } from "@/lib/email";
import { finalInvoiceDates } from "@/lib/invoicing";
import { prisma } from "@/lib/prisma";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireRole(req, ["admin"]);
    const now = new Date();
    const { invoiceDate, dueDate } = await finalInvoiceDates(prisma, now);
    const invoice = await prisma.invoices.update({
      where: { id: params.id },
      data: {
        status: "sent",
        invoice_date: invoiceDate,
        due_date: dueDate,
        sent_at: now,
      },
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
        try {
          await sendEmail({
            to: clientUser.email,
            subject: `Invoice ${invoiceWithClient.invoice_number} — £${invoiceWithClient.total} due ${invoiceWithClient.due_date}`,
            html: `<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6f9;padding:40px 0;font-family:Arial,sans-serif;">
  <tr>
    <td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr>
          <td style="background-color:#132347;padding:28px 40px;">
            <div style="color:#ffffff;font-size:20px;font-weight:bold;">📦 PickPackPro</div>
            <div style="color:#8899bb;font-size:12px;margin-top:4px;">Warehouse Management System</div>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 40px 4px 40px;">
            <div style="background-color:#FF6B2C;height:4px;border-radius:2px;"></div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px;">
            <h2 style="color:#132347;font-size:20px;font-weight:bold;margin:0 0 8px 0;">Invoice Ready</h2>
            <p style="color:#FF6B2C;font-size:14px;font-weight:bold;margin:0 0 24px 0;">Payment due</p>
            <p style="color:#555555;font-size:15px;line-height:1.6;margin:0 0 16px 0;">
              Your invoice is now available. Please arrange payment via bank transfer using your account details.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border-radius:6px;border:1px solid #e8ecf0;margin:0 0 28px 0;">
              <tr>
                <td style="padding:20px;">
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="padding-bottom:12px;">
                        <div style="color:#888888;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Invoice Number</div>
                        <div style="color:#132347;font-size:16px;font-weight:bold;">${invoiceWithClient.invoice_number}</div>
                      </td>
                    </tr>
                    <tr>
                      <td style="border-top:1px solid #e8ecf0;padding-top:12px;padding-bottom:12px;">
                        <div style="color:#888888;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Amount Due</div>
                        <div style="color:#FF6B2C;font-size:24px;font-weight:bold;">£${invoiceWithClient.total}</div>
                      </td>
                    </tr>
                    <tr>
                      <td style="border-top:1px solid #e8ecf0;padding-top:12px;">
                        <div style="color:#888888;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Due Date</div>
                        <div style="color:#132347;font-size:16px;font-weight:bold;">${invoiceWithClient.due_date}</div>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
            <table cellpadding="0" cellspacing="0">
              <tr>
                <td style="background-color:#FF6B2C;border-radius:6px;padding:12px 24px;">
                  <a href="${process.env.FRONTEND_URL}/invoices" style="color:#ffffff;font-size:14px;font-weight:bold;text-decoration:none;">View Invoice →</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="background-color:#f4f6f9;padding:20px 40px;border-top:1px solid #e8ecf0;text-align:center;">
            <p style="color:#aaaaaa;font-size:12px;margin:0;">© 2026 Pick Pack Pro · pickpackpro.co.uk</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`,
          });
        } catch (emailErr) {
          console.error("[email] Failed to send invoice sent email:", emailErr);
        }
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
