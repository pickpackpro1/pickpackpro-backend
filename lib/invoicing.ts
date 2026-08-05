import { InvoiceStatus, Prisma, PrismaClient } from "@prisma/client";
import { ApiError } from "./apiResponse";
import { normalizeServiceCode } from "./businessLogic";
import { generateInvoiceNumber, invoiceMonthKey } from "./referenceGen";

type Db = PrismaClient | Prisma.TransactionClient;
type DispatchInvoiceWhere = { shipmentId?: string; subShipmentId?: string };
type DispatchInvoiceCreateData = Omit<Prisma.invoicesUncheckedCreateInput, "invoice_number" | "invoice_line_items">;

type BillableLineItem = {
  id: string;
  quantity: number;
  services_selected: Prisma.JsonValue;
  service_status: Prisma.JsonValue;
  products: {
    sku: string;
  };
};

type BoxForInvoice = {
  id: string;
  box_type: string;
  box_size: string | null;
  dispatched_at: Date | null;
};

type PricingTierName = "silver" | "gold" | "platinum";

type ServiceCatalogEntry = {
  code: string;
  display_name: string;
  default_tier_pricing: Prisma.JsonValue;
  vat_applicable: boolean;
};

type ClientPriceEntry = {
  service_code: string;
  tier: string | null;
  rate: Prisma.Decimal | number | string;
};

type SystemInvoiceLine = {
  shipment_id: string;
  sub_shipment_id: string | null;
  shipment_line_item_id: string | null;
  service_code: string;
  description: string;
  qty: number;
  unit_rate: number;
  amount: number;
  vat_rate: number;
  vat_amount: number;
  line_source: "system";
  sort_order: number;
};

const invoiceInclude = {
  clients: true,
  invoice_line_items: { orderBy: { sort_order: "asc" } },
} satisfies Prisma.invoicesInclude;

type DispatchInvoiceRecord = Prisma.invoicesGetPayload<{ include: typeof invoiceInclude }>;

const MAX_INVOICE_NUMBER_ATTEMPTS = 5;
const DEFAULT_INVOICE_PAYMENT_TERMS_DAYS = 14;

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function validPaymentTermsDays(value: unknown) {
  const days = Number(value);
  return Number.isInteger(days) && days >= 1 ? days : DEFAULT_INVOICE_PAYMENT_TERMS_DAYS;
}

async function invoicePaymentTermsDays(prisma: Db) {
  const settings = await prisma.app_settings.findFirst({
    select: { invoice_payment_terms_days: true },
  });
  return validPaymentTermsDays(settings?.invoice_payment_terms_days);
}

export async function finalInvoiceDates(prisma: Db, now = new Date()) {
  const paymentTermsDays = await invoicePaymentTermsDays(prisma);
  return {
    invoiceDate: now,
    dueDate: addDays(now, paymentTermsDays),
  };
}

function isDoneStatus(status: unknown) {
  return String(status || "").toLowerCase() === "done";
}

function getServiceStatus(statuses: Record<string, unknown> | null, rawServiceCode: string, normalizedServiceCode: string) {
  if (!statuses) return undefined;
  return statuses[rawServiceCode] ?? statuses[normalizedServiceCode] ?? statuses[rawServiceCode.toUpperCase()];
}

function getTierRate(pricing: Prisma.JsonValue | undefined, tier: string) {
  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) return 0;
  const tierPricing = pricing as Record<string, unknown>;
  return Number(tierPricing[tier] ?? tierPricing.rate ?? 0);
}

function getPricingTier(client: { pricing_tier_override: PricingTierName | string | null }, totalUnits: number): PricingTierName {
  if (client.pricing_tier_override === "silver" || client.pricing_tier_override === "gold" || client.pricing_tier_override === "platinum") {
    return client.pricing_tier_override;
  }
  return totalUnits >= 5000 ? "platinum" : totalUnits >= 2000 ? "gold" : "silver";
}

