import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ensureShipmentDraftInvoice } from "../lib/invoicing";

type JsonRecord = Record<string, unknown>;

type ClientRecord = {
  id: string;
  company_name: string;
  vat_registered: boolean;
  pricing_tier_override: string | null;
};

type ShipmentLineRecord = {
  id: string;
  shipment_id: string;
  product_id: string;
  qty_expected: number;
  qty_received: number | null;
  dispatch_qty: number | null;
  qty_discrepancy_flag: boolean;
  services_selected: string[];
  service_status: JsonRecord;
  products: { id: string; sku: string };
};

type BoxRecord = {
  id: string;
  shipment_id: string;
  sub_shipment_id: string | null;
  box_number: number;
  box_type: string;
  box_size: string | null;
  contents: JsonRecord[];
  dispatched_at: Date | null;
};

type InvoiceRecord = {
  id: string;
  client_id: string;
  shipment_id: string | null;
  sub_shipment_id: string | null;
  invoice_number: string;
  invoice_date: Date;
  due_date: Date;
  invoice_type: string;
  status: string;
  subtotal: number;
  vat_amount: number;
  total: number;
  created_by: string;
  created_at: Date;
  sent_at: Date | null;
  paid_at: Date | null;
  pdf_file_id: string | null;
  xlsx_file_id: string | null;
};

type InvoiceLineRecord = {
  id: string;
  invoice_id: string;
  shipment_id: string | null;
  sub_shipment_id: string | null;
  shipment_line_item_id: string | null;
  service_code: string;
  description: string;
  qty: number;
  unit_rate: number;
  amount: number;
  vat_rate: number;
  vat_amount: number;
  line_source: string;
  sort_order: number;
};

type InvoiceLineLike = {
  line_source: string;
  shipment_line_item_id: string | null;
  service_code: string;
  qty: unknown;
  amount: unknown;
  vat_amount: unknown;
};

type InvoiceLike = {
  subtotal: unknown;
  vat_amount: unknown;
  total: unknown;
  invoice_line_items: InvoiceLineLike[];
};

function lineQuantity(invoice: InvoiceLike, lineItemId: string) {
  return invoice.invoice_line_items
    .filter((line) => line.line_source === "system" && line.shipment_line_item_id === lineItemId && line.service_code === "fnsku_label")
    .reduce((sum, line) => sum + Number(line.qty), 0);
}

function serviceQuantity(invoice: InvoiceLike, serviceCode: string) {
  return invoice.invoice_line_items
    .filter((line) => line.line_source === "system" && line.service_code === serviceCode)
    .reduce((sum, line) => sum + Number(line.qty), 0);
}

function assertTotals(invoice: InvoiceLike) {
  const subtotal = invoice.invoice_line_items.reduce((sum, line) => sum + Number(line.amount), 0);
  const vatAmount = invoice.invoice_line_items.reduce((sum, line) => sum + Number(line.vat_amount), 0);
  assert.equal(Number(invoice.subtotal), subtotal);
  assert.equal(Number(invoice.vat_amount), vatAmount);
  assert.equal(Number(invoice.total), subtotal + vatAmount);
}

class InvoiceRefreshDryRunDb {
  readonly clientId = randomUUID();
  readonly shipmentId = randomUUID();
  readonly userId = randomUUID();
  readonly lineItemIds = [randomUUID(), randomUUID(), randomUUID()];
  readonly clients: ClientRecord[] = [
    {
      id: this.clientId,
      company_name: "Dry Run Client",
      vat_registered: false,
      pricing_tier_override: null,
    },
  ];
  readonly shipmentLineItems: ShipmentLineRecord[] = this.lineItemIds.map((id, index) => ({
    id,
    shipment_id: this.shipmentId,
    product_id: randomUUID(),
    qty_expected: 12,
    qty_received: [6, 4, 12][index],
    dispatch_qty: [6, 4, 12][index],
    qty_discrepancy_flag: index < 2,
    services_selected: ["fnsku_label"],
    service_status: { fnsku_label: "DONE" },
    products: { id: randomUUID(), sku: `sku_${index + 1}` },
  }));
  readonly boxes: BoxRecord[] = [
    {
      id: randomUUID(),
      shipment_id: this.shipmentId,
      sub_shipment_id: null,
      box_number: 1,
      box_type: "box",
      box_size: "medium",
      dispatched_at: new Date("2026-08-05T09:00:00.000Z"),
      contents: [
        { shipmentItemId: this.lineItemIds[0], quantity: 6 },
        { shipmentItemId: this.lineItemIds[1], quantity: 4 },
        { shipmentItemId: this.lineItemIds[2], quantity: 12 },
      ],
    },
  ];
  readonly invoicesStore: InvoiceRecord[] = [];
  readonly invoiceLines: InvoiceLineRecord[] = [];

