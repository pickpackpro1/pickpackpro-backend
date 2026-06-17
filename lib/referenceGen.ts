import { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

export async function generateShipmentRef(prisma: PrismaClient) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10).replace(/-/g, "");
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const count = await prisma.shipments.count({ where: { created_at: { gte: start } } });
  return `SHP-${today}-${String(count + 1).padStart(4, "0")}`;
}

export function invoiceMonthKey(invoiceDate: Date) {
  return invoiceDate.toISOString().slice(0, 7).replace("-", "");
}

export async function generateInvoiceNumber(prisma: Db, invoiceDate: Date) {
  const month = invoiceMonthKey(invoiceDate);
  const prefix = `INV-${month}-`;
  const invoices = await prisma.invoices.findMany({
    where: { invoice_number: { startsWith: prefix } },
    select: { invoice_number: true },
  });
  const maxSequence = invoices.reduce((max, invoice) => {
    const sequence = Number(invoice.invoice_number.slice(prefix.length));
    return Number.isInteger(sequence) && sequence > max ? sequence : max;
  }, 0);
  return `${prefix}${String(maxSequence + 1).padStart(4, "0")}`;
}
