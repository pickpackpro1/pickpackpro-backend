import { Prisma } from "@prisma/client";
import { z } from "zod";
import { ApiError } from "@/lib/apiResponse";
import { PRODUCT_FNSKU_LABEL_ENTITY_TYPE } from "@/lib/productFnskuLabels";

const DEFAULT_SERVICES = ["FNSKU_LABEL", "POLY_BAG", "BUBBLE_WRAP", "BUNDLING"];

export const draftItemSchema = z.object({
  draftItemId: z.string().optional().nullable(),
  draft_item_id: z.string().optional().nullable(),
  tempId: z.string().optional().nullable(),
  temp_id: z.string().optional().nullable(),
  sku: z.string().optional().nullable(),
  productName: z.string().optional().nullable(),
  product_name: z.string().optional().nullable(),
  expectedQty: z.coerce.number().int().nonnegative().optional().nullable(),
  expected_qty: z.coerce.number().int().nonnegative().optional().nullable(),
  qtyExpected: z.coerce.number().int().nonnegative().optional().nullable(),
  qty_expected: z.coerce.number().int().nonnegative().optional().nullable(),
  bundleSize: z.coerce.number().int().positive().optional().nullable(),
  bundle_size: z.coerce.number().int().positive().optional().nullable(),
  needsBundling: z.boolean().optional().nullable(),
  needs_bundling: z.boolean().optional().nullable(),
  itemIndex: z.coerce.number().int().nonnegative().optional().nullable(),
  item_index: z.coerce.number().int().nonnegative().optional().nullable(),
  lineItemIndex: z.coerce.number().int().nonnegative().optional().nullable(),
  line_item_index: z.coerce.number().int().nonnegative().optional().nullable(),
  displayOrder: z.coerce.number().int().nonnegative().optional().nullable(),
  display_order: z.coerce.number().int().nonnegative().optional().nullable(),
  fnskuLabel: z.string().optional().nullable(),
  fnsku_label: z.string().optional().nullable(),
  fnsku: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  services: z.array(z.string()).optional().nullable(),
  servicesSelected: z.array(z.string()).optional().nullable(),
  services_selected: z.array(z.string()).optional().nullable(),
}).passthrough();

export type DraftShipmentItemInput = z.infer<typeof draftItemSchema>;
export type SubmittedShipmentItemInput = DraftShipmentItemInput & {
  sku: string;
  productName: string;
  product_name: string;
  expectedQty: number;
  expected_qty: number;
  fnskuLabel: string;
  fnsku_label: string;
  services: string[];
};

export const DRAFT_FNSKU_ENTITY_TYPES = ["shipment_draft_item", "draft_shipment_item"];

function firstNumber(...values: Array<number | null | undefined>) {
  return values.find((value) => typeof value === "number" && Number.isFinite(value));
}

function firstText(...values: Array<string | null | undefined>) {
  return values.map((value) => String(value ?? "").trim()).find(Boolean);
}

function safeJsonObject(value: Prisma.JsonValue | null | undefined): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

export function getBundleSize(item: DraftShipmentItemInput) {
  return firstNumber(item.bundleSize ?? undefined, item.bundle_size ?? undefined) ?? 1;
}

export function getNeedsBundling(item: DraftShipmentItemInput) {
  const bundleSize = getBundleSize(item);
  return item.needsBundling ?? item.needs_bundling ?? bundleSize > 1;
}

export function getDisplayOrder(item: DraftShipmentItemInput, index: number) {
  return (
    firstNumber(
      item.displayOrder ?? undefined,
      item.display_order ?? undefined,
      item.itemIndex ?? undefined,
      item.item_index ?? undefined,
      item.lineItemIndex ?? undefined,
      item.line_item_index ?? undefined
    ) ?? index
  );
}

export function getDraftItemId(item: DraftShipmentItemInput, index: number) {
  return firstText(item.draftItemId, item.draft_item_id, item.tempId, item.temp_id) ?? `item-${getDisplayOrder(item, index)}`;
}

function getProductName(item: DraftShipmentItemInput) {
  return firstText(item.productName, item.product_name) ?? "";
}

function getExpectedQty(item: DraftShipmentItemInput) {
  return firstNumber(item.expectedQty ?? undefined, item.expected_qty ?? undefined, item.qtyExpected ?? undefined, item.qty_expected ?? undefined) ?? 0;
}

function getFnsku(item: DraftShipmentItemInput) {
  return firstText(item.fnskuLabel, item.fnsku_label, item.fnsku, item.sku) ?? "";
}

