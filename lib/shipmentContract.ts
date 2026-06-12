import { Prisma } from "@prisma/client";
import { bucketFor, supabaseAdmin } from "@/lib/supabase";

export const shipmentContractInclude = {
  clients: true,
  shipment_line_items: {
    include: {
      products: true,
      uploaded_files: true,
    },
  },
  outbound_boxes: {
    include: {
      uploaded_files: true,
    },
    orderBy: { box_number: "asc" },
  },
  sub_shipments: {
    orderBy: { sequence_no: "asc" },
    include: {
      sub_shipment_items: {
        include: {
          shipment_line_items: {
            include: { products: true, uploaded_files: true },
          },
        },
      },
      outbound_boxes: {
        include: { uploaded_files: true },
        orderBy: { box_number: "asc" },
      },
    },
  },
  staff_check_ins: true,
} satisfies Prisma.shipmentsInclude;

type ShipmentContractPayload = Prisma.shipmentsGetPayload<{ include: typeof shipmentContractInclude }>;

function safeJsonArray(value: Prisma.JsonValue | null | undefined): unknown[] {
  return Array.isArray(value) ? value : [];
}

function safeJsonObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function serializeUploadedFile(file: unknown) {
  if (!file || typeof file !== "object") return null;
  const record = file as Record<string, any>;
  const storagePath = record.storage_path;
  let publicUrl = record.publicUrl || record.public_url || record.url || "";

  if (!publicUrl && storagePath && record.file_type) {
    publicUrl = supabaseAdmin.storage.from(bucketFor(record.file_type)).getPublicUrl(storagePath).data.publicUrl;
  }

  return {
    ...record,
    fileId: record.id,
    file_id: record.id,
    fileType: record.file_type,
    file_type: record.file_type,
    fileName: record.original_filename,
    file_name: record.original_filename,
    originalFilename: record.original_filename,
    original_filename: record.original_filename,
    mimeType: record.mime_type,
    mime_type: record.mime_type,
    storagePath,
    storage_path: storagePath,
    entityType: record.linked_entity_type,
    entity_type: record.linked_entity_type,
    linkedEntityType: record.linked_entity_type,
    linked_entity_type: record.linked_entity_type,
    entityId: record.linked_entity_id,
    entity_id: record.linked_entity_id,
    linkedEntityId: record.linked_entity_id,
    linked_entity_id: record.linked_entity_id,
    uploadedAt: record.uploaded_at,
    uploaded_at: record.uploaded_at,
    url: publicUrl,
    publicUrl,
    public_url: publicUrl,
  };
}

function serializeProduct(product: Record<string, any> | null | undefined): Record<string, any> | null {
  if (!product) return null;
  return {
    ...product,
    productName: product.product_name,
    product_name: product.product_name,
    defaultFnsku: product.default_fnsku,
    default_fnsku: product.default_fnsku,
    needsBundling: product.needs_bundling,
    needs_bundling: product.needs_bundling,
    bundleSize: product.bundle_size,
    bundle_size: product.bundle_size,
  };
}

function getBundleSize(item: Record<string, any>) {
  const productBundleSize = item.products?.bundle_size;
  const value = item.bundle_size ?? productBundleSize ?? 1;
  const bundleSize = Number(value || 1);
  return Number.isFinite(bundleSize) && bundleSize > 0 ? bundleSize : 1;
}

function serializeLineItem(item: Record<string, any>, index: number) {
  const product = serializeProduct(item.products);
  const labelFile = serializeUploadedFile(item.uploaded_files);
  const bundleSize = getBundleSize(item);
  const needsBundling = Boolean(item.needs_bundling ?? item.products?.needs_bundling ?? bundleSize > 1);
  const displayOrder = item.display_order ?? index;
  const services = safeJsonArray(item.services_selected);
  const serviceStatus = safeJsonObject(item.service_status);
  const customServices = safeJsonArray(item.custom_services);

  return {
    ...item,
    products: product,
    product,
    productId: item.product_id,
    product_id: item.product_id,
    productName: product?.product_name ?? "",
    product_name: product?.product_name ?? "",
    sku: product?.sku ?? "",
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
    needsBundling,
    needs_bundling: needsBundling,
    bundleSize,
    bundle_size: bundleSize,
    displayOrder,
    display_order: displayOrder,
    itemIndex: displayOrder,
    item_index: displayOrder,
    lineItemIndex: displayOrder,
    line_item_index: displayOrder,
    services,
    servicesSelected: services,
    services_selected: services,
    serviceStatus,
    service_status: serviceStatus,
    customServices,
    custom_services: customServices,
    discrepancyFlag: item.qty_discrepancy_flag,
    discrepancy_flag: item.qty_discrepancy_flag,
    qtyDiscrepancyFlag: item.qty_discrepancy_flag,
    qty_discrepancy_flag: item.qty_discrepancy_flag,
    discrepancyNotes: item.discrepancy_notes,
    discrepancy_notes: item.discrepancy_notes,
    fnskuLabelFileId: item.fnsku_label_file_id,
    fnsku_label_file_id: item.fnsku_label_file_id,
    fnskuLabelFile: labelFile,
    fnsku_label_file: labelFile,
    uploaded_files: labelFile,
  };
}

