import { randomUUID } from "crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { ApiError } from "@/lib/apiResponse";
import { normalizeServiceCode } from "@/lib/businessLogic";

const DEFAULT_SERVICES = ["fnsku_label", "polybag", "bubble_wrap", "bundling"];
const BULK_CHUNK_SIZE = 500;

type Db = PrismaClient | Prisma.TransactionClient;

export const SHIPMENT_WRITE_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 60_000,
};

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

function chunks<T>(values: T[], size = BULK_CHUNK_SIZE) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function splitServiceValues(services: string[]) {
  return services
    .flatMap((service) => String(service ?? "").split(/[;,|]/))
    .map((service) => service.trim())
    .filter(Boolean);
}

function uniqueValues(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
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

export async function normalizeSubmittedItemServices(db: Db, items: SubmittedShipmentItemInput[]) {
  const catalog = await db.service_catalog.findMany({
    where: { active: true },
    select: { code: true, display_name: true },
  });
  const catalogCodeByNormalized = new Map<string, string>();
  for (const service of catalog) {
    catalogCodeByNormalized.set(normalizeServiceCode(service.code), service.code);
    catalogCodeByNormalized.set(normalizeServiceCode(service.display_name), service.code);
  }

  const errors: Array<{ index: number; sku: string; service: string; normalizedService: string }> = [];
  const normalizedItems = items.map((item, index) => {
    const serviceInputs = splitServiceValues(item.services);
    const rawServices = serviceInputs.length ? serviceInputs : DEFAULT_SERVICES;
    const normalizedServices: string[] = [];
    const seen = new Set<string>();

    for (const rawService of rawServices) {
      const normalizedService = normalizeServiceCode(rawService);
      const serviceCode = catalogCodeByNormalized.get(normalizedService);
      if (!serviceCode) {
        errors.push({ index, sku: item.sku, service: rawService, normalizedService });
        continue;
      }
      if (seen.has(serviceCode)) continue;
      seen.add(serviceCode);
      normalizedServices.push(serviceCode);
    }

    return { ...item, services: normalizedServices };
  });

  if (errors.length) {
    throw new ApiError("Unsupported shipment service in imported line items", 422, { services: errors });
  }

  return normalizedItems;
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
    fnskuLabelFileId: string | null;
  }> = [];

  const skus = uniqueValues(items.map((item) => item.sku));
  const firstItemBySku = new Map<string, SubmittedShipmentItemInput>();
  const lastItemBySku = new Map<string, SubmittedShipmentItemInput>();
  for (const item of items) {
    if (!firstItemBySku.has(item.sku)) firstItemBySku.set(item.sku, item);
    lastItemBySku.set(item.sku, item);
  }

  const existingProducts = (
    await Promise.all(
      chunks(skus).map((skuChunk) =>
        tx.products.findMany({
          where: { client_id: clientId, sku: { in: skuChunk } },
          select: { id: true, sku: true },
        }),
      ),
    )
  ).flat();
  const existingSkuSet = new Set(existingProducts.map((product) => product.sku));

  const existingProductUpdates = existingProducts
    .map((product) => {
      const item = lastItemBySku.get(product.sku);
      if (!item) return null;
      return {
        id: product.id,
        defaultFnsku: getFnsku(item) || item.sku,
        needsBundling: getNeedsBundling(item),
        bundleSize: getBundleSize(item),
      };
    })
    .filter((update): update is NonNullable<typeof update> => Boolean(update));

  for (const updateChunk of chunks(existingProductUpdates)) {
    if (!updateChunk.length) continue;
    await tx.$executeRaw`
      update products as p
      set
        default_fnsku = updates.default_fnsku,
        needs_bundling = updates.needs_bundling,
        bundle_size = updates.bundle_size
      from (
        values ${Prisma.join(
          updateChunk.map((update) =>
            Prisma.sql`(${update.id}::uuid, ${update.defaultFnsku}::text, ${update.needsBundling}::boolean, ${update.bundleSize}::integer)`,
          ),
        )}
      ) as updates(id, default_fnsku, needs_bundling, bundle_size)
      where p.id = updates.id
    `;
  }

  const missingProducts = skus
    .filter((sku) => !existingSkuSet.has(sku))
    .map((sku) => {
      const firstItem = firstItemBySku.get(sku);
      const lastItem = lastItemBySku.get(sku);
      if (!firstItem || !lastItem) throw new ApiError(`Missing product payload for SKU ${sku}`, 400);
      return {
        id: randomUUID(),
        client_id: clientId,
        sku,
        product_name: firstItem.productName,
        default_fnsku: getFnsku(lastItem) || sku,
        length_cm: 0,
        width_cm: 0,
        height_cm: 0,
        weight_kg: 0,
        needs_bundling: getNeedsBundling(lastItem),
        bundle_size: getBundleSize(lastItem),
      } satisfies Prisma.productsCreateManyInput;
    });

  for (const productChunk of chunks(missingProducts)) {
    if (!productChunk.length) continue;
    await tx.products.createMany({ data: productChunk, skipDuplicates: true });
  }

  const products = (
    await Promise.all(
      chunks(skus).map((skuChunk) =>
        tx.products.findMany({
          where: { client_id: clientId, sku: { in: skuChunk } },
          select: {
            id: true,
            sku: true,
            default_fnsku_label_file_id: true,
          },
        }),
      ),
    )
  ).flat();
  const productBySku = new Map(products.map((product) => [product.sku, product]));

  const defaultLabelIds = uniqueValues(products.map((product) => product.default_fnsku_label_file_id ?? ""));
  const validDefaultLabelIds = new Set<string>();
  for (const labelIdChunk of chunks(defaultLabelIds)) {
    if (!labelIdChunk.length) continue;
    const files = await tx.uploaded_files.findMany({
      where: {
        id: { in: labelIdChunk },
        client_id: clientId,
        file_type: "fnsku_label",
      },
      select: { id: true },
    });
    for (const file of files) validDefaultLabelIds.add(file.id);
  }

  const lineItemRows: Prisma.shipment_line_itemsCreateManyInput[] = [];
  for (const [index, item] of items.entries()) {
    const bundleSize = getBundleSize(item);
    const needsBundling = getNeedsBundling(item);
    const product = productBySku.get(item.sku);
    if (!product) throw new ApiError(`Product could not be prepared for SKU ${item.sku}`, 500);

    const displayOrder = getDisplayOrder(item, index);
    const fnskuLabelFileId =
      product.default_fnsku_label_file_id && validDefaultLabelIds.has(product.default_fnsku_label_file_id)
        ? product.default_fnsku_label_file_id
        : null;
    const lineItemId = randomUUID();
    lineItemRows.push({
      id: lineItemId,
      shipment_id: shipmentId,
      product_id: product.id,
      product_name: item.productName,
      fnsku: getFnsku(item) || item.sku,
      fnsku_label_file_id: fnskuLabelFileId,
      qty_expected: item.expectedQty,
      dispatch_qty: null,
      needs_bundling: needsBundling,
      bundle_size: bundleSize,
      display_order: displayOrder,
      services_selected: item.services as Prisma.InputJsonValue,
      service_status: buildServiceStatus(item.services) as Prisma.InputJsonValue,
      discrepancy_notes: item.notes ?? null,
    });

    createdLineItems.push({
      lineItemId,
      productId: product.id,
      item,
      index,
      displayOrder,
      fnskuLabelFileId,
    });
  }

  for (const lineItemChunk of chunks(lineItemRows)) {
    if (!lineItemChunk.length) continue;
    await tx.shipment_line_items.createMany({ data: lineItemChunk });
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
    fnskuLabelFileId?: string | null;
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

    await tx.products.updateMany({
      where: {
        id: created.productId,
        default_fnsku_label_file_id: null,
      },
      data: {
        default_fnsku_label_file_id: match.id,
      },
    });

    attachedFileIds.add(match.id);
    attachedLineItemIds.add(created.lineItemId);
  }

  const productIds = [
    ...new Set(
      createdLineItems
        .filter((created) => !attachedLineItemIds.has(created.lineItemId) && !created.fnskuLabelFileId)
        .map((created) => created.productId),
    ),
  ];
  if (productIds.length === 0) return;

  const productsWithDefaultLabels = (
    await Promise.all(
      chunks(productIds).map((productIdChunk) =>
        tx.products.findMany({
          where: {
            id: { in: productIdChunk },
            default_fnsku_label_file_id: { not: null },
          },
          select: {
            id: true,
            client_id: true,
            default_fnsku_label_file_id: true,
          },
        }),
      ),
    )
  ).flat();
  const defaultLabelIds = uniqueValues(productsWithDefaultLabels.map((product) => product.default_fnsku_label_file_id ?? ""));
  const validLabelById = new Map<string, { client_id: string }>();
  for (const labelIdChunk of chunks(defaultLabelIds)) {
    if (!labelIdChunk.length) continue;
    const files = await tx.uploaded_files.findMany({
      where: { id: { in: labelIdChunk }, file_type: "fnsku_label" },
      select: { id: true, client_id: true },
    });
    for (const file of files) validLabelById.set(file.id, { client_id: file.client_id });
  }
  const productLabelByProductId = new Map<string, string>();
  for (const product of productsWithDefaultLabels) {
    if (!product.default_fnsku_label_file_id) continue;
    const label = validLabelById.get(product.default_fnsku_label_file_id);
    if (!label || label.client_id !== product.client_id) continue;
    productLabelByProductId.set(product.id, product.default_fnsku_label_file_id);
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