  readonly app_settings = {
    findFirst: async () => ({ invoice_payment_terms_days: 14 }),
  };

  readonly service_catalog = {
    findMany: async () => [
      {
        code: "fnsku_label",
        display_name: "FNSKU Labelling",
        default_tier_pricing: { silver: 1, gold: 1, platinum: 1 },
        vat_applicable: false,
      },
      {
        code: "medium_box",
        display_name: "Medium Box",
        default_tier_pricing: { rate: 2 },
        vat_applicable: false,
      },
    ],
  };

  readonly client_price_lists = {
    findMany: async () => [],
  };

  readonly shipments = {
    findUnique: async (args: any) => {
      if (args.where.id !== this.shipmentId) return null;
      if (args.where.soft_deleted_at !== undefined && args.where.soft_deleted_at !== null) return null;
      const client = this.clients[0];
      return {
        id: this.shipmentId,
        client_id: this.clientId,
        reference: "SHP-20260805-0001",
        status: "dispatched",
        clients: client,
        shipment_line_items: this.shipmentLineItems,
        outbound_boxes: this.boxes.filter((box) => box.sub_shipment_id === null && box.dispatched_at !== null),
      };
    },
  };

  readonly invoices = {
    findMany: async (args: any) => {
      const startsWith = args.where?.invoice_number?.startsWith;
      const rows = startsWith
        ? this.invoicesStore.filter((invoice) => invoice.invoice_number.startsWith(startsWith))
        : this.invoicesStore;
      if (args.select?.invoice_number) return rows.map((invoice) => ({ invoice_number: invoice.invoice_number }));
      return rows;
    },
    findFirst: async (args: any) => {
      const invoice = this.invoicesStore.find(
        (row) =>
          row.shipment_id === args.where.shipment_id &&
          row.sub_shipment_id === args.where.sub_shipment_id &&
          row.invoice_type === args.where.invoice_type &&
          row.status !== args.where.status?.not,
      );
      return invoice ? this.serializeInvoice(invoice) : null;
    },
    create: async (args: any) => {
      const invoice: InvoiceRecord = {
        id: randomUUID(),
        client_id: args.data.client_id,
        shipment_id: args.data.shipment_id ?? null,
        sub_shipment_id: args.data.sub_shipment_id ?? null,
        invoice_number: args.data.invoice_number,
        invoice_date: args.data.invoice_date,
        due_date: args.data.due_date,
        invoice_type: args.data.invoice_type,
        status: args.data.status ?? "draft",
        subtotal: args.data.subtotal,
        vat_amount: args.data.vat_amount,
        total: args.data.total,
        created_by: args.data.created_by,
        created_at: new Date(),
        sent_at: null,
        paid_at: null,
        pdf_file_id: null,
        xlsx_file_id: null,
      };
      this.invoicesStore.push(invoice);
      for (const line of args.data.invoice_line_items?.create ?? []) {
        this.invoiceLines.push({ id: randomUUID(), invoice_id: invoice.id, ...line });
      }
      return this.serializeInvoice(invoice);
    },
    update: async (args: any) => {
      const invoice = this.invoicesStore.find((row) => row.id === args.where.id);
      assert(invoice, "Invoice not found in dry-run fake DB");
      Object.assign(invoice, args.data);
      return this.serializeInvoice(invoice);
    },
  };

  readonly invoice_line_items = {
    deleteMany: async (args: any) => {
      const before = this.invoiceLines.length;
      for (let index = this.invoiceLines.length - 1; index >= 0; index--) {
        const line = this.invoiceLines[index];
        if (line.invoice_id === args.where.invoice_id && line.line_source === args.where.line_source) {
          this.invoiceLines.splice(index, 1);
        }
      }
      return { count: before - this.invoiceLines.length };
    },
    createMany: async (args: any) => {
      for (const line of args.data) {
        this.invoiceLines.push({ id: randomUUID(), ...line });
      }
      return { count: args.data.length };
    },
    update: async (args: any) => {
      const line = this.invoiceLines.find((row) => row.id === args.where.id);
      assert(line, "Invoice line not found in dry-run fake DB");
      Object.assign(line, args.data);
      return line;
    },
  };

