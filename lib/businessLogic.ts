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
    const subShipments = await prisma.sub_shipments.findMany({
      where: { parent_shipment_id: shipment.id, status: { not: "cancelled" } },
      include: { sub_shipment_items: true },
    });
    if (subShipments.length > 0) {
      const totalReceived = shipment.shipment_line_items.reduce((sum, item) => sum + (item.qty_received ?? 0), 0);
      const assignedQty = subShipments
        .flatMap((subShipment) => subShipment.sub_shipment_items)
        .reduce((sum, item) => sum + item.quantity, 0);
      if (assignedQty < totalReceived) return { valid: false, reason: "Not all received units are assigned to sub-shipments" };
      if (subShipments.some((subShipment) => subShipment.status !== "dispatched" && subShipment.status !== "completed")) {
        return { valid: false, reason: "Not all sub-shipments have been dispatched" };
      }
      return { valid: true };
    }
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
  if (!item) return { valid: false, error: "Item not found" };
  if (item.qty_received === null) return { valid: false, error: "Item not yet received" };
  if (!box) return { valid: false, error: "Box not found" };
  if (box.shipment_id !== item.shipment_id) return { valid: false, error: "Box does not belong to item shipment" };

  let maxAllocatable = item.qty_received ?? item.qty_expected ?? item.dispatch_qty ?? 0;
  let boxesWhere: Prisma.outbound_boxesWhereInput = { shipment_id: item.shipment_id };

  if (box.sub_shipment_id) {
    const subShipmentItem = await prisma.sub_shipment_items.findFirst({
      where: {
        sub_shipment_id: box.sub_shipment_id,
        shipment_line_item_id: shipmentItemId,
        sub_shipments: { status: { not: "cancelled" } },
      },
    });
    if (!subShipmentItem) return { valid: false, error: "Item is not part of this sub-shipment" };
    maxAllocatable = subShipmentItem.quantity;
    boxesWhere = { sub_shipment_id: box.sub_shipment_id };
  } else {
    const subShipmentItems = await prisma.sub_shipment_items.findMany({
      where: {
        shipment_line_item_id: shipmentItemId,
        sub_shipments: {
          parent_shipment_id: item.shipment_id,
          status: { not: "cancelled" },
        },
      },
    });
    const assignedToSubShipments = subShipmentItems.reduce((sum, subItem) => sum + subItem.quantity, 0);
    maxAllocatable = Math.max((item.qty_received ?? 0) - assignedToSubShipments, 0);
    boxesWhere = { shipment_id: item.shipment_id, sub_shipment_id: null };
  }

  const boxes = await prisma.outbound_boxes.findMany({ where: boxesWhere });
  const allocated = boxes.reduce((sum, current) => {
    const contents = current.contents as Array<{ shipmentItemId?: string; shipment_line_item_id?: string; quantity?: number }> | null;
    return (
      sum +
      (contents ?? [])
        .filter((entry) => entry.shipmentItemId === shipmentItemId || entry.shipment_line_item_id === shipmentItemId)
        .reduce((inner, entry) => inner + (entry.quantity ?? 0), 0)
    );
  }, 0);
  if (allocated + quantityToAdd > maxAllocatable) {
    return {
      valid: false,
      error: `Cannot allocate ${quantityToAdd} units. Max allocatable: ${maxAllocatable - allocated} (received/boxable quantity: ${maxAllocatable})`,
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

  const catalog = await prisma.service_catalog.findMany();
  const prices = await prisma.client_price_lists.findMany({
    where: { client_id: clientId },
    orderBy: { effective_from: "desc" },
  });
  const totalUnitsForTier = shipments
    .flatMap((s) => s.shipment_line_items)
    .reduce((sum, item) => sum + (item.qty_received ?? 0), 0);

  const tier =
    client.pricing_tier_override ??
    (totalUnitsForTier >= 5000 ? "platinum" : totalUnitsForTier >= 2000 ? "gold" : "silver");

  let subtotal = 0;
  let totalVat = 0;
  const lineItems: {
    service_code: string;
    description: string;
    qty: number;
    unit_rate: number;
    amount: number;
    vat_rate: number;
    vat_amount: number;
    sort_order: number;
    shipment_id: string | null;
    shipment_line_item_id: string | null;
  }[] = [];

  let sortIndex = 1;

  for (const shipment of shipments) {
    for (const item of shipment.shipment_line_items) {
      const billingUnits = item.qty_received ?? 0;
      if (billingUnits === 0) continue;

      const selected = item.services_selected as string[] | null;
      const statuses = item.service_status as Record<string, string> | null;
      const sku = item.products?.sku ?? "Unknown SKU";

      for (const service of selected ?? []) {
        if (statuses?.[service] !== "DONE" && statuses?.[service] !== "done") continue;

        const svc = catalog.find((entry) => entry.code === service);
        const custom = prices.find((price) => price.service_code === service);
        const tierPricing = (svc?.default_tier_pricing ?? {}) as Record<string, number>;
        const unitRate = Number(custom?.rate ?? tierPricing[tier] ?? 0);
        const amount = billingUnits * unitRate;
        const vatRate = client.vat_registered && svc?.vat_applicable ? 0.2 : 0;
        const vatAmount = amount * vatRate;

        subtotal += amount;
        totalVat += vatAmount;

        lineItems.push({
          service_code: service,
          description: `${svc?.display_name ?? service} — SKU ${sku} — Shipment ${shipment.reference}`,
          qty: billingUnits,
          unit_rate: unitRate,
          amount,
          vat_rate: vatRate,
          vat_amount: vatAmount,
          sort_order: sortIndex++,
          shipment_id: shipment.id,
          shipment_line_item_id: item.id,
        });
      }
    }

    const boxes = await prisma.outbound_boxes.findMany({
      where: { shipment_id: shipment.id, dispatched_at: { not: null } },
    });

    for (const box of boxes) {
      let boxServiceCode: string | null = null;
      if (box.box_type === "pallet") boxServiceCode = "pallet_forwarding";
      else if (box.box_type === "box" && box.box_size === "medium") boxServiceCode = "medium_box";
      else if (box.box_type === "box" && box.box_size === "large") boxServiceCode = "large_box";

      if (!boxServiceCode) continue;

      const svc = catalog.find((entry) => entry.code === boxServiceCode);
      const custom = prices.find((price) => price.service_code === boxServiceCode);
      const tierPricing = (svc?.default_tier_pricing ?? {}) as Record<string, number>;
      const unitRate = Number(custom?.rate ?? tierPricing[tier] ?? tierPricing["rate"] ?? 0);
      const amount = unitRate;
      const vatRate = client.vat_registered && svc?.vat_applicable ? 0.2 : 0;
      const vatAmount = amount * vatRate;

      subtotal += amount;
      totalVat += vatAmount;

      lineItems.push({
        service_code: boxServiceCode,
        description: `${svc?.display_name ?? boxServiceCode} — Shipment ${shipment.reference}`,
        qty: 1,
        unit_rate: unitRate,
        amount,
        vat_rate: vatRate,
        vat_amount: vatAmount,
        sort_order: sortIndex++,
        shipment_id: shipment.id,
        shipment_line_item_id: null,
      });
    }
  }

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
