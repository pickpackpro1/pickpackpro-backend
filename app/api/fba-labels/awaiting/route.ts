import { BoxType, Prisma, ShipmentStatus } from "@prisma/client";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { serializeUploadedFile } from "@/lib/shipmentContract";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const ELIGIBLE_SHIPMENT_STATUSES: ShipmentStatus[] = [
  ShipmentStatus.submitted,
  ShipmentStatus.pending_arrival,
  ShipmentStatus.received,
  ShipmentStatus.in_progress,
  ShipmentStatus.prepped,
  ShipmentStatus.dispatched,
];

const shipmentStatuses = new Set<string>(Object.values(ShipmentStatus));

type JsonRecord = Record<string, any>;

function positiveInt(value: string | null, fallback: number) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function parseBoolean(value: string | null) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function firstPresent(...values: unknown[]) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "");
}

function numberValue(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function boxScope(box: JsonRecord) {
  return box.sub_shipment_id ? "sub_shipment" : "parent_shipment";
}

function boxPalletNumber(box: JsonRecord) {
  const value = firstPresent(box.pallet_number, box.palletNumber);
  return value === undefined || value === null ? null : String(value);
}

function jsonArray(value: Prisma.JsonValue | null | undefined): JsonRecord[] {
  return Array.isArray(value) ? (value as JsonRecord[]) : [];
}

function itemIdFromContent(content: JsonRecord) {
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

function quantityFromContent(content: JsonRecord) {
  return numberValue(firstPresent(content.quantity, content.qty, content.qtyPacked, content.qty_packed, content.units));
}

function lineItemDisplayQuantity(lineItem: JsonRecord, quantityOverride?: unknown) {
  return numberValue(firstPresent(quantityOverride, lineItem.dispatch_qty, lineItem.qty_received, lineItem.qty_expected));
}

function lineItemToContent(lineItem: JsonRecord, quantityOverride?: unknown) {
  const product = lineItem.products ?? {};
  const quantity = lineItemDisplayQuantity(lineItem, quantityOverride);

  return {
    shipmentItemId: lineItem.id ?? null,
    shipment_item_id: lineItem.id ?? null,
    sku: String(firstPresent(product.sku, lineItem.sku) ?? ""),
    productName: String(firstPresent(lineItem.productName, lineItem.product_name, product.product_name) ?? ""),
    product_name: String(firstPresent(lineItem.product_name, lineItem.productName, product.product_name) ?? ""),
    fnsku: String(firstPresent(lineItem.fnsku, product.default_fnsku) ?? ""),
    quantity,
    qty: quantity,
  };
}

function serializeLineItem(lineItem: JsonRecord) {
  const content = lineItemToContent(lineItem);
  return {
    id: lineItem.id,
    shipmentItemId: lineItem.id,
    shipment_item_id: lineItem.id,
    sku: content.sku,
    productName: content.productName,
    product_name: content.product_name,
    fnsku: content.fnsku,
    quantity: content.quantity,
    qty: content.qty,
    qtyExpected: lineItem.qty_expected,
    qty_expected: lineItem.qty_expected,
    qtyReceived: lineItem.qty_received,
    qty_received: lineItem.qty_received,
    dispatchQty: lineItem.dispatch_qty,
    dispatch_qty: lineItem.dispatch_qty,
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
    const shipmentItemId = itemIdFromContent(content);
    const lineItem = shipmentItemId ? lineItemsById.get(shipmentItemId) : undefined;
    const product = lineItem?.products ?? {};
    const quantity = quantityFromContent(content);

    return {
      shipmentItemId: shipmentItemId || null,
      shipment_item_id: shipmentItemId || null,
      sku: String(firstPresent(content.sku, product.sku) ?? ""),
    productName: String(firstPresent(content.productName, content.product_name, lineItem?.product_name, product.product_name) ?? ""),
    product_name: String(firstPresent(content.product_name, content.productName, lineItem?.product_name, product.product_name) ?? ""),
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

function shipmentWhereForRequest(params: {
  role: "admin" | "client";
  clientId: string | null;
  requestedClientId?: string;
  status?: ShipmentStatus;
  search?: string;
}) {
  const statusWhere = params.status ? params.status : { in: ELIGIBLE_SHIPMENT_STATUSES };
  const search = params.search?.trim();

  return {
    soft_deleted_at: null,
    status: statusWhere,
    client_id: params.role === "client" ? params.clientId! : params.requestedClientId,
    ...(search
      ? {
          OR: [
            { reference: { contains: search, mode: "insensitive" as const } },
            { clients: { company_name: { contains: search, mode: "insensitive" as const } } },
            { clients: { email: { contains: search, mode: "insensitive" as const } } },
            { sub_shipments: { some: { reference: { contains: search, mode: "insensitive" as const } } } },
            {
              shipment_line_items: {
                some: {
                  OR: [
                    { product_name: { contains: search, mode: "insensitive" as const } },
                    { fnsku: { contains: search, mode: "insensitive" as const } },
                    { products: { sku: { contains: search, mode: "insensitive" as const } } },
                    { products: { product_name: { contains: search, mode: "insensitive" as const } } },
                  ],
                },
              },
            },
          ],
        }
      : {}),
  } satisfies Prisma.shipmentsWhereInput;
}

function actionBoxWhere(includeUploaded: boolean) {
  return {
    pallet_id: null,
    dispatched_at: null,
    box_type: { in: [BoxType.box, BoxType.pallet] },
    ...(includeUploaded ? {} : { fba_shipping_label_file_id: null }),
  } satisfies Prisma.outbound_boxesWhereInput;
}

function buildBoxPayload(box: JsonRecord, shipment: JsonRecord, lineItemsById: Map<string, JsonRecord>, linkedFilesByEntity: Map<string, JsonRecord>) {
  const labelFile = fileForBox(box, linkedFilesByEntity);
  const serializedLabel = serializeLabelFile(labelFile);
  const isPallet = box.box_type === BoxType.pallet;
  const lineItems = Array.isArray(shipment.shipment_line_items) ? shipment.shipment_line_items : [];
  const fallbackItems = fallbackLineItemsForBox(box, lineItemsById, lineItems);
  const childBoxes = (box.pallet_children ?? []).map((childBox: JsonRecord) => {
    const childFile = fileForBox(childBox, linkedFilesByEntity);
    const childSerializedLabel = serializeLabelFile(childFile);
    const childFallbackItems = fallbackLineItemsForBox(
      { ...childBox, sub_shipments: childBox.sub_shipments ?? box.sub_shipments },
      lineItemsById,
      lineItems,
    );
    const childContents = contentsForBox(childBox.contents, lineItemsById, childFallbackItems);
    const childSubShipment = childBox.sub_shipments ?? box.sub_shipments ?? null;

    return {
      id: childBox.id,
      boxId: childBox.id,
      box_id: childBox.id,
      boxNumber: childBox.box_number,
      box_number: childBox.box_number,
      palletNumber: boxPalletNumber(childBox),
      pallet_number: boxPalletNumber(childBox),
      parentPalletNumber: boxPalletNumber(box),
      parent_pallet_number: boxPalletNumber(box),
      boxType: childBox.box_type,
      box_type: childBox.box_type,
      shipmentId: childBox.shipment_id,
      shipment_id: childBox.shipment_id,
      subShipmentId: childBox.sub_shipment_id,
      sub_shipment_id: childBox.sub_shipment_id,
      subShipmentReference: childSubShipment?.reference ?? null,
      sub_shipment_reference: childSubShipment?.reference ?? null,
      scope: boxScope(childBox),
      palletId: childBox.pallet_id,
      pallet_id: childBox.pallet_id,
      insidePallet: true,
      inside_pallet: true,
      isPallet: false,
      is_pallet: false,
      fbaLabelFileId: childBox.fba_shipping_label_file_id ?? childSerializedLabel?.fileId ?? null,
      fba_label_file_id: childBox.fba_shipping_label_file_id ?? childSerializedLabel?.fileId ?? null,
      fbaShippingLabelFileId: childBox.fba_shipping_label_file_id,
      fba_shipping_label_file_id: childBox.fba_shipping_label_file_id,
      fbaLabelUploaded: Boolean(childBox.fba_shipping_label_file_id || childSerializedLabel),
      fba_label_uploaded: Boolean(childBox.fba_shipping_label_file_id || childSerializedLabel),
      labelStatus: childBox.fba_shipping_label_file_id || childSerializedLabel ? "uploaded" : "missing",
      label_status: childBox.fba_shipping_label_file_id || childSerializedLabel ? "uploaded" : "missing",
      fbaLabelFile: childSerializedLabel,
      fba_label_file: childSerializedLabel,
      contents: childContents,
      boxContents: childContents,
      box_contents: childContents,
      items: childContents,
      boxItems: childContents,
      box_items: childContents,
      lineItems: childContents,
      line_items: childContents,
    };
  });
  const contents = isPallet ? aggregateContents(childBoxes.map((childBox: JsonRecord) => childBox.contents)) : contentsForBox(box.contents, lineItemsById, fallbackItems);
  const uploaded = Boolean(box.fba_shipping_label_file_id || serializedLabel);
  const labelStatus = uploaded ? "uploaded" : isPallet ? "missing_optional" : "missing";

  return {
    id: box.id,
    boxId: box.id,
    box_id: box.id,
    boxNumber: box.box_number,
    box_number: box.box_number,
    palletNumber: boxPalletNumber(box),
    pallet_number: boxPalletNumber(box),
    boxType: box.box_type,
    box_type: box.box_type,
    size: box.box_size,
    boxSize: box.box_size,
    box_size: box.box_size,
    dimensions: {
      l: numberValue(box.length_cm),
      w: numberValue(box.width_cm),
      h: numberValue(box.height_cm),
    },
    lengthCm: numberValue(box.length_cm),
    length_cm: numberValue(box.length_cm),
    widthCm: numberValue(box.width_cm),
    width_cm: numberValue(box.width_cm),
    heightCm: numberValue(box.height_cm),
    height_cm: numberValue(box.height_cm),
    weight: numberValue(box.weight_kg),
    weightKg: numberValue(box.weight_kg),
    weight_kg: numberValue(box.weight_kg),
    status: box.status ?? null,
    shipmentId: shipment.id,
    shipment_id: shipment.id,
    shipmentReference: shipment.reference,
    shipment_reference: shipment.reference,
    subShipmentId: box.sub_shipment_id,
    sub_shipment_id: box.sub_shipment_id,
    subShipmentReference: box.sub_shipments?.reference ?? null,
    sub_shipment_reference: box.sub_shipments?.reference ?? null,
    scope: boxScope(box),
    palletId: box.pallet_id,
    pallet_id: box.pallet_id,
    insidePallet: Boolean(box.pallet_id),
    inside_pallet: Boolean(box.pallet_id),
    isPallet,
    is_pallet: isPallet,
    fbaLabelFileId: box.fba_shipping_label_file_id ?? serializedLabel?.fileId ?? null,
    fba_label_file_id: box.fba_shipping_label_file_id ?? serializedLabel?.fileId ?? null,
    fbaShippingLabelFileId: box.fba_shipping_label_file_id,
    fba_shipping_label_file_id: box.fba_shipping_label_file_id,
    fbaLabelUploaded: uploaded,
    fba_label_uploaded: uploaded,
    labelStatus,
    label_status: labelStatus,
    fbaLabelFile: serializedLabel,
    fba_label_file: serializedLabel,
    labelUploadedAt: box.label_uploaded_at,
    label_uploaded_at: box.label_uploaded_at,
    dispatchedAt: box.dispatched_at,
    dispatched_at: box.dispatched_at,
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
    lineItems: contents,
    line_items: contents,
  };
}

export async function GET(req: Request) {
  try {
    const user = await requireRole(req, ["admin", "client"]);
    const url = new URL(req.url);
    const page = positiveInt(url.searchParams.get("page"), 1);
    const limit = Math.min(positiveInt(url.searchParams.get("limit"), DEFAULT_LIMIT), MAX_LIMIT);
    const search = url.searchParams.get("search")?.trim() || undefined;
    const requestedClientId = url.searchParams.get("clientId")?.trim() || undefined;
    const includeUploaded = parseBoolean(url.searchParams.get("includeUploaded"));
    const rawStatus = url.searchParams.get("status")?.trim().toLowerCase();

    if (user.role === "client" && !user.clientId) throw new ApiError("Client user has no clientId", 403);
    if (rawStatus && rawStatus !== "all" && !shipmentStatuses.has(rawStatus)) {
      throw new ApiError("Invalid shipment status", 400);
    }

    const status = rawStatus && rawStatus !== "all" ? (rawStatus as ShipmentStatus) : undefined;
    const shipmentWhere = shipmentWhereForRequest({
      role: user.role === "admin" ? "admin" : "client",
      clientId: user.clientId,
      requestedClientId,
      status,
      search,
    });
    const boxWhere = actionBoxWhere(includeUploaded);
    const pendingBoxWhere = actionBoxWhere(false);
    const shipmentListWhere: Prisma.shipmentsWhereInput = {
      ...shipmentWhere,
      outbound_boxes: { some: boxWhere },
    };

    const [shipments, total, pendingBoxCount] = await Promise.all([
      prisma.shipments.findMany({
        where: shipmentListWhere,
        select: {
          id: true,
          reference: true,
          status: true,
          client_id: true,
          expected_arrival_date: true,
          actual_arrival_date: true,
          estimated_dispatch_date: true,
          dispatched_date: true,
          submitted_at: true,
          created_at: true,
          updated_at: true,
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
              product_name: true,
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
          outbound_boxes: {
            where: boxWhere,
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
              sub_shipments: {
                select: {
                  id: true,
                  reference: true,
                  status: true,
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
                    select: { id: true, reference: true, status: true, sequence_no: true },
                  },
                },
                orderBy: { box_number: "asc" },
              },
            },
            orderBy: { box_number: "asc" },
          },
        },
        orderBy: { created_at: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.shipments.count({ where: shipmentListWhere }),
      prisma.outbound_boxes.count({
        where: {
          ...pendingBoxWhere,
          shipments: shipmentWhere,
        },
      }),
    ]);

    const entityIds = shipments.flatMap((shipment) =>
      shipment.outbound_boxes.flatMap((box) => [
        box.id,
        ...box.pallet_children.map((childBox: { id: string }) => childBox.id),
      ]),
    );
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

    const rows = shipments.flatMap((shipment) => {
      const lineItemsById = new Map(
        shipment.shipment_line_items.map((item) => [item.id, item as unknown as JsonRecord]),
      );
      const lineItems = shipment.shipment_line_items.map((item) => serializeLineItem(item as unknown as JsonRecord));
      const boxes = shipment.outbound_boxes
        .map((box) => buildBoxPayload(box as unknown as JsonRecord, shipment as unknown as JsonRecord, lineItemsById, linkedFilesByEntity))
        .filter((box) => includeUploaded || !box.fbaLabelUploaded);

      if (!boxes.length) return [];

      const pendingLabelCount = boxes.filter((box) => box.labelStatus === "missing" || box.labelStatus === "missing_optional").length;
      return [
        {
          shipment: {
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
            expectedArrivalDate: shipment.expected_arrival_date,
            expected_arrival_date: shipment.expected_arrival_date,
            actualArrivalDate: shipment.actual_arrival_date,
            actual_arrival_date: shipment.actual_arrival_date,
            estimatedDispatchDate: shipment.estimated_dispatch_date,
            estimated_dispatch_date: shipment.estimated_dispatch_date,
            dispatchedDate: shipment.dispatched_date,
            dispatched_date: shipment.dispatched_date,
            submittedAt: shipment.submitted_at,
            submitted_at: shipment.submitted_at,
            createdAt: shipment.created_at,
            created_at: shipment.created_at,
            updatedAt: shipment.updated_at,
            updated_at: shipment.updated_at,
            lineItems,
            line_items: lineItems,
            shipmentLineItems: lineItems,
            shipment_line_items: lineItems,
          },
          pendingLabelCount,
          pending_label_count: pendingLabelCount,
          boxes,
        },
      ];
    });

    return success({
      rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      pendingBoxCount,
      pending_box_count: pendingBoxCount,
      includeUploaded,
      include_uploaded: includeUploaded,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
