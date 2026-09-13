import { ApiError } from "@/lib/apiResponse";
import { buildPdfFromPages, loadPdf, scanFnskuPages } from "@/lib/fnskuPdfSplit";
import { prisma } from "@/lib/prisma";
import { bucketFor, supabaseAdmin } from "@/lib/supabase";

type Actor = { userId: string; email: string; role: string };

export type ShipmentLabelSplitResult = {
  sourceFileId: string;
  totalPages: number;
  fnskusInPdf: number;
  split: Array<{ lineItemId: string; sku: string; fnsku: string; labels: number; fileId: string }>;
  skipped: Array<{ lineItemId: string; sku: string; fnsku: string; reason: string }>;
  notInShipment: string[];
  pagesWithoutFnsku: number;
  multiLabelPages: number;
};

function safeFilePart(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60) || "label";
}

// Splits one multi-product FNSKU label PDF into a label file per shipment line, matched by the FNSKU text on each page.
// Storage uploads can't join a DB transaction, so each line is saved independently and failures are reported per line.
export async function splitShipmentLabelPdf(input: {
  shipmentId: string;
  fileId: string;
  overwrite?: boolean;
  actor: Actor;
}): Promise<ShipmentLabelSplitResult> {
  const shipment = await prisma.shipments.findFirst({
    where: { id: input.shipmentId, soft_deleted_at: null },
    select: {
      id: true,
      client_id: true,
      shipment_line_items: {
        select: { id: true, fnsku: true, fnsku_label_file_id: true, products: { select: { sku: true } } },
        orderBy: [{ display_order: "asc" }, { created_at: "asc" }],
      },
    },
  });
  if (!shipment) throw new ApiError("Shipment not found", 404);

  const source = await prisma.uploaded_files.findUnique({ where: { id: input.fileId } });
  if (!source) throw new ApiError("Label file not found", 404);
  if (source.file_type !== "fnsku_label") throw new ApiError("Only FNSKU label files can be split", 422);
  if (source.client_id !== shipment.client_id) throw new ApiError("This label file belongs to a different client", 422);
  const isPdf = source.mime_type === "application/pdf" || source.original_filename.toLowerCase().endsWith(".pdf");
  if (!isPdf) throw new ApiError("Only PDF label files can be split", 422);

  const bucket = bucketFor(source.file_type);
  const download = await supabaseAdmin.storage.from(bucket).download(source.storage_path);
  if (download.error || !download.data) {
    throw new ApiError(`Could not download the label file: ${download.error?.message ?? "empty file"}`, 502);
  }
  const pdfBytes = new Uint8Array(await download.data.arrayBuffer());

  const scan = await scanFnskuPages(pdfBytes);
  if (Object.keys(scan.pagesByFnsku).length === 0) {
    throw new ApiError(
      "No FNSKU codes could be read in this PDF (it may be a scanned image). Open it and print the pages by hand.",
      422,
      { code: "NO_FNSKU_TEXT", totalPages: scan.totalPages },
    );
  }

  const multiLabelPages = new Set(scan.multiLabelPages);
  const pdf = await loadPdf(pdfBytes);
  const shipmentFnskus = new Set<string>();
  const split: ShipmentLabelSplitResult["split"] = [];
  const skipped: ShipmentLabelSplitResult["skipped"] = [];

  for (const item of shipment.shipment_line_items) {
    const fnsku = item.fnsku.trim().toUpperCase();
    const sku = item.products.sku;
    shipmentFnskus.add(fnsku);
    const pages = scan.pagesByFnsku[fnsku];

    if (!pages?.length) {
      skipped.push({ lineItemId: item.id, sku, fnsku, reason: "FNSKU not found in this PDF" });
      continue;
    }
    if (pages.some((page) => multiLabelPages.has(page))) {
      skipped.push({ lineItemId: item.id, sku, fnsku, reason: "Labels are laid out as a sheet; re-download one label per page" });
      continue;
    }
    const hasOtherLabel = item.fnsku_label_file_id && item.fnsku_label_file_id !== source.id;
    if (hasOtherLabel && !input.overwrite) {
      skipped.push({ lineItemId: item.id, sku, fnsku, reason: "Already has its own label file" });
      continue;
    }

    const labelBytes = await buildPdfFromPages(pdf, pages);
    const fileName = `${safeFilePart(sku || fnsku)}-${fnsku}-${pages.length}-labels.pdf`;
    const storagePath = `item/${item.id}/fnsku_label/${Date.now()}-${fileName}`;
    const upload = await supabaseAdmin.storage
      .from(bucket)
      .upload(storagePath, labelBytes, { contentType: "application/pdf", upsert: false });
    if (upload.error) {
      skipped.push({ lineItemId: item.id, sku, fnsku, reason: `Upload failed: ${upload.error.message}` });
      continue;
    }

    const record = await prisma.uploaded_files.create({
      data: {
        uploader_user_id: input.actor.userId,
        client_id: shipment.client_id,
        file_type: "fnsku_label",
        original_filename: fileName,
        storage_path: storagePath,
        file_size_bytes: labelBytes.byteLength,
        mime_type: "application/pdf",
        linked_entity_type: "item",
        linked_entity_id: item.id,
        metadata: { splitFromFileId: source.id, fnsku, sku, pages },
      },
    });
    await prisma.shipment_line_items.update({
      where: { id: item.id },
      data: { fnsku_label_file_id: record.id, updated_at: new Date() },
    });
    split.push({ lineItemId: item.id, sku, fnsku, labels: pages.length, fileId: record.id });
  }

  const result: ShipmentLabelSplitResult = {
    sourceFileId: source.id,
    totalPages: scan.totalPages,
    fnskusInPdf: Object.keys(scan.pagesByFnsku).length,
    split,
    skipped,
    notInShipment: Object.keys(scan.pagesByFnsku).filter((code) => !shipmentFnskus.has(code)),
    pagesWithoutFnsku: scan.pagesWithoutFnsku.length,
    multiLabelPages: scan.multiLabelPages.length,
  };

  await prisma.audit_logs.create({
    data: {
      user_id: input.actor.userId,
      user_email: input.actor.email,
      user_role: input.actor.role,
      action: "fnsku_labels.split",
      entity_type: "shipment",
      entity_id: shipment.id,
      after_value: JSON.parse(JSON.stringify(result)),
    },
  });

  return result;
}