function clientPriceForService(prices: ClientPriceEntry[], serviceCode: string, tier: string) {
  const normalizedServiceCode = normalizeServiceCode(serviceCode);
  return (
    prices.find((price) => normalizeServiceCode(price.service_code) === normalizedServiceCode && price.tier === tier) ??
    prices.find((price) => normalizeServiceCode(price.service_code) === normalizedServiceCode && !price.tier) ??
    null
  );
}

function lineAmounts(qty: number, unitRate: number, vatRate: number) {
  const amount = qty * unitRate;
  const vatAmount = amount * vatRate;
  return { amount, vatAmount };
}

export async function recalculateInvoiceTotals(prisma: Db, invoiceId: string) {
  const lines = await prisma.invoice_line_items.findMany({ where: { invoice_id: invoiceId } });
  const subtotal = lines.reduce((sum, line) => sum + Number(line.amount), 0);
  const vatAmount = lines.reduce((sum, line) => sum + Number(line.vat_amount), 0);
  return prisma.invoices.update({
    where: { id: invoiceId },
    data: {
      subtotal,
      vat_amount: vatAmount,
      total: subtotal + vatAmount,
    },
    include: invoiceInclude,
  });
}

function nextSortOrder(lines: { sort_order: number }[]) {
  return lines.reduce((max, line) => Math.max(max, line.sort_order), 0) + 1;
}

export async function assertEditableInvoice(prisma: Db, invoiceId: string) {
  const invoice = await prisma.invoices.findUnique({
    where: { id: invoiceId },
    include: { clients: true, invoice_line_items: true },
  });
  if (!invoice) throw new ApiError("Invoice not found", 404);
  if (invoice.status !== "draft" && invoice.status !== "sent") {
    throw new ApiError("Only draft or sent invoices can be edited", 422);
  }
  return invoice;
}

export async function addManualInvoiceLine(
  prisma: Db,
  invoiceId: string,
  input: {
    description: string;
    qty: number;
    unitRate: number;
    serviceCode?: string | null;
    vatRate?: number | null;
  },
) {
  const invoice = await assertEditableInvoice(prisma, invoiceId);
  const isClientInvoice =
    !invoice.shipment_id &&
    !invoice.sub_shipment_id &&
    (invoice.invoice_type === "monthly" || invoice.invoice_type === "ad_hoc");
  const vatRate = input.vatRate ?? (isClientInvoice ? 0 : invoice.clients.vat_registered ? 0.2 : 0);
  const { amount, vatAmount } = lineAmounts(input.qty, input.unitRate, vatRate);
  await prisma.invoice_line_items.create({
    data: {
      invoice_id: invoice.id,
      shipment_id: invoice.shipment_id,
      sub_shipment_id: invoice.sub_shipment_id,
      shipment_line_item_id: null,
      service_code: normalizeServiceCode(input.serviceCode || input.description),
      description: input.description,
      qty: input.qty,
      unit_rate: input.unitRate,
      amount,
      vat_rate: vatRate,
      vat_amount: vatAmount,
      line_source: "manual",
      sort_order: nextSortOrder(invoice.invoice_line_items),
    },
  });
  return recalculateInvoiceTotals(prisma, invoice.id);
}

export async function updateManualInvoiceLine(
  prisma: Db,
  invoiceId: string,
  lineItemId: string,
  input: {
    description?: string;
    qty?: number;
    unitRate?: number;
    serviceCode?: string | null;
    vatRate?: number | null;
  },
) {
  const invoice = await assertEditableInvoice(prisma, invoiceId);
  const line = await prisma.invoice_line_items.findUnique({ where: { id: lineItemId } });
  if (!line || line.invoice_id !== invoiceId) throw new ApiError("Invoice line item not found", 404);
  if (line.line_source !== "manual") throw new ApiError("System invoice lines cannot be edited", 422);

  const qty = input.qty ?? Number(line.qty);
  const unitRate = input.unitRate ?? Number(line.unit_rate);
  const vatRate = input.vatRate ?? Number(line.vat_rate);
  const { amount, vatAmount } = lineAmounts(qty, unitRate, vatRate);

  await prisma.invoice_line_items.update({
    where: { id: lineItemId },
    data: {
      description: input.description ?? line.description,
      service_code: input.serviceCode === undefined ? line.service_code : normalizeServiceCode(input.serviceCode || input.description || line.description),
      qty,
      unit_rate: unitRate,
      amount,
      vat_rate: vatRate,
      vat_amount: vatAmount,
    },
  });
  return recalculateInvoiceTotals(prisma, invoice.id);
}

