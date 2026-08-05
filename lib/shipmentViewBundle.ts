import { BoxType, Prisma } from "@prisma/client";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { boxNumberResponseFields, displayBoxTitle } from "@/lib/boxNumbers";
import { normalizeServiceCode } from "@/lib/businessLogic";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { serializeUploadedFile } from "@/lib/shipmentContract";
import { serializeShipmentNoteAttachments } from "@/lib/shipmentNoteAttachments";
import { getSubShipmentAvailability } from "@/lib/subShipments";

type JsonRecord = Record<string, any>;
type ViewMode = "quick" | "detail";
type SerializedFile = JsonRecord;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: unknown) {
  return UUID_RE.test(String(value ?? "").trim());
}

function firstPresent(...values: unknown[]) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "");
}

function numberValue(value: unknown, fallback = 0) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? number : fallback;
}

function jsonArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? (value.filter((item) => item && typeof item === "object") as JsonRecord[]) : [];
}

function jsonObject(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

function humanize(value: string) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function serializeProduct(product: JsonRecord | null | undefined) {
  if (!product) return null;
  return {
    ...product,
    productName: product.product_name,
    product_name: product.product_name,
    defaultFnsku: product.default_fnsku,
    default_fnsku: product.default_fnsku,
    defaultFnskuLabelFileId: product.default_fnsku_label_file_id,
    default_fnsku_label_file_id: product.default_fnsku_label_file_id,
    needsBundling: product.needs_bundling,
    needs_bundling: product.needs_bundling,
    bundleSize: product.bundle_size,
    bundle_size: product.bundle_size,
    clientId: product.client_id,
    client_id: product.client_id,
  };
}

function serializeUser(user: JsonRecord | null | undefined) {
  if (!user) return null;
  return {
    ...user,
    fullName: user.full_name,
    full_name: user.full_name,
    clientId: user.client_id,
    client_id: user.client_id,
    createdAt: user.created_at,
    created_at: user.created_at,
    lastLoginAt: user.last_login_at,
    last_login_at: user.last_login_at,
  };
}

function entityKey(entityType: string | null | undefined, entityId: string | null | undefined) {
  return `${String(entityType || "").trim()}:${String(entityId || "").trim()}`;
}

function serializeFile(file: unknown): SerializedFile | null {
  const serialized = serializeUploadedFile(file) as JsonRecord | null;
  if (!serialized) return null;
  const id = serialized.id ?? serialized.fileId ?? serialized.file_id;
  return {
    ...serialized,
    id,
    fileId: serialized.fileId,
    file_id: serialized.file_id,
    fileName: serialized.fileName,
    file_name: serialized.file_name,
    originalFilename: serialized.originalFilename,
    original_filename: serialized.original_filename,
    publicUrl: serialized.publicUrl,
    public_url: serialized.public_url,
    url: serialized.url,
  };
}

function buildFileIndex(files: unknown[]) {
  const serializedByKey = new Map<string, SerializedFile>();
  for (const rawFile of files) {
    const file = serializeFile(rawFile);
    if (!file) continue;
    const key = String(
      firstPresent(
        file.id,
        file.fileId,
        file.file_id,
        file.storagePath,
        file.storage_path,
        `${file.linked_entity_type ?? file.entity_type}:${file.linked_entity_id ?? file.entity_id}:${file.original_filename ?? file.fileName ?? ""}`,
      ),
    );
    if (!serializedByKey.has(key)) serializedByKey.set(key, file);
  }
  const serialized = [...serializedByKey.values()];
  const filesById = new Map<string, SerializedFile>();
  const filesByEntity = new Map<string, SerializedFile[]>();

  for (const file of serialized) {
    filesById.set(String(file.id), file);
    filesById.set(String(file.fileId), file);
    const key = entityKey(file.linked_entity_type ?? file.entity_type, file.linked_entity_id ?? file.entity_id);
    if (key !== ":") {
      filesByEntity.set(key, [...(filesByEntity.get(key) ?? []), file]);
    }
  }

  for (const [key, entityFiles] of filesByEntity) {
    filesByEntity.set(
      key,
      [...entityFiles].sort(
        (left, right) => new Date(right.uploaded_at ?? right.uploadedAt ?? 0).getTime() - new Date(left.uploaded_at ?? left.uploadedAt ?? 0).getTime(),
      ),
    );
  }

  return { files: serialized, filesById, filesByEntity };
}

function fileForEntity(
  fileIndex: ReturnType<typeof buildFileIndex>,
  entityTypes: string[],
  entityId: string | null | undefined,
  fileType?: string,
  directFileId?: string | null,
) {
  const directFile = directFileId ? fileIndex.filesById.get(directFileId) : null;
  if (directFile && (!fileType || directFile.file_type === fileType || directFile.fileType === fileType)) return directFile;

  for (const entityType of entityTypes) {
    const files = fileIndex.filesByEntity.get(entityKey(entityType, entityId)) ?? [];
    const match = files.find((file) => !fileType || file.file_type === fileType || file.fileType === fileType);
    if (match) return match;
  }

  return null;
}

function contentItemId(content: JsonRecord) {
  return String(
    firstPresent(
      content.shipmentItemId,
      content.shipment_item_id,
      content.shipmentLineItemId,
      content.shipment_line_item_id,
      content.lineItemId,
      content.line_item_id,
      content.itemId,
      content.item_id,
    ) ?? "",
  ).trim();
}

function contentQuantity(content: JsonRecord) {
  return numberValue(firstPresent(content.quantity, content.qty, content.qtyPacked, content.qty_packed, content.units));
}

function serializeBoxContents(contents: unknown, lineItemsById: Map<string, JsonRecord>) {
  return jsonArray(contents).map((content, index) => {
    const lineItemId = contentItemId(content);
    const lineItem = lineItemId ? lineItemsById.get(lineItemId) : null;
    const product = lineItem?.products ?? {};
    const qty = contentQuantity(content);

    return {
      id: firstPresent(content.id, `${lineItemId || "content"}-${index}`),
      shipmentItemId: lineItemId || null,
      shipment_item_id: lineItemId || null,
      lineItemId: lineItemId || null,
      line_item_id: lineItemId || null,
      sku: String(firstPresent(content.sku, product.sku) ?? ""),
      productName: String(firstPresent(content.productName, content.product_name, lineItem?.product_name, product.product_name) ?? ""),
      product_name: String(firstPresent(content.product_name, content.productName, lineItem?.product_name, product.product_name) ?? ""),
      fnsku: String(firstPresent(content.fnsku, content.fnskuLabel, content.fnsku_label, lineItem?.fnsku, product.default_fnsku) ?? ""),
      quantity: qty,
      qty,
    };
  });
}

function aggregateContents(contentGroups: ReturnType<typeof serializeBoxContents>[]) {
  const byKey = new Map<string, ReturnType<typeof serializeBoxContents>[number]>();

  for (const content of contentGroups.flat()) {
    const key = String(content.shipmentItemId || content.sku || content.productName || byKey.size);
    const existing = byKey.get(key);
    if (existing) {
      existing.quantity += content.quantity;
      existing.qty = existing.quantity;
    } else {
      byKey.set(key, { ...content });
    }
  }

  return [...byKey.values()];
}

function dimensions(box: JsonRecord) {
  return {
    l: numberValue(box.length_cm),
    w: numberValue(box.width_cm),
    h: numberValue(box.height_cm),
  };
}

function boxScope(box: JsonRecord) {
  return box.sub_shipment_id ? "sub_shipment" : "parent_shipment";
}

function boxPalletNumber(box: JsonRecord) {
  const value = firstPresent(box.pallet_number, box.palletNumber);
  return value === undefined || value === null ? null : String(value);
}

function labelStatusForBox(box: JsonRecord, labelFile: SerializedFile | null) {
  if (box.fba_shipping_label_file_id || labelFile) return "uploaded";
  return box.box_type === BoxType.pallet ? "missing_optional" : "missing";
}

function serializeChildBox(
  box: JsonRecord,
  lineItemsById: Map<string, JsonRecord>,
  fileIndex: ReturnType<typeof buildFileIndex>,
) {
  const labelFile = fileForEntity(fileIndex, ["box", "outbound_box"], box.id, "fba_shipping_label", box.fba_shipping_label_file_id);
  const contents = serializeBoxContents(box.contents, lineItemsById);
  const labelStatus = labelStatusForBox(box, labelFile);
  const subShipment = box.sub_shipments ?? null;
  const parentPalletNumber = boxPalletNumber(box.pallet ?? {});

  return {
    id: box.id,
    boxId: box.id,
    box_id: box.id,
    ...boxNumberResponseFields(box),
    palletNumber: boxPalletNumber(box),
    pallet_number: boxPalletNumber(box),
    parentPalletNumber,
    parent_pallet_number: parentPalletNumber,
    boxType: box.box_type,
    box_type: box.box_type,
    size: box.box_size,
    boxSize: box.box_size,
    box_size: box.box_size,
    dimensions: dimensions(box),
    lengthCm: numberValue(box.length_cm),
    length_cm: numberValue(box.length_cm),
    widthCm: numberValue(box.width_cm),
    width_cm: numberValue(box.width_cm),
    heightCm: numberValue(box.height_cm),
    height_cm: numberValue(box.height_cm),
    weight: numberValue(box.weight_kg),
    weightKg: numberValue(box.weight_kg),
    weight_kg: numberValue(box.weight_kg),
    status: box.dispatched_at ? "dispatched" : null,
    shipmentId: box.shipment_id,
    shipment_id: box.shipment_id,
    subShipmentId: box.sub_shipment_id,
    sub_shipment_id: box.sub_shipment_id,
    subShipmentReference: subShipment?.reference ?? null,
    sub_shipment_reference: subShipment?.reference ?? null,
    scope: boxScope(box),
    palletId: box.pallet_id,
    pallet_id: box.pallet_id,
    insidePallet: Boolean(box.pallet_id),
    inside_pallet: Boolean(box.pallet_id),
    isPallet: false,
    is_pallet: false,
    fbaLabelFileId: box.fba_shipping_label_file_id ?? labelFile?.fileId ?? null,
    fba_label_file_id: box.fba_shipping_label_file_id ?? labelFile?.fileId ?? null,
    fbaShippingLabelFileId: box.fba_shipping_label_file_id,
    fba_shipping_label_file_id: box.fba_shipping_label_file_id,
    fbaLabelUploaded: labelStatus === "uploaded",
    fba_label_uploaded: labelStatus === "uploaded",
    labelStatus,
    label_status: labelStatus,
    fbaLabelFile: labelFile,
    fba_label_file: labelFile,
    labelUploadedAt: box.label_uploaded_at,
    label_uploaded_at: box.label_uploaded_at,
    dispatchedAt: box.dispatched_at,
    dispatched_at: box.dispatched_at,
    contents,
    boxContents: contents,
    box_contents: contents,
    items: contents,
    boxItems: contents,
    box_items: contents,
  };
}

function serializeBox(
  box: JsonRecord,
  childrenByPalletId: Map<string, JsonRecord[]>,
  lineItemsById: Map<string, JsonRecord>,
  fileIndex: ReturnType<typeof buildFileIndex>,
) {
  const isPallet = box.box_type === BoxType.pallet;
  const labelFile = fileForEntity(
    fileIndex,
    isPallet ? ["pallet", "box", "outbound_box"] : ["box", "outbound_box"],
    box.id,
    "fba_shipping_label",
    box.fba_shipping_label_file_id,
  );
  const childBoxes = (childrenByPalletId.get(box.id) ?? []).map((childBox) => serializeChildBox(childBox, lineItemsById, fileIndex));
  const contents = isPallet
    ? aggregateContents(childBoxes.map((childBox) => childBox.contents))
    : serializeBoxContents(box.contents, lineItemsById);
  const labelStatus = labelStatusForBox(box, labelFile);
  const subShipment = box.sub_shipments ?? null;
  const palletNumber = boxPalletNumber(box);

  return {
    id: box.id,
    boxId: box.id,
    box_id: box.id,
    ...boxNumberResponseFields(box),
    palletNumber,
    pallet_number: palletNumber,
    title: displayBoxTitle(box),
    boxType: box.box_type,
    box_type: box.box_type,
    size: box.box_size,
    boxSize: box.box_size,
    box_size: box.box_size,
    dimensions: dimensions(box),
    lengthCm: numberValue(box.length_cm),
    length_cm: numberValue(box.length_cm),
    widthCm: numberValue(box.width_cm),
    width_cm: numberValue(box.width_cm),
    heightCm: numberValue(box.height_cm),
    height_cm: numberValue(box.height_cm),
    weight: numberValue(box.weight_kg),
    weightKg: numberValue(box.weight_kg),
    weight_kg: numberValue(box.weight_kg),
    status: box.dispatched_at ? "dispatched" : null,
    shipmentId: box.shipment_id,
    shipment_id: box.shipment_id,
    subShipmentId: box.sub_shipment_id,
    sub_shipment_id: box.sub_shipment_id,
    subShipmentReference: subShipment?.reference ?? null,
    sub_shipment_reference: subShipment?.reference ?? null,
    scope: boxScope(box),
    palletId: box.pallet_id,
    pallet_id: box.pallet_id,
    insidePallet: Boolean(box.pallet_id),
    inside_pallet: Boolean(box.pallet_id),
    isPallet,
    is_pallet: isPallet,
    canDispatchDirectly: !box.pallet_id,
    can_dispatch_directly: !box.pallet_id,
    fbaLabelFileId: box.fba_shipping_label_file_id ?? labelFile?.fileId ?? null,
    fba_label_file_id: box.fba_shipping_label_file_id ?? labelFile?.fileId ?? null,
    fbaShippingLabelFileId: box.fba_shipping_label_file_id,
    fba_shipping_label_file_id: box.fba_shipping_label_file_id,
    fbaLabelUploaded: labelStatus === "uploaded",
    fba_label_uploaded: labelStatus === "uploaded",
    labelStatus,
    label_status: labelStatus,
    fbaLabelFile: labelFile,
    fba_label_file: labelFile,
    labelUploadedAt: box.label_uploaded_at,
    label_uploaded_at: box.label_uploaded_at,
    dispatchedAt: box.dispatched_at,
    dispatched_at: box.dispatched_at,
    createdAt: box.created_at,
    created_at: box.created_at,
    childBoxCount: childBoxes.length,
    child_box_count: childBoxes.length,
    childBoxes,
    child_boxes: childBoxes,
    contents,
    boxContents: contents,
    box_contents: contents,
    items: contents,
    boxItems: contents,
    box_items: contents,
  };
}

function serializeLineItem(item: JsonRecord, index: number, fileIndex: ReturnType<typeof buildFileIndex>) {
  const product: JsonRecord = serializeProduct(item.products) ?? {};
  const services = stringArray(item.services_selected);
  const serviceStatus = jsonObject(item.service_status);
  const customServices = jsonArray(item.custom_services);
  const bundleSize = numberValue(firstPresent(item.bundle_size, product.bundle_size, 1), 1);
  const productName = String(firstPresent(item.product_name, product.product_name) ?? "");
  const labelFile = fileForEntity(
    fileIndex,
    ["item", "label", "shipment_line_item"],
    item.id,
    "fnsku_label",
    item.fnsku_label_file_id,
  );

  return {
    id: item.id,
    shipmentItemId: item.id,
    shipment_item_id: item.id,
    lineItemId: item.id,
    line_item_id: item.id,
    shipmentId: item.shipment_id,
    shipment_id: item.shipment_id,
    productId: item.product_id,
    product_id: item.product_id,
    product,
    products: product,
    productName,
    product_name: productName,
    sku: product.sku ?? "",
    fnsku: item.fnsku,
    fnskuLabel: item.fnsku,
    fnsku_label: item.fnsku,
    expectedQty: item.qty_expected,
    expected_qty: item.qty_expected,
    qtyExpected: item.qty_expected,
    qty_expected: item.qty_expected,
    receivedQty: item.qty_received,
    received_qty: item.qty_received,
    qtyReceived: item.qty_received,
    qty_received: item.qty_received,
    dispatchQty: item.dispatch_qty,
    dispatch_qty: item.dispatch_qty,
    needsBundling: Boolean(item.needs_bundling ?? product.needs_bundling),
    needs_bundling: Boolean(item.needs_bundling ?? product.needs_bundling),
    bundleSize,
    bundle_size: bundleSize,
    displayOrder: item.display_order ?? index,
    display_order: item.display_order ?? index,
    services,
    servicesSelected: services,
    services_selected: services,
    serviceStatus,
    service_status: serviceStatus,
    customServices,
    custom_services: customServices,
    expiryDate: item.expiry_date,
    expiry_date: item.expiry_date,
    lotNumber: item.lot_number,
    lot_number: item.lot_number,
    discrepancyFlag: item.qty_discrepancy_flag,
    discrepancy_flag: item.qty_discrepancy_flag,
    qtyDiscrepancyFlag: item.qty_discrepancy_flag,
    qty_discrepancy_flag: item.qty_discrepancy_flag,
    discrepancyNotes: item.discrepancy_notes,
    discrepancy_notes: item.discrepancy_notes,
    fnskuLabelFileId: item.fnsku_label_file_id ?? labelFile?.fileId ?? null,
    fnsku_label_file_id: item.fnsku_label_file_id ?? labelFile?.fileId ?? null,
    fnskuLabelFile: labelFile,
    fnsku_label_file: labelFile,
    createdAt: item.created_at,
    created_at: item.created_at,
    updatedAt: item.updated_at,
    updated_at: item.updated_at,
  };
}

function buildServiceTasks(lineItems: JsonRecord[], catalogByCode: Map<string, JsonRecord>) {
  return lineItems.flatMap((item) => {
    const product: JsonRecord = serializeProduct(item.products) ?? {};
    const productName = String(firstPresent(item.product_name, product.product_name) ?? "");
    const selected = stringArray(item.services_selected);
    const statuses = jsonObject(item.service_status);

    return selected.map((service) => {
      const serviceCode = normalizeServiceCode(service);
      const catalogRow = catalogByCode.get(serviceCode);
      const status = String(firstPresent(statuses[service], statuses[serviceCode], "PENDING"));
      const unitsDone = numberValue(firstPresent(statuses[`${service}:unitsDone`], statuses[`${serviceCode}:unitsDone`]));

      return {
        id: `${item.id}:${service}`,
        taskId: `${item.id}:${service}`,
        task_id: `${item.id}:${service}`,
        shipmentItemId: item.id,
        shipment_item_id: item.id,
        lineItemId: item.id,
        line_item_id: item.id,
        serviceType: service,
        service_type: service,
        serviceCode,
        service_code: serviceCode,
        serviceLabel: catalogRow?.display_name ?? humanize(serviceCode || service),
        service_label: catalogRow?.display_name ?? humanize(serviceCode || service),
        status,
        unitsDone,
        units_done: unitsDone,
        staffId: firstPresent(statuses[`${service}:staffId`], statuses[`${serviceCode}:staffId`]) ?? null,
        staff_id: firstPresent(statuses[`${service}:staffId`], statuses[`${serviceCode}:staffId`]) ?? null,
        startedAt: firstPresent(statuses[`${service}:startedAt`], statuses[`${serviceCode}:startedAt`]) ?? null,
        started_at: firstPresent(statuses[`${service}:startedAt`], statuses[`${serviceCode}:startedAt`]) ?? null,
        completedAt: firstPresent(statuses[`${service}:completedAt`], statuses[`${serviceCode}:completedAt`]) ?? null,
        completed_at: firstPresent(statuses[`${service}:completedAt`], statuses[`${serviceCode}:completedAt`]) ?? null,
        notes: firstPresent(statuses[`${service}:notes`], statuses[`${serviceCode}:notes`]) ?? null,
        product,
        products: product,
        sku: product.sku ?? "",
        productSku: product.sku ?? "",
        product_sku: product.sku ?? "",
        productName,
        product_name: productName,
      };
    });
  });
}

function buildCustomServices(lineItems: JsonRecord[]) {
  return lineItems.flatMap((item) =>
    jsonArray(item.custom_services).map((service, index) => ({
      id: firstPresent(service.id, `${item.id}:custom:${index}`),
      shipmentItemId: item.id,
      shipment_item_id: item.id,
      lineItemId: item.id,
      line_item_id: item.id,
      serviceType: "custom",
      service_type: "custom",
      serviceCode: "custom",
      service_code: "custom",
      serviceLabel: String(firstPresent(service.name, service.label, service.serviceLabel, "Custom Service")),
      service_label: String(firstPresent(service.name, service.label, service.service_label, "Custom Service")),
      status: String(firstPresent(service.status, "PENDING")),
      price: service.price ?? null,
      notes: service.notes ?? null,
    })),
  );
}

function buildDiscrepancies(lineItems: JsonRecord[]) {
  return lineItems
    .filter((item) => Boolean(item.qty_discrepancy_flag))
    .map((item) => {
      const product: JsonRecord = serializeProduct(item.products) ?? {};
      const productName = String(firstPresent(item.product_name, product.product_name) ?? "");
      const expectedQty = numberValue(item.qty_expected);
      const receivedQty = numberValue(item.qty_received);
      const differenceQty = receivedQty - expectedQty;

      return {
        id: item.id,
        shipmentItemId: item.id,
        shipment_item_id: item.id,
        lineItemId: item.id,
        line_item_id: item.id,
        productId: item.product_id,
        product_id: item.product_id,
        sku: product.sku ?? "",
        productName,
        product_name: productName,
        fnsku: item.fnsku,
        expectedQty,
        expected_qty: expectedQty,
        receivedQty,
        received_qty: receivedQty,
        differenceQty,
        difference_qty: differenceQty,
        quantityDifference: differenceQty,
        quantity_difference: differenceQty,
        notes: item.discrepancy_notes,
        discrepancyNotes: item.discrepancy_notes,
        discrepancy_notes: item.discrepancy_notes,
        status: "OPEN",
      };
    });
}

function allocatedQuantityForLine(boxes: JsonRecord[], shipmentItemId: string) {
  return boxes.reduce((sum, box) => {
    const contents = jsonArray(box.contents);
    return (
      sum +
      contents
        .filter((content) => contentItemId(content) === shipmentItemId)
        .reduce((inner, content) => inner + contentQuantity(content), 0)
    );
  }, 0);
}

function buildInvoiceSummary(invoice: JsonRecord | null | undefined) {
  if (!invoice) return null;
  const pdfFile = serializeFile(invoice.uploaded_files_invoices_pdf_file_idTouploaded_files);
  const xlsxFile = serializeFile(invoice.uploaded_files_invoices_xlsx_file_idTouploaded_files);

  return {
    id: invoice.id,
    invoiceNumber: invoice.invoice_number,
    invoice_number: invoice.invoice_number,
    invoiceDate: invoice.invoice_date,
    invoice_date: invoice.invoice_date,
    dueDate: invoice.due_date,
    due_date: invoice.due_date,
    invoiceType: invoice.invoice_type,
    invoice_type: invoice.invoice_type,
    status: invoice.status,
    shipmentId: invoice.shipment_id,
    shipment_id: invoice.shipment_id,
    subShipmentId: invoice.sub_shipment_id,
    sub_shipment_id: invoice.sub_shipment_id,
    subtotal: numberValue(invoice.subtotal),
    vatAmount: numberValue(invoice.vat_amount),
    vat_amount: numberValue(invoice.vat_amount),
    total: numberValue(invoice.total),
    sentAt: invoice.sent_at,
    sent_at: invoice.sent_at,
    paidAt: invoice.paid_at,
    paid_at: invoice.paid_at,
    createdAt: invoice.created_at,
    created_at: invoice.created_at,
    pdfFileId: invoice.pdf_file_id,
    pdf_file_id: invoice.pdf_file_id,
    xlsxFileId: invoice.xlsx_file_id,
    xlsx_file_id: invoice.xlsx_file_id,
    pdfFile,
    pdf_file: pdfFile,
    xlsxFile,
    xlsx_file: xlsxFile,
    lineItemCount: invoice._count?.invoice_line_items ?? 0,
    line_item_count: invoice._count?.invoice_line_items ?? 0,
  };
}

function buildDispatchSummary(boxes: JsonRecord[]) {
  const dispatchable = boxes.filter((box) => !box.insidePallet);
  const dispatched = dispatchable.filter((box) => box.dispatchedAt || box.dispatched_at);

  return {
    total: dispatchable.length,
    dispatched: dispatched.length,
    pending: Math.max(dispatchable.length - dispatched.length, 0),
    complete: dispatchable.length > 0 && dispatched.length === dispatchable.length,
  };
}

function buildLabelSummary(boxes: JsonRecord[]) {
  const labelRows = boxes.filter((box) => !box.insidePallet);
  const uploaded = labelRows.filter((box) => box.fbaLabelUploaded || box.fba_label_uploaded);
  const missing = labelRows.filter((box) => box.labelStatus === "missing" || box.label_status === "missing");
  const missingOptional = labelRows.filter((box) => box.labelStatus === "missing_optional" || box.label_status === "missing_optional");

  return {
    total: labelRows.length,
    uploaded: uploaded.length,
    missing: missing.length,
    missingOptional: missingOptional.length,
    missing_optional: missingOptional.length,
  };
}

function buildSubShipmentPayload(params: {
  subShipment: JsonRecord;
  lineItemsById: Map<string, JsonRecord>;
  topLevelBoxes: JsonRecord[];
  invoicesBySubShipmentId: Map<string, JsonRecord>;
}) {
  const boxesForSubShipment = params.topLevelBoxes.filter((box) => box.subShipmentId === params.subShipment.id || box.sub_shipment_id === params.subShipment.id);
  const normalBoxes = boxesForSubShipment.filter((box) => box.boxType === BoxType.box || box.box_type === BoxType.box);
  const pallets = boxesForSubShipment.filter((box) => box.boxType === BoxType.pallet || box.box_type === BoxType.pallet);
  const rawBoxesForSubShipment = boxesForSubShipment as JsonRecord[];
  const items = (params.subShipment.sub_shipment_items ?? []).map((item: JsonRecord) => {
    const lineItem = params.lineItemsById.get(String(item.shipment_line_item_id));
    const product = lineItem?.products ?? {};
    const productName = String(firstPresent(lineItem?.product_name, product.product_name) ?? "");
    const plannedQty = numberValue(item.quantity);
    const allocated = allocatedQuantityForLine(rawBoxesForSubShipment, String(item.shipment_line_item_id));

    return {
      id: item.id,
      shipmentItemId: item.shipment_line_item_id,
      shipment_item_id: item.shipment_line_item_id,
      lineItemId: item.shipment_line_item_id,
      line_item_id: item.shipment_line_item_id,
      sku: product.sku ?? "",
      productName,
      product_name: productName,
      fnsku: lineItem?.fnsku ?? product.default_fnsku ?? "",
      quantity: plannedQty,
      qty: plannedQty,
      plannedQty,
      planned_qty: plannedQty,
      allocated,
      remainingQty: Math.max(plannedQty - allocated, 0),
      remaining_qty: Math.max(plannedQty - allocated, 0),
    };
  });

  return {
    id: params.subShipment.id,
    reference: params.subShipment.reference,
    status: params.subShipment.status,
    sequenceNo: params.subShipment.sequence_no,
    sequence_no: params.subShipment.sequence_no,
    parentShipmentId: params.subShipment.parent_shipment_id,
    parent_shipment_id: params.subShipment.parent_shipment_id,
    notes: params.subShipment.notes,
    createdAt: params.subShipment.created_at,
    created_at: params.subShipment.created_at,
    updatedAt: params.subShipment.updated_at,
    updated_at: params.subShipment.updated_at,
    dispatchedAt: params.subShipment.dispatched_at,
    dispatched_at: params.subShipment.dispatched_at,
    completedAt: params.subShipment.completed_at,
    completed_at: params.subShipment.completed_at,
    cancelledAt: params.subShipment.cancelled_at,
    cancelled_at: params.subShipment.cancelled_at,
    items,
    subShipmentItems: items,
    sub_shipment_items: items,
    allocationSummary: items,
    allocation_summary: items,
    boxes: normalBoxes,
    outbound_boxes: boxesForSubShipment,
    pallets,
    dispatchSummary: buildDispatchSummary(boxesForSubShipment),
    dispatch_summary: buildDispatchSummary(boxesForSubShipment),
    labelSummary: buildLabelSummary(boxesForSubShipment),
    label_summary: buildLabelSummary(boxesForSubShipment),
    invoice: buildInvoiceSummary(params.invoicesBySubShipmentId.get(params.subShipment.id)),
  };
}

function buildPermissions(role: "admin" | "staff" | "client", shipmentStatus: string) {
  const isDraft = shipmentStatus === "draft";

  return {
    canEdit: role === "admin" || (role === "client" && isDraft),
    canCreateBox: role === "admin" || role === "staff",
    canCreatePallet: role === "admin" || role === "staff",
    canCreateSubShipment: role === "admin" || role === "staff",
    canUploadLabel: true,
    canDispatch: role === "admin" || role === "staff",
    canGenerateInvoice: role === "admin",
    canAssignStaff: role === "admin",
    canDeleteShipment: role === "admin" || role === "client",
  };
}

function uniqueValues(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function queryMode(req: Request): ViewMode {
  const mode = new URL(req.url).searchParams.get("mode")?.trim().toLowerCase();
  return mode === "quick" ? "quick" : "detail";
}

export async function getShipmentViewBundle(
  req: Request,
  { params }: { params: { id: string } },
  forcedMode?: ViewMode,
) {
  try {
    const user = await requireUser(req);
    const mode = forcedMode ?? queryMode(req);
    const lookup = decodeURIComponent(params.id).trim();
    const lookupFilters: Prisma.shipmentsWhereInput[] = [{ reference: lookup }];
    if (isUuid(lookup)) lookupFilters.unshift({ id: lookup });

    const shipment = await prisma.shipments.findFirst({
      where: {
        soft_deleted_at: null,
        OR: lookupFilters,
      },
      select: {
        id: true,
        client_id: true,
        reference: true,
        status: true,
        expected_arrival_date: true,
        actual_arrival_date: true,
        estimated_dispatch_date: true,
        dispatched_date: true,
        completed_date: true,
        client_notes: true,
        draft_payload: true,
        draft_saved_at: true,
        submitted_at: true,
        submitted_by: true,
        received_by: true,
        assigned_to: true,
        created_at: true,
        updated_at: true,
        clients: {
          select: {
            id: true,
            company_name: true,
            contact_name: true,
            email: true,
            phone: true,
            status: true,
          },
        },
        users_shipments_assigned_toTousers: {
          select: { id: true, full_name: true, email: true, role: true, active: true },
        },
        users_shipments_submitted_byTousers: {
          select: { id: true, full_name: true, email: true, role: true, active: true },
        },
        users_shipments_received_byTousers: {
          select: { id: true, full_name: true, email: true, role: true, active: true },
        },
        shipment_line_items: {
          select: {
            id: true,
            shipment_id: true,
            product_id: true,
            product_name: true,
            fnsku: true,
            fnsku_label_file_id: true,
            qty_expected: true,
            qty_received: true,
            dispatch_qty: true,
            needs_bundling: true,
            bundle_size: true,
            display_order: true,
            qty_discrepancy_flag: true,
            discrepancy_notes: true,
            services_selected: true,
            service_status: true,
            custom_services: true,
            expiry_date: true,
            lot_number: true,
            created_at: true,
            updated_at: true,
            products: {
              select: {
                id: true,
                client_id: true,
                product_name: true,
                sku: true,
                default_fnsku: true,
                default_fnsku_label_file_id: true,
                needs_bundling: true,
                bundle_size: true,
                active: true,
              },
            },
            uploaded_files: true,
          },
          orderBy: [{ display_order: "asc" }, { created_at: "asc" }],
        },
        outbound_boxes: {
          select: {
            id: true,
            shipment_id: true,
            sub_shipment_id: true,
            pallet_id: true,
            box_number: true,
            manual_box_number: true,
            pallet_number: true,
            box_type: true,
            box_size: true,
            length_cm: true,
            width_cm: true,
            height_cm: true,
            weight_kg: true,
            contents: true,
            fba_shipping_label_file_id: true,
            label_uploaded_at: true,
            dispatched_at: true,
            created_at: true,
            uploaded_files: true,
            pallet: {
              select: { id: true, box_number: true, manual_box_number: true, pallet_number: true, box_type: true, dispatched_at: true },
            },
            sub_shipments: {
              select: { id: true, reference: true, status: true, sequence_no: true },
            },
          },
          orderBy: { box_number: "asc" },
        },
        sub_shipments: {
          select: {
            id: true,
            parent_shipment_id: true,
            sequence_no: true,
            reference: true,
            status: true,
            notes: true,
            created_by: true,
            dispatched_by: true,
            created_at: true,
            updated_at: true,
            dispatched_at: true,
            completed_at: true,
            cancelled_at: true,
            sub_shipment_items: {
              select: {
                id: true,
                sub_shipment_id: true,
                shipment_line_item_id: true,
                quantity: true,
                created_at: true,
              },
              orderBy: { created_at: "asc" },
            },
          },
          orderBy: { sequence_no: "asc" },
        },
        staff_check_ins: {
          select: {
            id: true,
            user_id: true,
            checked_in_at: true,
            checked_out_at: true,
            duration_minutes: true,
            notes: true,
          },
          orderBy: { checked_in_at: "desc" },
        },
      },
    });

    if (!shipment) throw new ApiError("Shipment not found", 404);
    if (user.role === "client") {
      if (!user.clientId || user.clientId !== shipment.client_id) throw new ApiError("Cannot access another client's data", 403);
    }

    const lineItemIds = shipment.shipment_line_items.map((item) => item.id);
    const boxIds = shipment.outbound_boxes.map((box) => box.id);
    const subShipmentIds = shipment.sub_shipments.map((subShipment) => subShipment.id);
    const directLineItemFileIds = shipment.shipment_line_items.map((item) => item.fnsku_label_file_id);
    const directBoxFileIds = shipment.outbound_boxes.map((box) => box.fba_shipping_label_file_id);

    const [catalogRows, invoices, subShipmentAvailability, assignableUsers] = await Promise.all([
      prisma.service_catalog.findMany({
        select: { code: true, display_name: true, unit_type: true, active: true },
      }),
      mode === "detail"
        ? prisma.invoices.findMany({
            where: {
              OR: [
                { shipment_id: shipment.id },
                ...(subShipmentIds.length ? [{ sub_shipment_id: { in: subShipmentIds } }] : []),
              ],
            },
            select: {
              id: true,
              client_id: true,
              shipment_id: true,
              sub_shipment_id: true,
              invoice_number: true,
              invoice_date: true,
              due_date: true,
              invoice_type: true,
              status: true,
              subtotal: true,
              vat_amount: true,
              total: true,
              pdf_file_id: true,
              xlsx_file_id: true,
              sent_at: true,
              paid_at: true,
              created_at: true,
              uploaded_files_invoices_pdf_file_idTouploaded_files: true,
              uploaded_files_invoices_xlsx_file_idTouploaded_files: true,
              _count: { select: { invoice_line_items: true } },
            },
            orderBy: { created_at: "desc" },
          })
        : Promise.resolve([]),
      mode === "detail" ? getSubShipmentAvailability(prisma, shipment.id) : Promise.resolve([]),
      user.role === "admin" && mode === "detail"
        ? prisma.users.findMany({
            select: {
              id: true,
              email: true,
              full_name: true,
              role: true,
              active: true,
              client_id: true,
              created_at: true,
              last_login_at: true,
            },
            where: { active: true, role: { in: ["admin", "staff"] } },
            orderBy: { created_at: "desc" },
          })
        : Promise.resolve([]),
    ]);

    const invoiceIds = invoices.map((invoice) => invoice.id);
    const directInvoiceFileIds = invoices.flatMap((invoice) => [invoice.pdf_file_id, invoice.xlsx_file_id]);
    const directFileIds = uniqueValues([...directLineItemFileIds, ...directBoxFileIds, ...directInvoiceFileIds]);
    const fileOr: Prisma.uploaded_filesWhereInput[] = [
      { linked_entity_type: "shipment", linked_entity_id: shipment.id },
      ...(lineItemIds.length
        ? [{ linked_entity_type: { in: ["item", "label", "shipment_line_item"] }, linked_entity_id: { in: lineItemIds } }]
        : []),
      ...(boxIds.length
        ? [{ linked_entity_type: { in: ["box", "pallet", "outbound_box"] }, linked_entity_id: { in: boxIds } }]
        : []),
      ...(invoiceIds.length ? [{ linked_entity_type: "invoice", linked_entity_id: { in: invoiceIds } }] : []),
      ...(directFileIds.length ? [{ id: { in: directFileIds } }] : []),
    ];
    const relatedFiles = fileOr.length
      ? await prisma.uploaded_files.findMany({
          where: {
            client_id: shipment.client_id,
            OR: fileOr,
          },
          orderBy: { uploaded_at: "desc" },
        })
      : [];
    const relationFiles = [
      ...shipment.shipment_line_items.map((item) => item.uploaded_files).filter(Boolean),
      ...shipment.outbound_boxes.map((box) => box.uploaded_files).filter(Boolean),
      ...invoices.flatMap((invoice) => [
        invoice.uploaded_files_invoices_pdf_file_idTouploaded_files,
        invoice.uploaded_files_invoices_xlsx_file_idTouploaded_files,
      ]).filter(Boolean),
    ];
    const fileIndex = buildFileIndex([...relatedFiles, ...relationFiles]);
    const noteAttachments = serializeShipmentNoteAttachments(
      fileIndex.filesByEntity.get(entityKey("shipment", shipment.id)) ?? [],
    );
    const catalogByCode = new Map(catalogRows.map((row) => [normalizeServiceCode(row.code), row as JsonRecord]));
    const lineItemsById = new Map(shipment.shipment_line_items.map((item) => [item.id, item as JsonRecord]));
    const serializedLineItems = shipment.shipment_line_items.map((item, index) => serializeLineItem(item as JsonRecord, index, fileIndex));
    const serviceTasks = buildServiceTasks(shipment.shipment_line_items as JsonRecord[], catalogByCode);
    const customServices = buildCustomServices(shipment.shipment_line_items as JsonRecord[]);
    const discrepancies = buildDiscrepancies(shipment.shipment_line_items as JsonRecord[]);
    const childrenByPalletId = new Map<string, JsonRecord[]>();
    for (const box of shipment.outbound_boxes as JsonRecord[]) {
      if (!box.pallet_id) continue;
      childrenByPalletId.set(box.pallet_id, [...(childrenByPalletId.get(box.pallet_id) ?? []), box]);
    }
    for (const [palletId, children] of childrenByPalletId) {
      childrenByPalletId.set(
        palletId,
        [...children].sort((left, right) => numberValue(left.box_number) - numberValue(right.box_number)),
      );
    }

    const topLevelBoxes = (shipment.outbound_boxes as JsonRecord[])
      .filter((box) => !box.pallet_id)
      .map((box) => serializeBox(box, childrenByPalletId, lineItemsById, fileIndex));
    const normalBoxes = topLevelBoxes.filter((box) => box.boxType === BoxType.box || box.box_type === BoxType.box);
    const pallets = topLevelBoxes.filter((box) => box.boxType === BoxType.pallet || box.box_type === BoxType.pallet);
    const allChildBoxes = topLevelBoxes.flatMap((box) => box.childBoxes ?? []);
    const invoicesBySubShipmentId = new Map(
      invoices
        .filter((invoice) => invoice.sub_shipment_id)
        .map((invoice) => [String(invoice.sub_shipment_id), invoice as JsonRecord]),
    );
    const shipmentInvoice = invoices.find((invoice) => invoice.shipment_id === shipment.id && !invoice.sub_shipment_id) ?? null;
    const subShipments = mode === "detail"
      ? shipment.sub_shipments.map((subShipment) =>
          buildSubShipmentPayload({
            subShipment: subShipment as JsonRecord,
            lineItemsById,
            topLevelBoxes,
            invoicesBySubShipmentId,
          }),
        )
      : [];
    const totalExpectedQty = shipment.shipment_line_items.reduce((sum, item) => sum + numberValue(item.qty_expected), 0);
    const totalReceivedQty = shipment.shipment_line_items.reduce((sum, item) => sum + numberValue(item.qty_received), 0);
    const totalDispatchQty = shipment.shipment_line_items.reduce((sum, item) => sum + numberValue(item.dispatch_qty), 0);
    const labelSummary = buildLabelSummary(topLevelBoxes);
    const dispatchSummary = buildDispatchSummary(topLevelBoxes);
    const normalizedAssignableUsers = assignableUsers.map((assignableUser) => serializeUser(assignableUser as JsonRecord));
    const counts = {
      lineItemCount: serializedLineItems.length,
      line_item_count: serializedLineItems.length,
      boxCount: shipment.outbound_boxes.filter((box) => box.box_type === BoxType.box).length,
      box_count: shipment.outbound_boxes.filter((box) => box.box_type === BoxType.box).length,
      topLevelBoxCount: normalBoxes.length,
      top_level_box_count: normalBoxes.length,
      childBoxCount: allChildBoxes.length,
      child_box_count: allChildBoxes.length,
      palletCount: pallets.length,
      pallet_count: pallets.length,
      subShipmentCount: shipment.sub_shipments.length,
      sub_shipment_count: shipment.sub_shipments.length,
      discrepancyCount: discrepancies.length,
      discrepancy_count: discrepancies.length,
      serviceTaskCount: serviceTasks.length,
      service_task_count: serviceTasks.length,
      customServiceCount: customServices.length,
      custom_service_count: customServices.length,
      missingLabelCount: labelSummary.missing,
      missing_label_count: labelSummary.missing,
      missingOptionalLabelCount: labelSummary.missingOptional,
      missing_optional_label_count: labelSummary.missingOptional,
      invoiceCount: invoices.length,
      invoice_count: invoices.length,
      fileCount: fileIndex.files.length,
      file_count: fileIndex.files.length,
      noteAttachmentCount: noteAttachments.length,
      note_attachment_count: noteAttachments.length,
    };
    const activeCheckIns = shipment.staff_check_ins.filter((checkIn) => !checkIn.checked_out_at);
    const shipmentPayload = {
      id: shipment.id,
      shipmentId: shipment.id,
      shipment_id: shipment.id,
      reference: shipment.reference,
      shipmentReference: shipment.reference,
      shipment_reference: shipment.reference,
      status: shipment.status,
      clientId: shipment.client_id,
      client_id: shipment.client_id,
      clientName: shipment.clients.company_name,
      client_name: shipment.clients.company_name,
      clientEmail: shipment.clients.email,
      client_email: shipment.clients.email,
      client: {
        id: shipment.clients.id,
        companyName: shipment.clients.company_name,
        company_name: shipment.clients.company_name,
        contactName: shipment.clients.contact_name,
        contact_name: shipment.clients.contact_name,
        email: shipment.clients.email,
        phone: shipment.clients.phone,
        status: shipment.clients.status,
      },
      clients: shipment.clients,
      expectedArrivalDate: shipment.expected_arrival_date,
      expected_arrival_date: shipment.expected_arrival_date,
      actualArrivalDate: shipment.actual_arrival_date,
      actual_arrival_date: shipment.actual_arrival_date,
      estimatedDispatchDate: shipment.estimated_dispatch_date,
      estimated_dispatch_date: shipment.estimated_dispatch_date,
      dispatchedDate: shipment.dispatched_date,
      dispatched_date: shipment.dispatched_date,
      completedDate: shipment.completed_date,
      completed_date: shipment.completed_date,
      notes: shipment.client_notes,
      clientNotes: shipment.client_notes,
      client_notes: shipment.client_notes,
      noteAttachments,
      note_attachments: noteAttachments,
      draftPayload: shipment.draft_payload,
      draft_payload: shipment.draft_payload,
      draftSavedAt: shipment.draft_saved_at,
      draft_saved_at: shipment.draft_saved_at,
      submittedAt: shipment.submitted_at,
      submitted_at: shipment.submitted_at,
      submittedBy: shipment.submitted_by,
      submitted_by: shipment.submitted_by,
      submittedByUser: serializeUser(shipment.users_shipments_submitted_byTousers),
      submitted_by_user: serializeUser(shipment.users_shipments_submitted_byTousers),
      receivedBy: shipment.received_by,
      received_by: shipment.received_by,
      receivedByUser: serializeUser(shipment.users_shipments_received_byTousers),
      received_by_user: serializeUser(shipment.users_shipments_received_byTousers),
      assignedTo: shipment.assigned_to,
      assigned_to: shipment.assigned_to,
      assignedUser: serializeUser(shipment.users_shipments_assigned_toTousers),
      assigned_user: serializeUser(shipment.users_shipments_assigned_toTousers),
      createdAt: shipment.created_at,
      created_at: shipment.created_at,
      updatedAt: shipment.updated_at,
      updated_at: shipment.updated_at,
      units: totalExpectedQty,
      totalExpectedQty,
      total_expected_qty: totalExpectedQty,
      totalReceivedQty,
      total_received_qty: totalReceivedQty,
      totalDispatchQty,
      total_dispatch_qty: totalDispatchQty,
      activeCheckIns,
      active_check_ins: activeCheckIns,
    };

    return success({
      mode,
      view: "shipment_bundle",
      shipment: shipmentPayload,
      counts,
      lineItems: serializedLineItems,
      line_items: serializedLineItems,
      shipmentLineItems: serializedLineItems,
      shipment_line_items: serializedLineItems,
      boxes: normalBoxes,
      pallets,
      allBoxes: topLevelBoxes,
      all_boxes: topLevelBoxes,
      childBoxes: allChildBoxes,
      child_boxes: allChildBoxes,
      serviceTasks,
      service_tasks: serviceTasks,
      customServices,
      custom_services: customServices,
      discrepancies,
      subShipments,
      sub_shipments: subShipments,
      subShipmentAvailability,
      sub_shipment_availability: subShipmentAvailability,
      invoice: mode === "detail" ? buildInvoiceSummary(shipmentInvoice as JsonRecord | null) : null,
      invoices: mode === "detail" ? invoices.map((invoice) => buildInvoiceSummary(invoice as JsonRecord)) : [],
      dispatchSummary,
      dispatch_summary: dispatchSummary,
      labelSummary,
      label_summary: labelSummary,
      files: fileIndex.files,
      filesByEntity: Object.fromEntries(fileIndex.filesByEntity.entries()),
      files_by_entity: Object.fromEntries(fileIndex.filesByEntity.entries()),
      noteAttachments,
      note_attachments: noteAttachments,
      permissions: buildPermissions(user.role, shipment.status),
      assignableUsers: normalizedAssignableUsers,
      assignable_users: normalizedAssignableUsers,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