function getServices(item: DraftShipmentItemInput) {
  return item.services ?? item.servicesSelected ?? item.services_selected ?? [];
}

export function buildDraftPayload(input: {
  clientId?: string | null;
  notes?: string | null;
  expectedArrivalDate?: Date | string | null;
  items?: DraftShipmentItemInput[];
}) {
  const items = (input.items ?? []).map((item, index) => ({
    ...item,
    draftItemId: getDraftItemId(item, index),
    draft_item_id: getDraftItemId(item, index),
    productName: getProductName(item),
    product_name: getProductName(item),
    expectedQty: getExpectedQty(item),
    expected_qty: getExpectedQty(item),
    fnskuLabel: getFnsku(item),
    fnsku_label: getFnsku(item),
    bundleSize: getBundleSize(item),
    bundle_size: getBundleSize(item),
    needsBundling: getNeedsBundling(item),
    needs_bundling: getNeedsBundling(item),
    displayOrder: getDisplayOrder(item, index),
    display_order: getDisplayOrder(item, index),
    services: getServices(item),
  }));

  return JSON.parse(
    JSON.stringify({
      clientId: input.clientId ?? null,
      notes: input.notes ?? null,
      expectedArrivalDate: input.expectedArrivalDate
        ? new Date(input.expectedArrivalDate).toISOString()
        : null,
      items,
      savedAt: new Date().toISOString(),
    })
  ) as Prisma.InputJsonValue;
}

export function parseSubmittedItems(rawItems: unknown): SubmittedShipmentItemInput[] {
  const parsed = z.array(draftItemSchema).min(1).safeParse(rawItems);
  if (!parsed.success) {
    throw new ApiError("Submitted shipments require at least one complete product line item", 400, parsed.error.flatten());
  }
  const errors: Array<{ index: number; fields: string[] }> = [];
  const items = parsed.data.map((item, index) => {
    const sku = firstText(item.sku) ?? "";
    const productName = getProductName(item);
    const expectedQty = getExpectedQty(item);
    const fields: string[] = [];
    if (!sku) fields.push("sku");
    if (!productName) fields.push("productName");
    if (expectedQty <= 0) fields.push("expectedQty");
    if (fields.length) errors.push({ index, fields });

    const services = getServices(item);
    const fnsku = getFnsku(item);
    return {
      ...item,
      sku,
      productName,
      product_name: productName,
      expectedQty,
      expected_qty: expectedQty,
      fnskuLabel: fnsku,
      fnsku_label: fnsku,
      services: services.length ? services : DEFAULT_SERVICES,
    };
  });
  if (errors.length) {
    throw new ApiError("Submitted shipments require complete product line items", 400, { items: errors });
  }
  return items;
}

export function buildServiceStatus(services: string[]) {
  return Object.fromEntries(services.map((service) => [service, "PENDING"]));
}

export async function createShipmentLineItems(
  tx: Prisma.TransactionClient,
  shipmentId: string,
  clientId: string,
  items: SubmittedShipmentItemInput[]
) {
  const createdLineItems: Array<{
    lineItemId: string;
    productId: string;
    item: SubmittedShipmentItemInput;
    index: number;
    displayOrder: number;
  }> = [];

  for (const [index, item] of items.entries()) {
    const bundleSize = getBundleSize(item);
    const needsBundling = getNeedsBundling(item);
    const product = await tx.products.upsert({
      where: { client_id_sku: { client_id: clientId, sku: item.sku } },
      update: {
        product_name: item.productName,
        default_fnsku: getFnsku(item) || undefined,
        needs_bundling: needsBundling,
        bundle_size: bundleSize,
      },
      create: {
        client_id: clientId,
        sku: item.sku,
        product_name: item.productName,
        default_fnsku: getFnsku(item) || null,
        length_cm: 0,
        width_cm: 0,
        height_cm: 0,
        weight_kg: 0,
        needs_bundling: needsBundling,
        bundle_size: bundleSize,
      },
    });

    const displayOrder = getDisplayOrder(item, index);
    const lineItem = await tx.shipment_line_items.create({
      data: {
        shipment_id: shipmentId,
        product_id: product.id,
        fnsku: getFnsku(item) || item.sku,
        qty_expected: item.expectedQty,
        dispatch_qty: null,
        needs_bundling: needsBundling,
        bundle_size: bundleSize,
        display_order: displayOrder,
        services_selected: item.services,
        service_status: buildServiceStatus(item.services),
        discrepancy_notes: item.notes ?? null,
      },
    });

    createdLineItems.push({
      lineItemId: lineItem.id,
      productId: product.id,
      item,
      index,
      displayOrder,
    });
  }

  return createdLineItems;
}

