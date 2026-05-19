import { Prisma, PrismaClient, ShipmentStatus } from "@prisma/client";
import { ApiError } from "./apiResponse";
import { generateInvoiceNumber } from "./referenceGen";

export function calculateDispatchQty(receivedQty: number, bundleSize = 1) {
  return Math.floor(receivedQty / Math.max(bundleSize, 1));
}

export function getBillingUnits(item: { qty_received: number | null }) {
  return item.qty_received ?? 0;
}

const validTransitions: Record<ShipmentStatus, ShipmentStatus[]> = {
  draft: ["submitted", "pending_arrival"],
  submitted: ["pending_arrival", "received"],
  pending_arrival: ["received"],
  received: ["in_progress"],
  in_progress: ["prepped"],
  prepped: ["dispatched"],
  dispatched: ["completed"],
  completed: [],
};

export async function validateStatusTransition(
  prisma: PrismaClient | Prisma.TransactionClient,
  shipment: Prisma.shipmentsGetPayload<{ include: { shipment_line_items: true } }>,
  newStatus: ShipmentStatus,
) {
  if (!validTransitions[shipment.status]?.includes(newStatus)) {
    return { valid: false, reason: `Cannot transition from ${shipment.status} to ${newStatus}` };
  }
  if (newStatus === "received" && shipment.shipment_line_items.some((i) => i.qty_received === null)) {
    return { valid: false, reason: "Not all items have been received yet" };
  }
  if (newStatus === "prepped") {
    const allDone = shipment.shipment_line_items.every((item) => {
      const statuses = item.service_status as Record<string, string> | null;
      const selected = item.services_selected as string[] | null;
      return (selected ?? []).every((service) => statuses?.[service] === "DONE" || statuses?.[service] === "done");
    });
    if (!allDone) return { valid: false, reason: "Not all service tasks are completed" };
  }
  if (newStatus === "dispatched") {
    const boxes = await prisma.outbound_boxes.findMany({ where: { shipment_id: shipment.id } });
    if (boxes.length === 0) return { valid: false, reason: "No boxes created for this shipment" };
  }
  return { valid: true };
}

export async function assertTransition(
  prisma: PrismaClient | Prisma.TransactionClient,
  shipment: Prisma.shipmentsGetPayload<{ include: { shipment_line_items: true } }>,
  newStatus: ShipmentStatus,
) {
  const result = await validateStatusTransition(prisma, shipment, newStatus);
  if (!result.valid) throw new ApiError(result.reason ?? "Invalid status transition", 422);
}

export async function validateBoxAllocation(
  prisma: PrismaClient | Prisma.TransactionClient,
  shipmentItemId: string,
  boxId: string,
  quantityToAdd: number,
) {
  const [item, box] = await Promise.all([
    prisma.shipment_line_items.findUnique({ where: { id: shipmentItemId } }),
    prisma.outbound_boxes.findUnique({ where: { id: boxId } }),
  ]);
  if (!item || item.dispatch_qty === null) return { valid: false, error: "Item not yet received" };
  if (!box || box.shipment_id !== item.shipment_id) return { valid: false, error: "Box does not belong to item shipment" };

  const boxes = await prisma.outbound_boxes.findMany({ where: { shipment_id: item.shipment_id } });
  const allocated = boxes.reduce((sum, current) => {
    const contents = current.contents as Array<{ shipmentItemId?: string; shipment_line_item_id?: string; quantity?: number }> | null;
    return (
      sum +
      (contents ?? [])
        .filter((entry) => entry.shipmentItemId === shipmentItemId || entry.shipment_line_item_id === shipmentItemId)
        .reduce((inner, entry) => inner + (entry.quantity ?? 0), 0)
    );
  }, 0);
  if (allocated + quantityToAdd > item.dispatch_qty) {
    return {
      valid: false,
      error: `Cannot allocate ${quantityToAdd} units. Max allocatable: ${item.dispatch_qty - allocated} (dispatch qty: ${item.dispatch_qty})`,
    };
  }
  return { valid: true };
}

export async function generateInvoice(
  prisma: PrismaClient | Prisma.TransactionClient,
  clientId: string,
  periodStart: Date,
  periodEnd: Date,
  createdBy: string,
) {
  const client = await prisma.clients.findUnique({ where: { id: clientId } });
  if (!client) throw new ApiError("Client not found", 404);

  const shipments = await prisma.shipments.findMany({
    where: {
      client_id: clientId,
      status: { in: ["dispatched", "completed"] },
      actual_arrival_date: { gte: periodStart, lte: periodEnd },
    },
    include: { shipment_line_items: { include: { products: true } } },
  });

  const serviceUnits: Record<string, number> = {};
  for (const shipment of shipments) {
    for (const item of shipment.shipment_line_items) {
      const billingUnits = getBillingUnits(item);
      const selected = item.services_selected as string[] | null;
      const statuses = item.service_status as Record<string, string> | null;
      for (const service of selected ?? []) {
        if (statuses?.[service] === "DONE" || statuses?.[service] === "done") {
          serviceUnits[service] = (serviceUnits[service] ?? 0) + billingUnits;
        }
      }
    }
  }

  const catalog = await prisma.service_catalog.findMany({
    where: { code: { in: Object.keys(serviceUnits) } },
  });
  const prices = await prisma.client_price_lists.findMany({
    where: { client_id: clientId, service_code: { in: Object.keys(serviceUnits) } },
    orderBy: { effective_from: "desc" },
  });
  const tier = client.pricing_tier_override ?? "silver";
  let subtotal = 0;
  let totalVat = 0;
  const lineItems = Object.entries(serviceUnits).map(([service, units], index) => {
    const custom = prices.find((price) => price.service_code === service);
    const svc = catalog.find((entry) => entry.code === service);
    const tierPricing = (svc?.default_tier_pricing ?? {}) as Record<string, number>;
    const unitRate = Number(custom?.rate ?? tierPricing[tier] ?? 0);
    const amount = units * unitRate;
    const vatRate = client.vat_registered && svc?.vat_applicable ? 0.2 : 0;
    const vatAmount = amount * vatRate;
    subtotal += amount;
    totalVat += vatAmount;
    return {
      service_code: service,
      description: svc?.display_name ?? service,
      qty: units,
      unit_rate: unitRate,
      amount,
      vat_rate: vatRate,
      vat_amount: vatAmount,
      sort_order: index + 1,
    };
  });

  const invoiceNumber = await generateInvoiceNumber(prisma as PrismaClient, periodEnd);
  const dueDate = new Date(periodEnd.getTime() + 14 * 24 * 60 * 60 * 1000);

  return prisma.invoices.create({
    data: {
      client_id: clientId,
      invoice_number: invoiceNumber,
      invoice_date: new Date(),
      due_date: dueDate,
      invoice_type: "monthly",
      period_start: periodStart,
      period_end: periodEnd,
      subtotal,
      vat_amount: totalVat,
      total: subtotal + totalVat,
      created_by: createdBy,
      invoice_line_items: { create: lineItems },
    },
    include: { invoice_line_items: true, clients: true },
  });
}