export async function deleteManualInvoiceLine(prisma: Db, invoiceId: string, lineItemId: string) {
  const invoice = await assertEditableInvoice(prisma, invoiceId);
  const line = await prisma.invoice_line_items.findUnique({ where: { id: lineItemId } });
  if (!line || line.invoice_id !== invoiceId) throw new ApiError("Invoice line item not found", 404);
  if (line.line_source !== "manual") throw new ApiError("System invoice lines cannot be deleted", 422);
  await prisma.invoice_line_items.delete({ where: { id: lineItemId } });
  return recalculateInvoiceTotals(prisma, invoice.id);
}

function contentsQuantityByLineItem(boxes: Array<{ contents: Prisma.JsonValue }>) {
  const quantities = new Map<string, number>();
  for (const box of boxes) {
    const contents = Array.isArray(box.contents) ? box.contents : [];
    for (const entry of contents) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const itemId = String(entry.shipmentItemId || entry.shipment_line_item_id || "");
      const quantity = Number(entry.quantity || 0);
      if (!itemId || quantity <= 0) continue;
      quantities.set(itemId, (quantities.get(itemId) ?? 0) + quantity);
    }
  }
  return quantities;
}

function boxServiceCode(box: BoxForInvoice) {
  if (box.box_type === "pallet") return "pallet_forwarding";
  if (box.box_type === "box" && box.box_size === "medium") return "medium_box";
  if (box.box_type === "box" && box.box_size === "large") return "large_box";
  return null;
}

async function pricingContext(
  prisma: Db,
  clientId: string,
  client: { pricing_tier_override: PricingTierName | string | null },
  totalUnits: number,
) {
  const [catalog, prices] = await Promise.all([
    prisma.service_catalog.findMany(),
    prisma.client_price_lists.findMany({
      where: { client_id: clientId },
      orderBy: { effective_from: "desc" },
    }),
  ]);
  return {
    tier: getPricingTier(client, totalUnits),
    catalogByCode: new Map(catalog.map((entry) => [normalizeServiceCode(entry.code), entry])),
    prices,
  };
}

function buildServiceLines(input: {
  items: BillableLineItem[];
  shipmentId: string;
  subShipmentId: string | null;
  shipmentReference: string;
  clientVatRegistered: boolean;
  tier: string;
  catalogByCode: Map<string, ServiceCatalogEntry>;
  prices: ClientPriceEntry[];
  startSortOrder: number;
}) {
  const lines: SystemInvoiceLine[] = [];
  let sortOrder = input.startSortOrder;

  for (const item of input.items) {
    if (item.quantity <= 0) continue;
    const selected = Array.isArray(item.services_selected) ? item.services_selected.map(String) : [];
    const statuses = item.service_status && typeof item.service_status === "object" && !Array.isArray(item.service_status)
      ? (item.service_status as Record<string, unknown>)
      : null;

    for (const service of selected) {
      const serviceCode = normalizeServiceCode(service);
      if (!isDoneStatus(getServiceStatus(statuses, service, serviceCode))) continue;

      const svc = input.catalogByCode.get(serviceCode);
      const billingServiceCode = svc?.code ?? serviceCode;
      const custom = clientPriceForService(input.prices, serviceCode, input.tier);
      const unitRate = Number(custom?.rate ?? getTierRate(svc?.default_tier_pricing, input.tier));
      const vatRate = input.clientVatRegistered && svc?.vat_applicable ? 0.2 : 0;
      const { amount, vatAmount } = lineAmounts(item.quantity, unitRate, vatRate);

      lines.push({
        shipment_id: input.shipmentId,
        sub_shipment_id: input.subShipmentId,
        shipment_line_item_id: item.id,
        service_code: billingServiceCode,
        description: `${svc?.display_name ?? service} - SKU ${item.products.sku} - Shipment ${input.shipmentReference}`,
        qty: item.quantity,
        unit_rate: unitRate,
        amount,
        vat_rate: vatRate,
        vat_amount: vatAmount,
        line_source: "system",
        sort_order: sortOrder++,
      });
    }
  }

  return lines;
}

