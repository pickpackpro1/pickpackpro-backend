import { ApiError, handleApiError } from "@/lib/apiResponse";
import { requireUser } from "@/lib/auth";
import { renderInvoicePdf } from "@/lib/invoicePdf";
import { prisma } from "@/lib/prisma";

function pdfFilename(invoiceNumber: string) {
  return `${invoiceNumber.replace(/[^a-zA-Z0-9._-]+/g, "_")}.pdf`;
}

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser(req);
    const [invoice, settings] = await Promise.all([
      prisma.invoices.findUnique({
        where: { id: params.id },
        include: {
          clients: true,
          invoice_line_items: { orderBy: { sort_order: "asc" } },
        },
      }),
      prisma.app_settings.findFirst(),
    ]);

    if (!invoice) throw new ApiError("Invoice not found", 404);
    if (user.role === "client" && invoice.client_id !== user.clientId) {
      throw new ApiError("Forbidden", 403);
    }

    const pdf = renderInvoicePdf(invoice, settings);
    return new Response(pdf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${pdfFilename(invoice.invoice_number)}"`,
        "Content-Length": String(pdf.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
