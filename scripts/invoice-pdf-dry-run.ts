import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { renderInvoicePdf } from "../lib/invoicePdf";

const invoice = {
  id: randomUUID(),
  client_id: randomUUID(),
  shipment_id: randomUUID(),
  sub_shipment_id: null,
  invoice_number: "INV-202608-0002",
  invoice_date: new Date("2026-08-05T00:00:00.000Z"),
  due_date: new Date("2026-08-19T00:00:00.000Z"),
  invoice_type: "shipment",
  period_start: null,
  period_end: null,
  status: "sent",
  subtotal: 38,
  vat_amount: 7.6,
  total: 45.6,
  pdf_file_id: null,
  xlsx_file_id: null,
  sent_at: new Date("2026-08-05T10:00:00.000Z"),
  paid_at: null,
  notes: null,
  created_at: new Date("2026-08-05T09:00:00.000Z"),
  created_by: randomUUID(),
  clients: {
    id: randomUUID(),
    company_name: "Example Client Ltd",
    contact_name: "Example Client",
    email: "client@example.com",
    phone: null,
    billing_address: {},
    shipping_address: null,
    vat_registered: true,
    vat_number: null,
    pricing_tier_override: null,
    payment_method: "bank_transfer",
    status: "active",
    created_at: new Date("2026-08-01T00:00:00.000Z"),
    created_by: randomUUID(),
    soft_deleted_at: null,
  },
  invoice_line_items: [
    {
      id: randomUUID(),
      invoice_id: randomUUID(),
      shipment_id: randomUUID(),
      sub_shipment_id: null,
      shipment_line_item_id: randomUUID(),
      service_code: "fnsku_label",
      description: "FNSKU Labelling - SKU sku_1 - Shipment SHP-20260805-0001",
      qty: 12,
      unit_rate: 0.28,
      amount: 3.36,
      vat_rate: 0.2,
      vat_amount: 0.672,
      line_source: "system",
      sort_order: 1,
      source_key: "shipment:test:service:item:fnsku_label",
      metadata: {},
      is_overridden: false,
      is_suppressed: false,
    },
    {
      id: randomUUID(),
      invoice_id: randomUUID(),
      shipment_id: randomUUID(),
      sub_shipment_id: null,
      shipment_line_item_id: null,
      service_code: "medium_box",
      description: "Medium Box - Shipment SHP-20260805-0001",
      qty: 2,
      unit_rate: 2.5,
      amount: 5,
      vat_rate: 0.2,
      vat_amount: 1,
      line_source: "system",
      sort_order: 2,
      source_key: "shipment:test:box_service:medium_box",
      metadata: {},
      is_overridden: true,
      is_suppressed: false,
    },
  ],
};

const settings = {
  company_name: "Pick Pack Pro Ltd",
  vat_number: "GB123456789",
  company_address: {
    address: "Unit 36 Tanners Drive Blakelands Milton Keynes MK14 5BN",
  },
  invoice_payment_terms_days: 14,
  bank_details: {
    bankName: "Revolut Bank",
    sortCode: "04-29-09",
    accountNumber: "98104667",
  },
};

const pdf = renderInvoicePdf(invoice as any, settings);
const content = pdf.toString("latin1");

assert(content.startsWith("%PDF-1.4"));
for (const expected of [
  "Pick Pack Pro Ltd",
  "GB123456789",
  "Unit 36 Tanners Drive Blakelands Milton",
  "Keynes MK14 5BN",
  "Payment Terms: 14 days",
  "Revolut Bank",
  "04-29-09",
  "98104667",
  "FNSKU Labelling",
  "Medium Box",
]) {
  assert(content.includes(expected), `Expected PDF to include: ${expected}`);
}

assert(!content.includes("48-01-82"));
assert(!content.includes("Account: 12345678"));
assert(!content.includes("pickpackpro.co.uk"));

console.log(JSON.stringify({ ok: true, bytes: pdf.length, contentType: "application/pdf" }, null, 2));
