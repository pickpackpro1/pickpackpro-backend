import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireClientAccess, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { serializeShipment, shipmentContractInclude } from "@/lib/shipmentContract";
import { bucketFor, supabaseAdmin } from "@/lib/supabase";
import { json } from "@/lib/validation";

const itemSchema = z.object({
  sku: z.string().min(1),
  productName: z.string().min(1),
  expectedQty: z.coerce.number().int().positive(),
  bundleSize: z.coerce.number().int().positive().optional(),
  bundle_size: z.coerce.number().int().positive().optional(),
  needsBundling: z.boolean().optional(),
  needs_bundling: z.boolean().optional(),
  itemIndex: z.coerce.number().int().nonnegative().optional(),
  item_index: z.coerce.number().int().nonnegative().optional(),
  lineItemIndex: z.coerce.number().int().nonnegative().optional(),
  line_item_index: z.coerce.number().int().nonnegative().optional(),
  displayOrder: z.coerce.number().int().nonnegative().optional(),
  display_order: z.coerce.number().int().nonnegative().optional(),
  fnskuLabel: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  services: z.array(z.string()).default(["FNSKU_LABEL", "POLY_BAG", "BUBBLE_WRAP", "BUNDLING"]),
});

const patchSchema = z.object({
  notes: z.string().optional(),
  expectedArrivalDate: z.coerce.date().optional(),
  isDraft: z.boolean().default(true),
  items: z.array(itemSchema).optional(),
});

type ShipmentItemInput = z.infer<typeof itemSchema>;

function firstNumber(...values: Array<number | null | undefined>) {
  return values.find((value) => typeof value === "number" && Number.isFinite(value));
}

function getBundleSize(item: ShipmentItemInput) {
  return firstNumber(item.bundleSize, item.bundle_size) ?? 1;
}

function getNeedsBundling(item: ShipmentItemInput) {
  const bundleSize = getBundleSize(item);
  return item.needsBundling ?? item.needs_bundling ?? bundleSize > 1;
}

function getDisplayOrder(item: ShipmentItemInput, index: number) {
  return firstNumber(item.displayOrder, item.display_order, item.itemIndex, item.item_index, item.lineItemIndex, item.line_item_index) ?? index;
}

