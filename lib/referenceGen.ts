import { PrismaClient } from "@prisma/client";

export async function generateShipmentRef(prisma: PrismaClient) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10).replace(/-/g, "");
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const count = await prisma.shipments.count({ where: { created_at: { gte: start } } });
  return `SHP-${today}-${String(count + 1).padStart(4, "0")}`;
}

export async function generateInvoiceNumber(prisma: PrismaClient, periodEnd: Date) {
  const month = periodEnd.toISOString().slice(0, 7).replace("-", "");
  const start = new Date(periodEnd.getFullYear(), periodEnd.getMonth(), 1);
  const count = await prisma.invoices.count({ where: { created_at: { gte: start } } });
  return `INV-${month}-${String(count + 1).padStart(4, "0")}`;
}