  async $executeRaw() {
    return 0;
  }

  addManualLine(invoiceId: string) {
    this.invoiceLines.push({
      id: randomUUID(),
      invoice_id: invoiceId,
      shipment_id: this.shipmentId,
      sub_shipment_id: null,
      shipment_line_item_id: null,
      service_code: "manual_adjustment",
      description: "Manual adjustment preserved by dry-run",
      qty: 1,
      unit_rate: 7,
      amount: 7,
      vat_rate: 0,
      vat_amount: 0,
      line_source: "manual",
      sort_order: 99,
    });
  }

  resolveDiscrepancyAndDispatchSecondBox() {
    this.shipmentLineItems[0].qty_received = 12;
    this.shipmentLineItems[0].dispatch_qty = 12;
    this.shipmentLineItems[0].qty_discrepancy_flag = false;
    this.shipmentLineItems[1].qty_received = 12;
    this.shipmentLineItems[1].dispatch_qty = 12;
    this.shipmentLineItems[1].qty_discrepancy_flag = false;
    this.boxes.push({
      id: randomUUID(),
      shipment_id: this.shipmentId,
      sub_shipment_id: null,
      box_number: 2,
      box_type: "box",
      box_size: "medium",
      dispatched_at: new Date("2026-08-06T09:00:00.000Z"),
      contents: [
        { shipmentItemId: this.lineItemIds[0], quantity: 6 },
        { shipmentItemId: this.lineItemIds[1], quantity: 8 },
      ],
    });
  }

  private serializeInvoice(invoice: InvoiceRecord) {
    const client = this.clients.find((row) => row.id === invoice.client_id) ?? null;
    const invoiceLineItems = this.invoiceLines
      .filter((line) => line.invoice_id === invoice.id)
      .sort((a, b) => a.sort_order - b.sort_order);
    return { ...invoice, clients: client, invoice_line_items: invoiceLineItems };
  }
}

async function main() {
  const db = new InvoiceRefreshDryRunDb();

  const firstInvoice = await ensureShipmentDraftInvoice(db as any, db.shipmentId, db.userId);
  assert.equal(lineQuantity(firstInvoice, db.lineItemIds[0]), 6);
  assert.equal(lineQuantity(firstInvoice, db.lineItemIds[1]), 4);
  assert.equal(lineQuantity(firstInvoice, db.lineItemIds[2]), 12);
  assert.equal(serviceQuantity(firstInvoice, "medium_box"), 1);
  assertTotals(firstInvoice);

  db.addManualLine(firstInvoice.id);
  await db.invoices.update({ where: { id: firstInvoice.id }, data: { status: "sent", sent_at: new Date() } });
  db.resolveDiscrepancyAndDispatchSecondBox();

  const refreshedInvoice = await ensureShipmentDraftInvoice(db as any, db.shipmentId, db.userId);
  assert.equal(refreshedInvoice.id, firstInvoice.id);
  assert.equal(refreshedInvoice.status, "sent");
  assert.equal(lineQuantity(refreshedInvoice, db.lineItemIds[0]), 12);
  assert.equal(lineQuantity(refreshedInvoice, db.lineItemIds[1]), 12);
  assert.equal(lineQuantity(refreshedInvoice, db.lineItemIds[2]), 12);
  assert.equal(serviceQuantity(refreshedInvoice, "medium_box"), 2);
  assert.equal(refreshedInvoice.invoice_line_items.filter((line) => line.line_source === "manual").length, 1);
  assert.equal(refreshedInvoice.invoice_line_items.filter((line) => line.line_source === "system").length, 5);
  assertTotals(refreshedInvoice);

  console.log(
    JSON.stringify(
      {
        ok: true,
        scenario: "partial dispatch invoice refresh",
        invoiceId: refreshedInvoice.id,
        status: refreshedInvoice.status,
        quantities: {
          sku_1: lineQuantity(refreshedInvoice, db.lineItemIds[0]),
          sku_2: lineQuantity(refreshedInvoice, db.lineItemIds[1]),
          sku_3: lineQuantity(refreshedInvoice, db.lineItemIds[2]),
          medium_box: serviceQuantity(refreshedInvoice, "medium_box"),
        },
        subtotal: refreshedInvoice.subtotal,
        vatAmount: refreshedInvoice.vat_amount,
        total: refreshedInvoice.total,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