function buildBoxLines(input: {
  boxes: BoxForInvoice[];
  shipmentId: string;
  subShipmentId: string | null;
  shipmentReference: string;
  clientVatRegistered: boolean;
  tier: string;
  catalogByCode: Map<string, ServiceCatalogEntry>;
  prices: ClientPriceEntry[];
  startSortOrder: number;
}) {
  const lines: SystemInvoiceLine[] = [];
  let sortOrder = input.startSortOrder;

  for (const box of input.boxes) {
    if (!box.dispatched_at) continue;
    const serviceCode = boxServiceCode(box);
    if (!serviceCode) continue;

    const normalizedServiceCode = normalizeServiceCode(serviceCode);
    const svc = input.catalogByCode.get(normalizedServiceCode);
    const billingServiceCode = svc?.code ?? normalizedServiceCode;
    const custom = clientPriceForService(input.prices, normalizedServiceCode, input.tier);
    const unitRate = Number(custom?.rate ?? getTierRate(svc?.default_tier_pricing, input.tier));
    const vatRate = input.clientVatRegistered && svc?.vat_applicable ? 0.2 : 0;
    const { amount, vatAmount } = lineAmounts(1, unitRate, vatRate);

    lines.push({
      shipment_id: input.shipmentId,
      sub_shipment_id: input.subShipmentId,
      shipment_line_item_id: null,
      service_code: billingServiceCode,
      description: `${svc?.display_name ?? billingServiceCode} - Shipment ${input.shipmentReference}`,
      qty: 1,
      unit_rate: unitRate,
      amount,
      vat_rate: vatRate,
      vat_amount: vatAmount,
      line_source: "system",
      sort_order: sortOrder++,
    });
  }

  return lines;
}

function totalsFor(lines: Array<{ amount: Prisma.Decimal | number | string; vat_amount: Prisma.Decimal | number | string }>) {
  const subtotal = lines.reduce((sum, line) => sum + Number(line.amount), 0);
  const vatAmount = lines.reduce((sum, line) => sum + Number(line.vat_amount), 0);
  return { subtotal, vatAmount, total: subtotal + vatAmount };
}

async function existingDispatchInvoice(
  prisma: Db,
  where: DispatchInvoiceWhere,
) {
  return prisma.invoices.findFirst({
    where: {
      shipment_id: where.shipmentId,
      sub_shipment_id: where.subShipmentId ?? null,
      invoice_type: where.subShipmentId ? "sub_shipment" : "shipment",
      status: { not: "cancelled" as InvoiceStatus },
    },
    include: invoiceInclude,
  });
}

function canStartTransaction(prisma: Db): prisma is PrismaClient {
  return "$transaction" in prisma && typeof prisma.$transaction === "function";
}

async function withInvoiceCreationLock<T>(prisma: Db, invoiceDate: Date, callback: (tx: Db) => Promise<T>) {
  const lockKey = `invoice-create:${invoiceMonthKey(invoiceDate)}`;
  if (canStartTransaction(prisma)) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      return callback(tx);
    });
  }

  await prisma.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
  return callback(prisma);
}

function isInvoiceNumberCollision(err: unknown) {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") return false;
  const target = err.meta?.target;
  if (Array.isArray(target)) return target.includes("invoice_number");
  return String(target ?? "").includes("invoice_number");
}

