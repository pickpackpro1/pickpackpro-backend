import { BoxType, Prisma, ShipmentStatus } from "@prisma/client";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { serializeUploadedFile } from "@/lib/shipmentContract";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const DISPATCH_SHIPMENT_STATUSES: ShipmentStatus[] = [
  ShipmentStatus.submitted,
  ShipmentStatus.pending_arrival,
  ShipmentStatus.received,
  ShipmentStatus.in_progress,
  ShipmentStatus.prepped,
  ShipmentStatus.dispatched,
  ShipmentStatus.completed,
];

type DispatchFilterStatus = "all" | "ready" | "missing" | "dispatched";
type JsonRecord = Record<string, any>;

function positiveInt(value: string | null, fallback: number) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function firstPresent(...values: unknown[]) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "");
}

function numberValue(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function jsonArray(value: Prisma.JsonValue | null | undefined): JsonRecord[] {
  return Array.isArray(value) ? (value.filter((entry) => entry && typeof entry === "object") as JsonRecord[]) : [];
}

function contentShipmentItemId(content: JsonRecord) {
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

function lineItemQuantity(lineItem: JsonRecord, quantityOverride?: unknown) {
  return numberValue(firstPresent(quantityOverride, lineItem.dispatch_qty, lineItem.qty_received, lineItem.qty_expected));
}

function lineItemToContent(lineItem: JsonRecord, quantityOverride?: unknown) {
  const product = lineItem.products ?? {};
  const quantity = lineItemQuantity(lineItem, quantityOverride);

  return {
    shipmentItemId: lineItem.id ?? null,
    shipment_item_id: lineItem.id ?? null,
    lineItemId: lineItem.id ?? null,
    line_item_id: lineItem.id ?? null,
    sku: String(firstPresent(product.sku, lineItem.sku) ?? ""),
    productName: String(firstPresent(product.product_name, lineItem.productName, lineItem.product_name) ?? ""),
    product_name: String(firstPresent(product.product_name, lineItem.product_name, lineItem.productName) ?? ""),
    fnsku: String(firstPresent(lineItem.fnsku, product.default_fnsku) ?? ""),
    quantity,
    qty: quantity,
  };
}

function fallbackLineItemsForBox(box: JsonRecord, lineItemsById: Map<string, JsonRecord>, lineItems: JsonRecord[]) {
  const subShipmentItems = Array.isArray(box.sub_shipments?.sub_shipment_items) ? box.sub_shipments.sub_shipment_items : [];
  if (box.sub_shipment_id && subShipmentItems.length === 1) {
    const subShipmentItem = subShipmentItems[0];
    const lineItem = lineItemsById.get(String(subShipmentItem.shipment_line_item_id ?? ""));
    return lineItem ? [{ lineItem, quantity: subShipmentItem.quantity }] : [];
  }

  if (!box.sub_shipment_id && lineItems.length === 1) {
    return [{ lineItem: lineItems[0], quantity: undefined }];
  }

  return [];
}

function contentsForBox(
  contents: Prisma.JsonValue | null | undefined,
  lineItemsById: Map<string, JsonRecord>,
  fallbackItems: Array<{ lineItem: JsonRecord; quantity?: unknown }> = [],
) {
  const contentRows = jsonArray(contents).map((content) => {
    const shipmentItemId = contentShipmentItemId(content);
    const lineItem = shipmentItemId ? lineItemsById.get(shipmentItemId) : undefined;
    const product = lineItem?.products ?? {};
    const quantity = contentQuantity(content);

    return {
      shipmentItemId: shipmentItemId || null,
      shipment_item_id: shipmentItemId || null,
      lineItemId: shipmentItemId || null,
      line_item_id: shipmentItemId || null,
      sku: String(firstPresent(content.sku, product.sku) ?? ""),
      productName: String(firstPresent(content.productName, content.product_name, product.product_name) ?? ""),
      product_name: String(firstPresent(content.product_name, content.productName, product.product_name) ?? ""),
      fnsku: String(firstPresent(content.fnsku, content.fnskuLabel, content.fnsku_label, lineItem?.fnsku, product.default_fnsku) ?? ""),
      quantity,
      qty: quantity,
    };
  });

  if (contentRows.length) return contentRows;
  return fallbackItems.map((fallback) => lineItemToContent(fallback.lineItem, fallback.quantity));
}

function aggregateContents(contentGroups: ReturnType<typeof contentsForBox>[]) {
  const byKey = new Map<string, ReturnType<typeof contentsForBox>[number]>();
  for (const content of contentGroups.flat()) {
    const key = String(content.shipmentItemId || content.sku || content.productName || byKey.size);
    const existing = byKey.get(key);
    if (existing) {
      existing.quantity += content.quantity;
      existing.qty = existing.quantity;
      continue;
    }
    byKey.set(key, { ...content });
  }
  return [...byKey.values()];
}

function contentsSummary(contents: ReturnType<typeof contentsForBox>) {
  return contents
    .filter((content) => content.sku || content.productName)
    .map((content) => `${content.sku || content.productName} x ${content.quantity}`)
    .join(", ");
}

function latestFileByEntity(files: JsonRecord[]) {
  const byEntity = new Map<string, JsonRecord>();
  for (const file of files) {
    const entityType = String(file.linked_entity_type ?? "");
    const entityId = String(file.linked_entity_id ?? "");
    if (!entityType || !entityId) continue;
    const key = `${entityType}:${entityId}`;
    const existing = byEntity.get(key);
    if (!existing || new Date(file.uploaded_at).getTime() > new Date(existing.uploaded_at).getTime()) {
      byEntity.set(key, file);
    }
  }
  return byEntity;
}

function fileForBox(box: JsonRecord, linkedFilesByEntity: Map<string, JsonRecord>) {
  const entityType = box.box_type === BoxType.pallet ? "pallet" : "box";
  return box.uploaded_files ?? linkedFilesByEntity.get(`${entityType}:${box.id}`) ?? linkedFilesByEntity.get(`box:${box.id}`) ?? null;
}

function serializeLabelFile(file: unknown) {
  const serialized = serializeUploadedFile(file);
  if (!serialized) return null;
  return {
    ...serialized,
    fileId: serialized.fileId,
    file_id: serialized.file_id,
    fileName: serialized.fileName,
    file_name: serialized.file_name,
    originalFilename: serialized.originalFilename,
    original_filename: serialized.original_filename,
    publicUrl: serialized.publicUrl,
    public_url: serialized.publicUrl,
    fileType: serialized.fileType,
    file_type: serialized.file_type,
  };
}

function boxTitle(box: JsonRecord) {
  if (box.box_type === BoxType.pallet) return String(firstPresent(box.pallet_number, `Pallet ${box.box_number}`));
  return `Box ${box.box_number}`;
}

function dimensions(box: JsonRecord) {
  return {
    l: numberValue(box.length_cm),
    w: numberValue(box.width_cm),
    h: numberValue(box.height_cm),
  };
}

function dispatchState(box: JsonRecord, shipment: JsonRecord) {
  const subShipmentStatus = box.sub_shipments?.status;
  if (shipment.status === ShipmentStatus.completed || subShipmentStatus === "completed") return "completed";
  if (box.dispatched_at) return "dispatched";
  return "pending";
}

function childBoxPayload(box: JsonRecord, lineItemsById: Map<string, JsonRecord>, lineItems: JsonRecord[], linkedFilesByEntity: Map<string, JsonRecord>) {
  const childFile = fileForBox(box, linkedFilesByEntity);
  const childSerializedLabel = serializeLabelFile(childFile);
  const fallbackItems = fallbackLineItemsForBox(box, lineItemsById, lineItems);
  const contents = contentsForBox(box.contents, lineItemsById, fallbackItems);
  const fbaLabelUploaded = Boolean(box.fba_shipping_label_file_id || childSerializedLabel);

  return {
    id: box.id,
    boxId: box.id,
    box_id: box.id,
    boxNumber: box.box_number,
    box_number: box.box_number,
    boxTitle: boxTitle(box),
    box_title: boxTitle(box),
    boxType: box.box_type,
    box_type: box.box_type,
    shipmentId: box.shipment_id,
    shipment_id: box.shipment_id,
    subShipmentId: box.sub_shipment_id,
    sub_shipment_id: box.sub_shipment_id,
    subShipmentReference: box.sub_shipments?.reference ?? null,
    sub_shipment_reference: box.sub_shipments?.reference ?? null,
    parentPalletId: box.pallet_id,
    parent_pallet_id: box.pallet_id,
    insidePallet: true,
    inside_pallet: true,
    fbaLabelFileId: box.fba_shipping_label_file_id ?? childSerializedLabel?.fileId ?? null,
    fba_label_file_id: box.fba_shipping_label_file_id ?? childSerializedLabel?.fileId ?? null,
    fbaShippingLabelFileId: box.fba_shipping_label_file_id,
    fba_shipping_label_file_id: box.fba_shipping_label_file_id,
    fbaLabelUploaded,
    fba_label_uploaded: fbaLabelUploaded,
    labelStatus: fbaLabelUploaded ? "uploaded" : "missing",
    label_status: fbaLabelUploaded ? "uploaded" : "missing",
    dispatchedAt: box.dispatched_at,
    dispatched_at: box.dispatched_at,
    contents,
    contentsSummary: contentsSummary(contents),
    contents_summary: contentsSummary(contents),
  };
}

function buildQueueRow(box: JsonRecord, linkedFilesByEntity: Map<string, JsonRecord>) {
  const shipment = box.shipments ?? {};
  const lineItems = Array.isArray(shipment.shipment_line_items) ? (shipment.shipment_line_items as JsonRecord[]) : [];
  const lineItemsById = new Map<string, JsonRecord>(lineItems.map((item) => [String(item.id), item]));
  const labelFile = fileForBox(box, linkedFilesByEntity);
  const serializedLabel = serializeLabelFile(labelFile);
  const isPallet = box.box_type === BoxType.pallet;
  const childBoxes = (box.pallet_children ?? []).map((childBox: JsonRecord) =>
    childBoxPayload(
      { ...childBox, sub_shipments: childBox.sub_shipments ?? box.sub_shipments },
      lineItemsById,
      lineItems,
      linkedFilesByEntity,
    ),
  );
  const fallbackItems = fallbackLineItemsForBox(box, lineItemsById, lineItems);
  const contents = isPallet ? aggregateContents(childBoxes.map((childBox: JsonRecord) => childBox.contents)) : contentsForBox(box.contents, lineItemsById, fallbackItems);
  const fbaLabelUploaded = Boolean(box.fba_shipping_label_file_id || serializedLabel);
  const labelStatus = fbaLabelUploaded ? "uploaded" : isPallet ? "missing_optional" : "missing";
  const childrenReady = !isPallet || (childBoxes.length > 0 && childBoxes.every((childBox: JsonRecord) => childBox.fbaLabelUploaded && !childBox.dispatchedAt));
  const state = dispatchState(box, shipment);
  const isDispatchable = state === "pending" && (isPallet ? childrenReady : fbaLabelUploaded);
  const action = state === "completed" ? "Completed" : state === "dispatched" ? "Dispatched" : isDispatchable ? "Dispatch" : "Chase Client";

  return {
    id: box.id,
    shipmentId: shipment.id,
    shipment_id: shipment.id,
    shipmentReference: shipment.reference,
    shipment_reference: shipment.reference,
    subShipmentId: box.sub_shipment_id,
    sub_shipment_id: box.sub_shipment_id,
    subShipmentReference: box.sub_shipments?.reference ?? null,
    sub_shipment_reference: box.sub_shipments?.reference ?? null,
    clientId: shipment.client_id,
    client_id: shipment.client_id,
    clientName: shipment.clients?.company_name ?? "",
    client_name: shipment.clients?.company_name ?? "",
    clientEmail: shipment.clients?.email ?? "",
    client_email: shipment.clients?.email ?? "",

    boxId: box.id,
    box_id: box.id,
    boxNumber: box.box_number,
    box_number: box.box_number,
    boxTitle: boxTitle(box),
    box_title: boxTitle(box),
    boxType: box.box_type,
    box_type: box.box_type,
    isPallet,
    is_pallet: isPallet,
    palletNumber: box.pallet_number ?? null,
    pallet_number: box.pallet_number ?? null,
    parentPalletId: null,
    parent_pallet_id: null,
    parentPalletNumber: null,
    parent_pallet_number: null,
    insidePallet: false,
    inside_pallet: false,
    scope: box.sub_shipment_id ? "sub_shipment" : "parent_shipment",

    weightKg: numberValue(box.weight_kg),
    weight_kg: numberValue(box.weight_kg),
    weight: numberValue(box.weight_kg),
    dimensions: dimensions(box),
    lengthCm: numberValue(box.length_cm),
    length_cm: numberValue(box.length_cm),
    widthCm: numberValue(box.width_cm),
    width_cm: numberValue(box.width_cm),
    heightCm: numberValue(box.height_cm),
    height_cm: numberValue(box.height_cm),

    contents,
    contentsSummary: contentsSummary(contents),
    contents_summary: contentsSummary(contents),
    childBoxCount: childBoxes.length,
    child_box_count: childBoxes.length,
    childBoxes,
    child_boxes: childBoxes,

    fbaLabelFileId: box.fba_shipping_label_file_id ?? serializedLabel?.fileId ?? null,
    fba_label_file_id: box.fba_shipping_label_file_id ?? serializedLabel?.fileId ?? null,
    fbaShippingLabelFileId: box.fba_shipping_label_file_id,
    fba_shipping_label_file_id: box.fba_shipping_label_file_id,
    fbaLabelUploaded,
    fba_label_uploaded: fbaLabelUploaded,
    labelStatus,
    label_status: labelStatus,
    fbaLabelFile: serializedLabel,
    fba_label_file: serializedLabel,
    labelUploadedAt: box.label_uploaded_at,
    label_uploaded_at: box.label_uploaded_at,

    dispatchedAt: box.dispatched_at,
    dispatched_at: box.dispatched_at,
    dispatchState: state,
    dispatch_state: state,
    canDispatchDirectly: isDispatchable,
    can_dispatch_directly: isDispatchable,
    isDispatchable,
    is_dispatchable: isDispatchable,
    action,
  };
}

function baseWhere() {
  return {
    pallet_id: null,
    box_type: { in: [BoxType.box, BoxType.pallet] },
    shipments: {
      soft_deleted_at: null,
      status: { in: DISPATCH_SHIPMENT_STATUSES },
    },
  } satisfies Prisma.outbound_boxesWhereInput;
}

function readyWhere() {
  return {
    dispatched_at: null,
    OR: [
      { box_type: BoxType.box, fba_shipping_label_file_id: { not: null } },
      {
        box_type: BoxType.pallet,
        pallet_children: {
          some: {},
          every: {
            box_type: BoxType.box,
            fba_shipping_label_file_id: { not: null },
            dispatched_at: null,
          },
        },
      },
    ],
  } satisfies Prisma.outbound_boxesWhereInput;
}

function missingWhere() {
  return {
    dispatched_at: null,
    OR: [
      { box_type: BoxType.box, fba_shipping_label_file_id: null },
      { box_type: BoxType.pallet, fba_shipping_label_file_id: null },
      { box_type: BoxType.pallet, pallet_children: { some: { fba_shipping_label_file_id: null } } },
    ],
  } satisfies Prisma.outbound_boxesWhereInput;
}

function statusWhere(status: DispatchFilterStatus) {
  if (status === "ready") return readyWhere();
  if (status === "missing") return missingWhere();
  if (status === "dispatched") return { dispatched_at: { not: null } } satisfies Prisma.outbound_boxesWhereInput;
  return {};
}

function searchWhere(search?: string) {
  if (!search) return {};
  const number = Number(search.replace(/^(box|pallet)\s+/i, "").trim());
  const numericBoxSearch = Number.isInteger(number) && number > 0 ? [{ box_number: number }] : [];

  return {
    OR: [
      ...numericBoxSearch,
      { pallet_number: { contains: search, mode: "insensitive" as const } },
      { shipments: { reference: { contains: search, mode: "insensitive" as const } } },
      { shipments: { clients: { company_name: { contains: search, mode: "insensitive" as const } } } },
      { shipments: { clients: { email: { contains: search, mode: "insensitive" as const } } } },
      { sub_shipments: { reference: { contains: search, mode: "insensitive" as const } } },
      {
        shipments: {
          shipment_line_items: {
            some: {
              OR: [
                { fnsku: { contains: search, mode: "insensitive" as const } },
                { products: { sku: { contains: search, mode: "insensitive" as const } } },
                { products: { product_name: { contains: search, mode: "insensitive" as const } } },
              ],
            },
          },
        },
      },
    ],
  } satisfies Prisma.outbound_boxesWhereInput;
}

function queueWhere(status: DispatchFilterStatus, search?: string) {
  return {
    AND: [baseWhere(), statusWhere(status), searchWhere(search)],
  } satisfies Prisma.outbound_boxesWhereInput;
}

function parseStatus(value: string | null): DispatchFilterStatus {
  const status = String(value ?? "all").trim().toLowerCase();
  if (status === "all" || status === "ready" || status === "missing" || status === "dispatched") return status;
  throw new ApiError("Invalid dispatch queue status", 400);
}

export async function GET(req: Request) {
  try {
    await requireRole(req, ["admin", "staff"]);
    const url = new URL(req.url);
    const page = positiveInt(url.searchParams.get("page"), 1);
    const limit = Math.min(positiveInt(url.searchParams.get("limit"), DEFAULT_LIMIT), MAX_LIMIT);
    const search = url.searchParams.get("search")?.trim() || undefined;
    const status = parseStatus(url.searchParams.get("status"));
    const where = queueWhere(status, search);
    const countScopeWhere = queueWhere("all", search);

    const [boxes, total, pendingCount, readyCount, missingLabelCount, dispatchedCount] = await Promise.all([
      prisma.outbound_boxes.findMany({
        where,
        select: {
          id: true,
          shipment_id: true,
          sub_shipment_id: true,
          pallet_id: true,
          box_number: true,
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
          uploaded_files: true,
          shipments: {
            select: {
              id: true,
              reference: true,
              status: true,
              client_id: true,
              clients: {
                select: {
                  id: true,
                  company_name: true,
                  email: true,
                },
              },
              shipment_line_items: {
                select: {
                  id: true,
                  fnsku: true,
                  qty_expected: true,
                  qty_received: true,
                  dispatch_qty: true,
                  products: {
                    select: {
                      id: true,
                      sku: true,
                      product_name: true,
                      default_fnsku: true,
                    },
                  },
                },
              },
            },
          },
          sub_shipments: {
            select: {
              id: true,
              reference: true,
              status: true,
              sequence_no: true,
              sub_shipment_items: {
                select: {
                  shipment_line_item_id: true,
                  quantity: true,
                },
              },
            },
          },
          pallet_children: {
            select: {
              id: true,
              shipment_id: true,
              sub_shipment_id: true,
              pallet_id: true,
              box_number: true,
              pallet_number: true,
              box_type: true,
              contents: true,
              fba_shipping_label_file_id: true,
              label_uploaded_at: true,
              dispatched_at: true,
              uploaded_files: true,
              sub_shipments: {
                select: {
                  id: true,
                  reference: true,
                  status: true,
                  sequence_no: true,
                  sub_shipment_items: {
                    select: {
                      shipment_line_item_id: true,
                      quantity: true,
                    },
                  },
                },
              },
            },
            orderBy: { box_number: "asc" },
          },
        },
        orderBy: [{ dispatched_at: "asc" }, { created_at: "desc" }, { box_number: "asc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.outbound_boxes.count({ where }),
      prisma.outbound_boxes.count({ where: { AND: [countScopeWhere, { dispatched_at: null }] } }),
      prisma.outbound_boxes.count({ where: { AND: [countScopeWhere, readyWhere()] } }),
      prisma.outbound_boxes.count({ where: { AND: [countScopeWhere, missingWhere()] } }),
      prisma.outbound_boxes.count({ where: { AND: [countScopeWhere, { dispatched_at: { not: null } }] } }),
    ]);

    const entityIds = boxes.flatMap((box) => [
      box.id,
      ...box.pallet_children.map((childBox) => childBox.id),
    ]);
    const linkedFiles = entityIds.length
      ? await prisma.uploaded_files.findMany({
          where: {
            linked_entity_id: { in: entityIds },
            linked_entity_type: { in: ["box", "pallet"] },
            file_type: "fba_shipping_label",
          },
          orderBy: { uploaded_at: "desc" },
        })
      : [];
    const linkedFilesByEntity = latestFileByEntity(linkedFiles as JsonRecord[]);
    const rows = boxes.map((box) => buildQueueRow(box as unknown as JsonRecord, linkedFilesByEntity));

    return success({
      rows,
      total,
      page,
      limit,
      pendingCount,
      pending_count: pendingCount,
      dispatchedCount,
      dispatched_count: dispatchedCount,
      readyCount,
      ready_count: readyCount,
      missingLabelCount,
      missing_label_count: missingLabelCount,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