function sortLineItems(items: ShipmentContractPayload["shipment_line_items"]) {
  return [...items].sort((left, right) => {
    const leftOrder = left.display_order ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.display_order ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
  });
}

function serializeOutboundBox(box: Record<string, any>) {
  const labelFile = serializeUploadedFile(box.uploaded_files);
  return {
    ...box,
    fbaShippingLabelFileId: box.fba_shipping_label_file_id,
    fba_shipping_label_file_id: box.fba_shipping_label_file_id,
    fbaShippingLabelFile: labelFile,
    fba_shipping_label_file: labelFile,
    uploaded_files: labelFile,
  };
}

function serializeSubShipment(subShipment: Record<string, any>) {
  return {
    ...subShipment,
    sequenceNo: subShipment.sequence_no,
    sequence_no: subShipment.sequence_no,
    parentShipmentId: subShipment.parent_shipment_id,
    parent_shipment_id: subShipment.parent_shipment_id,
    dispatchedAt: subShipment.dispatched_at,
    dispatched_at: subShipment.dispatched_at,
    completedAt: subShipment.completed_at,
    completed_at: subShipment.completed_at,
    items: (subShipment.sub_shipment_items ?? []).map((item: Record<string, any>) => ({
      ...item,
      shipmentLineItem: item.shipment_line_items
        ? serializeLineItem(item.shipment_line_items, item.shipment_line_items.display_order ?? 0)
        : null,
      shipment_line_items: item.shipment_line_items
        ? serializeLineItem(item.shipment_line_items, item.shipment_line_items.display_order ?? 0)
        : null,
      quantity: item.quantity,
    })),
    sub_shipment_items: subShipment.sub_shipment_items ?? [],
    boxes: (subShipment.outbound_boxes ?? []).map(serializeOutboundBox),
    outbound_boxes: (subShipment.outbound_boxes ?? []).map(serializeOutboundBox),
  };
}

export function serializeShipment(shipment: ShipmentContractPayload) {
  const lineItems = sortLineItems(shipment.shipment_line_items).map(serializeLineItem);
  const boxes = (shipment.outbound_boxes ?? []).map(serializeOutboundBox);
  const subShipments = (shipment.sub_shipments ?? []).map(serializeSubShipment);
  const discrepancies = lineItems.filter((item) => item.qty_discrepancy_flag);
  const totalExpectedQty = lineItems.reduce((sum, item) => sum + Number(item.qty_expected || 0), 0);
  const totalReceivedQty = lineItems.reduce((sum, item) => sum + Number(item.qty_received || 0), 0);

  return {
    ...shipment,
    client: shipment.clients,
    clients: shipment.clients,
    clientId: shipment.client_id,
    client_id: shipment.client_id,
    clientName: shipment.clients?.company_name,
    client_name: shipment.clients?.company_name,
    expectedArrivalDate: shipment.expected_arrival_date,
    expected_arrival_date: shipment.expected_arrival_date,
    actualArrivalDate: shipment.actual_arrival_date,
    actual_arrival_date: shipment.actual_arrival_date,
    dispatchedDate: shipment.dispatched_date,
    dispatched_date: shipment.dispatched_date,
    completedDate: shipment.completed_date,
    completed_date: shipment.completed_date,
    notes: shipment.client_notes,
    clientNotes: shipment.client_notes,
    client_notes: shipment.client_notes,
    assignedTo: shipment.assigned_to,
    assigned_to: shipment.assigned_to,
    submittedAt: shipment.submitted_at,
    submitted_at: shipment.submitted_at,
    createdAt: shipment.created_at,
    created_at: shipment.created_at,
    updatedAt: shipment.updated_at,
    updated_at: shipment.updated_at,
    shipment_line_items: lineItems,
    lineItems,
    line_items: lineItems,
    items: lineItems,
    outbound_boxes: boxes,
    boxes,
    sub_shipments: subShipments,
    subShipments,
    discrepancies,
    totalExpectedQty,
    total_expected_qty: totalExpectedQty,
    totalReceivedQty,
    total_received_qty: totalReceivedQty,
    units: totalExpectedQty,
  };
}