function systemLineCreateManyData(invoiceId: string, lines: SystemInvoiceLine[]): Prisma.invoice_line_itemsCreateManyInput[] {
  return lines.map((line) => ({
    ...line,
    invoice_id: invoiceId,
  }));
}

async function refreshDispatchInvoice(
  prisma: Db,
  existing: DispatchInvoiceRecord,
  data: DispatchInvoiceCreateData,
  systemLines: SystemInvoiceLine[],
) {
  const preservedLines = existing.invoice_line_items.filter((line) => line.line_source !== "system");
  const totals = totalsFor([...systemLines, ...preservedLines]);

  await prisma.invoice_line_items.deleteMany({
    where: { invoice_id: existing.id, line_source: "system" },
  });
  if (systemLines.length) {
    await prisma.invoice_line_items.createMany({
      data: systemLineCreateManyData(existing.id, systemLines),
    });
  }
  await Promise.all(
    preservedLines.map((line, index) =>
      prisma.invoice_line_items.update({
        where: { id: line.id },
        data: { sort_order: systemLines.length + index + 1 },
      }),
    ),
  );

  return prisma.invoices.update({
    where: { id: existing.id },
    data: {
      client_id: data.client_id,
      shipment_id: data.shipment_id ?? null,
      sub_shipment_id: data.sub_shipment_id ?? null,
      invoice_type: data.invoice_type,
      subtotal: totals.subtotal,
      vat_amount: totals.vatAmount,
      total: totals.total,
    },
    include: invoiceInclude,
  });
}

async function saveDispatchInvoice(
  prisma: Db,
  where: DispatchInvoiceWhere,
  invoiceDate: Date,
  data: DispatchInvoiceCreateData,
  systemLines: SystemInvoiceLine[],
) {
  return withInvoiceCreationLock(prisma, invoiceDate, async (tx) => {
    for (let attempt = 0; attempt < MAX_INVOICE_NUMBER_ATTEMPTS; attempt++) {
      const existing = await existingDispatchInvoice(tx, where);
      if (existing) return refreshDispatchInvoice(tx, existing, data, systemLines);

      try {
        return await tx.invoices.create({
          data: {
            ...data,
            invoice_number: await generateInvoiceNumber(tx, invoiceDate),
            invoice_line_items: systemLines.length ? { create: systemLines } : undefined,
          },
          include: invoiceInclude,
        });
      } catch (err) {
        if (!isInvoiceNumberCollision(err)) throw err;
      }
    }

    const existing = await existingDispatchInvoice(tx, where);
    if (existing) return refreshDispatchInvoice(tx, existing, data, systemLines);
    throw new ApiError("Could not generate a unique invoice number. Please try again.", 409);
  });
}