function buildServiceStatus(services: string[]) {
  return Object.fromEntries(services.map((service) => [service, "PENDING"]));
}

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser(req);
    const shipment = await prisma.shipments.findUnique({
      where: { id: params.id, soft_deleted_at: null },
      include: shipmentContractInclude,
    });
    if (!shipment) throw new ApiError("Shipment not found", 404);
    if (user.role === "client") await requireClientAccess(req, shipment.client_id);
    return success(serializeShipment(shipment));
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser(req);
    const shipment = await prisma.shipments.findFirst({
      where: { id: params.id, soft_deleted_at: null },
    });
    if (!shipment) throw new ApiError("Shipment not found", 404);
    if (shipment.status !== "draft") throw new ApiError("Only draft shipments can be edited", 422);
    if (user.role === "client") await requireClientAccess(req, shipment.client_id);

    const body = await json(req, patchSchema);
    const updated = await prisma.$transaction(async (tx) => {
      const shipmentUpdate = await tx.shipments.update({
        where: { id: params.id },
        data: {
          client_notes: body.notes,
          expected_arrival_date: body.expectedArrivalDate,
          status: body.isDraft ? "draft" : "submitted",
          submitted_at: body.isDraft ? undefined : new Date(),
          submitted_by: body.isDraft ? undefined : user.userId,
          updated_at: new Date(),
        },
      });

      if (body.items) {
        await tx.shipment_line_items.deleteMany({ where: { shipment_id: params.id } });
        for (const [index, item] of body.items.entries()) {
          const bundleSize = getBundleSize(item);
          const needsBundling = getNeedsBundling(item);
          const product = await tx.products.upsert({
            where: { client_id_sku: { client_id: shipment.client_id, sku: item.sku } },
            update: {
              product_name: item.productName,
              default_fnsku: item.fnskuLabel ?? undefined,
              needs_bundling: needsBundling,
              bundle_size: bundleSize,
            },
            create: {
              client_id: shipment.client_id,
              sku: item.sku,
              product_name: item.productName,
              default_fnsku: item.fnskuLabel ?? null,
              length_cm: 0,
              width_cm: 0,
              height_cm: 0,
              weight_kg: 0,
              needs_bundling: needsBundling,
              bundle_size: bundleSize,
            },
          });

          await tx.shipment_line_items.create({
            data: {
              shipment_id: params.id,
              product_id: product.id,
              fnsku: item.fnskuLabel ?? item.sku,
              qty_expected: item.expectedQty,
              dispatch_qty: null,
              needs_bundling: needsBundling,
              bundle_size: bundleSize,
              display_order: getDisplayOrder(item, index),
              services_selected: item.services,
              service_status: buildServiceStatus(item.services),
              discrepancy_notes: item.notes ?? null,
            },
          });
        }
      }

      return tx.shipments.findUniqueOrThrow({
        where: { id: shipmentUpdate.id },
        include: shipmentContractInclude,
      });
    });
    const serializedShipment = serializeShipment(updated);

    await prisma.audit_logs.create({
      data: {
        user_id: user.userId,
        user_email: user.email,
        user_role: user.role,
        action: "shipment.updated",
        entity_type: "shipment",
        entity_id: params.id,
        before_value: { status: shipment.status },
        after_value: JSON.parse(JSON.stringify(serializedShipment)),
      },
    });

    return success(serializedShipment);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser(req);
    const shipment = await prisma.shipments.findFirst({
      where: { id: params.id, soft_deleted_at: null },
      include: {
        shipment_line_items: {
          select: {
            id: true,
            fnsku_label_file_id: true,
          },
        },
        outbound_boxes: {
          select: {
            id: true,
            fba_shipping_label_file_id: true,
          },
        },
      },
    });
    if (!shipment) throw new ApiError("Shipment not found", 404);
    if (user.role === "client") {
      await requireClientAccess(req, shipment.client_id);
    } else if (user.role !== "admin") {
      throw new ApiError("Forbidden", 403);
    }

    const lineItemIds = shipment.shipment_line_items.map((item) => item.id);
    const boxIds = shipment.outbound_boxes.map((box) => box.id);
    const linkedFileIds = [
      ...shipment.shipment_line_items.map((item) => item.fnsku_label_file_id),
      ...shipment.outbound_boxes.map((box) => box.fba_shipping_label_file_id),
    ].filter((id): id is string => Boolean(id));

    const relatedFiles = await prisma.uploaded_files.findMany({
      where: {
        OR: [
          { linked_entity_type: "shipment", linked_entity_id: params.id },
          { linked_entity_type: { in: ["item", "label", "shipment_line_item"] }, linked_entity_id: { in: lineItemIds } },
          { linked_entity_type: { in: ["box", "outbound_box"] }, linked_entity_id: { in: boxIds } },
          { id: { in: linkedFileIds } },
        ],
      },
    });
    const relatedFileIds = [...new Set(relatedFiles.map((file) => file.id))];

    const deletedShipment = await prisma.$transaction(async (tx) => {
      await tx.outbound_boxes.deleteMany({ where: { shipment_id: params.id } });
      await tx.sub_shipments.deleteMany({ where: { parent_shipment_id: params.id } });
      await tx.shipment_line_items.deleteMany({ where: { shipment_id: params.id } });
      await tx.staff_check_ins.deleteMany({ where: { shipment_id: params.id } });
      if (relatedFileIds.length > 0) {
        await tx.uploaded_files.deleteMany({ where: { id: { in: relatedFileIds } } });
      }
      const deleted = await tx.shipments.update({
        where: { id: params.id },
        data: { soft_deleted_at: new Date(), updated_at: new Date() },
      });
      await tx.audit_logs.create({
        data: {
          user_id: user.userId,
          user_email: user.email,
          user_role: user.role,
          action: "shipment.soft_delete",
          entity_type: "shipment",
          entity_id: params.id,
          before_value: JSON.parse(JSON.stringify(shipment)),
          after_value: JSON.parse(JSON.stringify(deleted)),
        },
      });
      return deleted;
    });

    const filesByBucket = new Map<string, string[]>();
    for (const file of relatedFiles) {
      const bucket = bucketFor(file.file_type);
      filesByBucket.set(bucket, [...(filesByBucket.get(bucket) ?? []), file.storage_path]);
    }
    await Promise.all(
      [...filesByBucket.entries()].map(async ([bucket, paths]) => {
        const remove = await supabaseAdmin.storage.from(bucket).remove(paths);
        if (remove.error) {
          console.error("[storage] Failed to remove shipment files:", remove.error);
        }
      })
    );

    return success({ deleted: true, shipment: deletedShipment });
  } catch (err) {
    return handleApiError(err);
  }
}
