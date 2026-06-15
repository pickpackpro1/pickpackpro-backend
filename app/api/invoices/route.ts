import { InvoiceStatus } from "@prisma/client";
import { handleApiError, success } from "@/lib/apiResponse";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const url = new URL(req.url);
    const clientId = url.searchParams.get("clientId") ?? undefined;
    const status = url.searchParams.get("status")?.toLowerCase() as InvoiceStatus | undefined;
    const month = url.searchParams.get("month");
    const dateFrom = url.searchParams.get("dateFrom");
    const dateTo = url.searchParams.get("dateTo");
    let invoiceDate: { gte?: Date; lte?: Date } | undefined;

    if (month) {
      const [year, monthNumber] = month.split("-").map(Number);
      if (year && monthNumber) {
        invoiceDate = {
          gte: new Date(year, monthNumber - 1, 1),
          lte: new Date(year, monthNumber, 0),
        };
      }
    }
    if (dateFrom) invoiceDate = { ...invoiceDate, gte: new Date(dateFrom) };
    if (dateTo) invoiceDate = { ...invoiceDate, lte: new Date(dateTo) };

    const invoices = await prisma.invoices.findMany({
      where: {
        client_id: user.role === "client" ? user.clientId! : clientId,
        status,
        invoice_date: invoiceDate,
      },
      select: {
        id: true,
        shipment_id: true,
        sub_shipment_id: true,
        invoice_number: true,
        invoice_date: true,
        due_date: true,
        status: true,
        invoice_type: true,
        period_start: true,
        period_end: true,
        subtotal: true,
        vat_amount: true,
        total: true,
        sent_at: true,
        paid_at: true,
        created_at: true,
        notes: true,
        client_id: true,
        clients: { select: { id: true, company_name: true, email: true, vat_registered: true } },
        _count: { select: { invoice_line_items: true } },
      },
      orderBy: { created_at: "desc" },
    });
    return success(invoices);
  } catch (err) {
    return handleApiError(err);
  }
}