export async function ensureShipmentDraftInvoice(prisma: Db, shipmentId: string, createdBy: string) {
  const shipment = await prisma.shipments.findUnique({
    where: { id: shipmentId, soft_deleted_at: null },
    include: {
      clients: true,
      shipment_line_items: { include: { products: true } },
      outbound_boxes: {
        where: { sub_shipment_id: null, dispatched_at: { not: null } },
      },
    },
  });
  if (!shipment) throw new ApiError("Shipment not found", 404);
  if (shipment.status !== "dispatched" && shipment.status !== "completed") {
    throw new ApiError("Shipment invoice can only be generated after dispatch", 422);
  }

  const quantityByLineItem = contentsQuantityByLineItem(shipment.outbound_boxes);
  const billableItems = shipment.shipment_line_items
    .map((item) => ({
      id: item.id,
      quantity: quantityByLineItem.get(item.id) ?? 0,
      services_selected: item.services_selected,
      service_status: item.service_status,
      products: { sku: item.products.sku },
    }))
    .filter((item) => item.quantity > 0);

  const totalUnits = billableItems.reduce((sum, item) => sum + item.quantity, 0);
  const pricing = await pricingContext(prisma, shipment.client_id, shipment.clients, totalUnits);
  const serviceLines = buildServiceLines({
    items: billableItems,
    shipmentId: shipment.id,
    subShipmentId: null,
    shipmentReference: shipment.reference,
    clientVatRegistered: shipment.clients.vat_registered,
    ...pricing,
    startSortOrder: 1,
  });
  const boxLines = buildBoxLines({
    boxes: shipment.outbound_boxes,
    shipmentId: shipment.id,
    subShipmentId: null,
    shipmentReference: shipment.reference,
    clientVatRegistered: shipment.clients.vat_registered,
    ...pricing,
    startSortOrder: serviceLines.length + 1,
  });
  const lines = [...serviceLines, ...boxLines];
  const totals = totalsFor(lines);
  const now = new Date();
  const { invoiceDate, dueDate } = await finalInvoiceDates(prisma, now);

  return saveDispatchInvoice(prisma, { shipmentId }, invoiceDate, {
    client_id: shipment.client_id,
    shipment_id: shipment.id,
    sub_shipment_id: null,
    invoice_date: invoiceDate,
    due_date: dueDate,
    invoice_type: "shipment",
    subtotal: totals.subtotal,
    vat_amount: totals.vatAmount,
    total: totals.total,
    created_by: createdBy,
  }, lines);
}

export async function ensureSubShipmentDraftInvoice(prisma: Db, subShipmentId: string, createdBy: string) {
  const subShipment = await prisma.sub_shipments.findUnique({
    where: { id: subShipmentId },
    include: {
      shipments: {
        include: { clients: true },
      },
      sub_shipment_items: {
        include: {
          shipment_line_items: {
            include: { products: true },
          },
        },
      },
      outbound_boxes: {
        where: { dispatched_at: { not: null } },
      },
    },
  });
  if (!subShipment) throw new ApiError("Sub-shipment not found", 404);
  if (subShipment.status !== "dispatched" && subShipment.status !== "completed") {
    throw new ApiError("Sub-shipment invoice can only be generated after dispatch", 422);
  }

  const billableItems = subShipment.sub_shipment_items.map((item) => ({
    id: item.shipment_line_item_id,
    quantity: item.quantity,
    services_selected: item.shipment_line_items.services_selected,
    service_status: item.shipment_line_items.service_status,
    products: { sku: item.shipment_line_items.products.sku },
  }));
  const totalUnits = billableItems.reduce((sum, item) => sum + item.quantity, 0);
  const pricing = await pricingContext(prisma, subShipment.shipments.client_id, subShipment.shipments.clients, totalUnits);
  const serviceLines = buildServiceLines({
    items: billableItems,
    shipmentId: subShipment.parent_shipment_id,
    subShipmentId: subShipment.id,
    shipmentReference: subShipment.reference,
    clientVatRegistered: subShipment.shipments.clients.vat_registered,
    ...pricing,
    startSortOrder: 1,
  });
  const boxLines = buildBoxLines({
    boxes: subShipment.outbound_boxes,
    shipmentId: subShipment.parent_shipment_id,
    subShipmentId: subShipment.id,
    shipmentReference: subShipment.reference,
    clientVatRegistered: subShipment.shipments.clients.vat_registered,
    ...pricing,
    startSortOrder: serviceLines.length + 1,
  });
  const lines = [...serviceLines, ...boxLines];
  const totals = totalsFor(lines);
  const now = new Date();
  const { invoiceDate, dueDate } = await finalInvoiceDates(prisma, now);

  return saveDispatchInvoice(prisma, { subShipmentId }, invoiceDate, {
    client_id: subShipment.shipments.client_id,
    shipment_id: subShipment.parent_shipment_id,
    sub_shipment_id: subShipment.id,
    invoice_date: invoiceDate,
    due_date: dueDate,
    invoice_type: "sub_shipment",
    subtotal: totals.subtotal,
    vat_amount: totals.vatAmount,
    total: totals.total,
    created_by: createdBy,
  }, lines);
}