function draftFileMatches(
  file: { metadata: Prisma.JsonValue | null; uploaded_at: Date },
  item: SubmittedShipmentItemInput,
  index: number,
  displayOrder: number
) {
  const metadata = safeJsonObject(file.metadata);
  const fileDraftId = firstText(metadata.draftItemId, metadata.draft_item_id, metadata.tempId, metadata.temp_id);
  const itemDraftId = getDraftItemId(item, index);
  if (fileDraftId && itemDraftId && fileDraftId === itemDraftId) return true;

  const fileIndex = firstNumber(
    Number(metadata.itemIndex),
    Number(metadata.item_index),
    Number(metadata.lineItemIndex),
    Number(metadata.line_item_index),
    Number(metadata.displayOrder),
    Number(metadata.display_order)
  );
  if (fileIndex != null && fileIndex === displayOrder) return true;

  const fileSku = firstText(metadata.sku);
  const fileFnsku = firstText(metadata.fnsku, metadata.fnskuLabel, metadata.fnsku_label);
  return Boolean(fileSku && fileSku === item.sku && (!fileFnsku || fileFnsku === getFnsku(item)));
}

export async function attachDraftFnskuFiles(
  tx: Prisma.TransactionClient,
  shipmentId: string,
  createdLineItems: Array<{
    lineItemId: string;
    productId: string;
    item: SubmittedShipmentItemInput;
    index: number;
    displayOrder: number;
  }>
) {
  const draftFiles = await tx.uploaded_files.findMany({
    where: {
      file_type: "fnsku_label",
      linked_entity_type: { in: DRAFT_FNSKU_ENTITY_TYPES },
      linked_entity_id: shipmentId,
    },
    orderBy: { uploaded_at: "desc" },
  });

  const attachedFileIds = new Set<string>();
  const attachedLineItemIds = new Set<string>();

  for (const created of createdLineItems) {
    const match = draftFiles.find(
      (file) =>
        !attachedFileIds.has(file.id) &&
        draftFileMatches(file, created.item, created.index, created.displayOrder)
    );
    if (!match) continue;

    const metadata = safeJsonObject(match.metadata);
    const nextMetadata = JSON.parse(
      JSON.stringify({
        ...metadata,
        draftShipmentId: shipmentId,
        finalizedLineItemId: created.lineItemId,
        finalizedAt: new Date().toISOString(),
      })
    ) as Prisma.InputJsonValue;

    await tx.uploaded_files.update({
      where: { id: match.id },
      data: {
        linked_entity_type: "item",
        linked_entity_id: created.lineItemId,
        metadata: nextMetadata,
      },
    });

    await tx.shipment_line_items.update({
      where: { id: created.lineItemId },
      data: {
        fnsku_label_file_id: match.id,
        updated_at: new Date(),
      },
    });

    attachedFileIds.add(match.id);
    attachedLineItemIds.add(created.lineItemId);
  }

  const productIds = [
    ...new Set(
      createdLineItems
        .filter((created) => !attachedLineItemIds.has(created.lineItemId))
        .map((created) => created.productId),
    ),
  ];
  if (productIds.length === 0) return;

  const productLabelFiles = await tx.uploaded_files.findMany({
    where: {
      file_type: "fnsku_label",
      linked_entity_type: PRODUCT_FNSKU_LABEL_ENTITY_TYPE,
      linked_entity_id: { in: productIds },
    },
    orderBy: { uploaded_at: "desc" },
  });
  const productLabelByProductId = new Map<string, string>();
  for (const file of productLabelFiles) {
    if (!file.linked_entity_id || productLabelByProductId.has(file.linked_entity_id)) continue;
    productLabelByProductId.set(file.linked_entity_id, file.id);
  }

  for (const created of createdLineItems) {
    if (attachedLineItemIds.has(created.lineItemId)) continue;
    const productLabelFileId = productLabelByProductId.get(created.productId);
    if (!productLabelFileId) continue;

    await tx.shipment_line_items.update({
      where: { id: created.lineItemId },
      data: {
        fnsku_label_file_id: productLabelFileId,
        updated_at: new Date(),
      },
    });
  }
}
