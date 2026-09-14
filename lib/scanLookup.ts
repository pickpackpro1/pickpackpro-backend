import { Prisma, PrismaClient, ShipmentStatus } from "@prisma/client";
import { bucketFor, supabaseAdmin } from "@/lib/supabase";

export type ScanMode = "receiving" | "packing" | "any";

// Which shipment stages a scan is allowed to touch. The unified scan flow (check quantity,
// then print) uses "any" — every stage where a line item can still be counted or labelled.
const RECEIVING_STATUSES: ShipmentStatus[] = [
  ShipmentStatus.submitted,
  ShipmentStatus.pending_arrival,
  ShipmentStatus.received,
];
const PACKING_STATUSES: ShipmentStatus[] = [
  ShipmentStatus.received,
  ShipmentStatus.in_progress,
  ShipmentStatus.prepped,
];
const ANY_STATUSES: ShipmentStatus[] = [...new Set([...RECEIVING_STATUSES, ...PACKING_STATUSES])];

function statusesForMode(mode: ScanMode) {
  if (mode === "receiving") return RECEIVING_STATUSES;
  if (mode === "packing") return PACKING_STATUSES;
  return ANY_STATUSES;
}

function normalize(value: string | null | undefined) {
  return String(value ?? "").trim().toUpperCase();
}

// UPC-A (12 digits) and EAN-13 with a leading 0 are the same product code.
function numericVariants(code: string) {
  const variants = new Set([code]);
  if (/^\d+$/.test(code)) {
    variants.add(code.replace(/^0+/, "") || "0");
    variants.add(`0${code}`);
  }
  return [...variants];
}

export type ScanMatch = {
  lineItemId: string;
  matchedBy: "barcode" | "FNSKU" | "SKU";
  clientId: string;
  clientName: string;
  shipmentId: string;
  shipmentReference: string;
  productName: string;
  sku: string;
  fnsku: string;
  barcode: string | null;
  expectedQty: number;
  receivedQty: number;
  remainingQty: number;
  dispatchQty: number | null;
  fnskuLabelFileUrl: string | null;
};

// Finds every shipment line, across every client, whose barcode/FNSKU/SKU matches a scanned code —
// so staff can scan a box before knowing whose shipment it belongs to.
export async function lookupScanMatches(prisma: PrismaClient, rawCode: string, mode: ScanMode): Promise<ScanMatch[]> {
  const code = normalize(rawCode);
  if (!code) return [];
  const barcodeVariants = numericVariants(code);
  const statuses = statusesForMode(mode);

  const where: Prisma.shipment_line_itemsWhereInput = {
    shipments: { status: { in: statuses }, soft_deleted_at: null },
    OR: [
      { barcode: { in: barcodeVariants, mode: "insensitive" } },
      { fnsku: { equals: code, mode: "insensitive" } },
      { products: { is: { barcode: { in: barcodeVariants, mode: "insensitive" } } } },
      { products: { is: { sku: { equals: code, mode: "insensitive" } } } },
      { products: { is: { default_fnsku: { equals: code, mode: "insensitive" } } } },
    ],
  };

  const items = await prisma.shipment_line_items.findMany({
    where,
    include: {
      products: true,
      shipments: { include: { clients: true } },
      uploaded_files: true,
    },
  });

  const matches: ScanMatch[] = [];
  for (const item of items) {
    const barcode = item.barcode ?? item.products.barcode ?? null;
    const fnsku = item.fnsku ?? item.products.default_fnsku ?? "";
    const sku = item.products.sku ?? "";

    let matchedBy: ScanMatch["matchedBy"] | null = null;
    if (barcode && barcodeVariants.includes(normalize(barcode))) matchedBy = "barcode";
    else if (normalize(fnsku) === code) matchedBy = "FNSKU";
    else if (normalize(sku) === code) matchedBy = "SKU";
    if (!matchedBy) continue;

    const expectedQty = item.qty_expected ?? 0;
    const receivedQty = item.qty_received ?? 0;

    let fnskuLabelFileUrl: string | null = null;
    if (item.uploaded_files) {
      const { data } = supabaseAdmin.storage
        .from(bucketFor(item.uploaded_files.file_type))
        .getPublicUrl(item.uploaded_files.storage_path);
      fnskuLabelFileUrl = data.publicUrl;
    }

    matches.push({
      lineItemId: item.id,
      matchedBy,
      clientId: item.shipments.client_id,
      clientName: item.shipments.clients.company_name,
      shipmentId: item.shipment_id,
      shipmentReference: item.shipments.reference,
      productName: item.product_name ?? item.products.product_name,
      sku,
      fnsku,
      barcode,
      expectedQty,
      receivedQty,
      remainingQty: Math.max(expectedQty - receivedQty, 0),
      dispatchQty: item.dispatch_qty,
      fnskuLabelFileUrl,
    });
  }

  return matches;
}
