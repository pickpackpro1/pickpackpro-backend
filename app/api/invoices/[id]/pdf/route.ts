import { ApiError, handleApiError } from "@/lib/apiResponse";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser(req);
    const invoice = await prisma.invoices.findUnique({
      where: { id: params.id },
      include: {
        clients: true,
        invoice_line_items: { orderBy: { sort_order: "asc" } },
      },
    });
    if (!invoice) throw new ApiError("Invoice not found", 404);
    if (user.role === "client" && invoice.client_id !== user.clientId) {
      throw new ApiError("Forbidden", 403);
    }

    const formatCurrency = (value: number) =>
      new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(value);
    const formatDate = (value: Date | null) =>
      value ? new Date(value).toLocaleDateString("en-GB") : "--";
    const isClientInvoice =
      !invoice.shipment_id &&
      !invoice.sub_shipment_id &&
      (invoice.invoice_type === "monthly" || invoice.invoice_type === "ad_hoc");

    const lineItemsHtml = invoice.invoice_line_items
      .map(
        (item) =>
          isClientInvoice
            ? `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;">${item.description}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;">${item.qty}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;">${formatCurrency(Number(item.unit_rate))}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;">${formatCurrency(Number(item.amount))}</td>
        </tr>`
            : `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;">${item.description}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;">${item.qty}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;">${formatCurrency(Number(item.unit_rate))}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;">${formatCurrency(Number(item.amount))}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;">${formatCurrency(Number(item.vat_amount))}</td>
        </tr>`
      )
      .join("");

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Invoice ${invoice.invoice_number}</title>
<style>body{font-family:Arial,sans-serif;color:#1a1a1a;margin:0;padding:40px;}
.header{display:flex;justify-content:space-between;margin-bottom:40px;}
.logo{font-size:24px;font-weight:bold;color:#132347;}
.accent{color:#ff6900;}
table{width:100%;border-collapse:collapse;}
th{background:#f8f9fa;padding:10px 12px;text-align:left;font-size:12px;text-transform:uppercase;color:#666;}
th:not(:first-child){text-align:right;}
.totals td{padding:6px 12px;}
.total-row{font-weight:bold;font-size:16px;border-top:2px solid #132347;}
</style></head>
<body>
<div class="header">
  <div>
    <div class="logo">Pick<span class="accent">Pack</span>Pro</div>
    <div style="margin-top:8px;font-size:13px;color:#666;">pickpackpro.co.uk</div>
  </div>
  <div style="text-align:right;">
    <div style="font-size:20px;font-weight:bold;">${invoice.invoice_number}</div>
    <div style="color:#666;font-size:13px;">Invoice Date: ${formatDate(invoice.invoice_date)}</div>
    <div style="color:#666;font-size:13px;">Due: ${formatDate(invoice.due_date)}</div>
  </div>
</div>
<div style="margin-bottom:32px;">
  <div style="font-size:12px;text-transform:uppercase;color:#999;margin-bottom:4px;">Billed To</div>
  <div style="font-weight:bold;">${invoice.clients.company_name}</div>
  <div style="color:#555;font-size:13px;">${invoice.clients.email}</div>
</div>
<table>
  <thead><tr>
    ${
      isClientInvoice
        ? "<th>Description</th><th>Unit</th><th>Rate</th><th>Amount</th>"
        : "<th>Description</th><th>Qty</th><th>Rate</th><th>Amount</th><th>VAT</th>"
    }
  </tr></thead>
  <tbody>${lineItemsHtml}</tbody>
</table>
<table class="totals" style="margin-top:24px;max-width:300px;margin-left:auto;">
  ${isClientInvoice ? "" : `<tr><td>Subtotal</td><td style="text-align:right;">${formatCurrency(Number(invoice.subtotal))}</td></tr>
  <tr><td>VAT</td><td style="text-align:right;">${formatCurrency(Number(invoice.vat_amount))}</td></tr>`}
  <tr class="total-row"><td>Total</td><td style="text-align:right;">${formatCurrency(Number(invoice.total))}</td></tr>
</table>
<div style="margin-top:48px;padding:20px;background:#f8f9fa;border-radius:8px;font-size:13px;">
  <strong>Payment — Bank Transfer</strong><br>
  Sort Code: 48-01-82 &nbsp;|&nbsp; Account: 12345678<br>
  Reference: ${invoice.invoice_number}
</div>
</body></html>`;

    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `attachment; filename="${invoice.invoice_number}.html"`,
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
