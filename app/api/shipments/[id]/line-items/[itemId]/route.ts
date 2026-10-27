import { Prisma } from "@prisma/client";
import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { correctionAudit, getLineItemUsage, isFinalShipmentStatus } from "@/lib/adminCorrections";
import { requireRole } from "@/lib/auth";
import { calculateDispatchQty } from "@/lib/businessLogic";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const patchSchema = z
  .object({
    sku: z.string().trim().min(1).max(120).optional(),
    fnsku: z.string().trim().min(1).max(40).optional(),
    barcode: z.string().trim().max(40).nullable().optional(),
    productName: z.string().trim().min(1).max(300).nullable().optional(),
    qtyExpected: z.coerce.number().int().min(0).max(1_000_000).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "Nothing to change" });

const lineItemInclude = {
  products: true,
  shipments: { select: { id: true, status: true, client_id: true, reference: true, soft_deleted_at: true } },
} satisfies Prisma.shipment_line_itemsInclude;

function snapshot(item: {
  id: string;
  product_id: string;
  product_name: string | null;
  fnsku: string;
  barcode: string | null;
  qty_expected: number;
  qty_received: number | null;
  dispatch_qty: number | null;
  qty_discrepancy_flag: boolean;
  fnsku_label_file_id: string | null;
  products: { sku: string };
}) {
  return {
    lineItemId: item.id,
    productId: item.product_id,
    sku: item.products.sku,
    productName: item.product_name,
    fnsku: item.fnsku,
    barcode: item.barcode,
    qtyExpected: item.qty_expected,
    qtyReceived: item.qty_received,
    dispatchQty: item.dispatch_qty,
    discrepancy: item.qty_discrepancy_flag,
    labelFileId: item.fnsku_label_file_id,
  };
}

// Admin correction of a line a client got wrong after submitting: SKU, FNSKU, barcode, name, expected qty.
export async function PATCH(req: Request, { params }: { params: { id: string; itemId: string } }) {
  try {
    const user = await requireRole(req, ["admin"]);
    const body = await json(req, patchSchema);

    const result = await prisma.$transaction(async (tx) => {
      const item = await tx.shipment_line_items.findUnique({ where: { id: params.itemId }, include: lineItemInclude });
      if (!item || item.shipment_id !== params.id || item.shipments.soft_deleted_at) {
        throw new ApiError("Shipment line not found", 404);
      }

      const usage = await getLineItemUsage(tx, params.id, item.id);
      const lockedForBilling = isFinalShipmentStatus(item.shipments.status) || usage.inFinalSubShipment;

      let newProduct: (typeof item)["products"] | null = null;
      if (body.sku !== undefined) {
        const found = await tx.products.findFirst({
          where: { client_id: item.shipments.client_id, sku: { equals: body.sku, mode: "insensitive" }, soft_deleted_at: null },
        });
        if (!found) {
          throw new ApiError(
            `This client has no product with SKU "${body.sku}". Add it under Products first, then try again.`,
            404,
            { code: "SKU_NOT_FOUND" },
          );
        }
        if (found.id !== item.product_id) newProduct = found;
      }

      if (newProduct) {
        if (lockedForBilling) {
          throw new ApiError("This shipment has already been dispatched and invoiced, so its SKU can't be changed.", 422, {
            code: "LINE_LOCKED",
          });
        }
        if (usage.boxedQty > 0 || usage.subShipmentQty > 0) {
          throw new ApiError(
            "This line is already packed into boxes or a sub-shipment. Remove it from those first, then change the SKU.",
            422,
            { code: "LINE_IN_USE", boxedQty: usage.boxedQty, subShipmentQty: usage.subShipmentQty },
          );
        }
      }

      const qtyChanging = body.qtyExpected !== undefined && body.qtyExpected !== item.qty_expected;
      if (qtyChanging) {
        if (lockedForBilling) {
          throw new ApiError("This shipment has already been dispatched and invoiced, so its quantity can't be changed.", 422, {
            code: "LINE_LOCKED",
          });
        }
        const floor = Math.max(usage.boxedQty, usage.subShipmentQty);
        if (body.qtyExpected! < floor) {
          throw new ApiError(
            `${floor} units are already packed or assigned, so the quantity can't go below ${floor}. Remove them from the boxes first.`,
            422,
            { code: "QTY_BELOW_ALLOCATED", allocated: floor },
          );
        }
      }

      const data: Prisma.shipment_line_itemsUncheckedUpdateInput = { updated_at: new Date() };
      const effectiveProduct = newProduct ?? item.products;

      if (newProduct) {
        data.product_id = newProduct.id;
        data.product_name = body.productName === undefined ? newProduct.product_name : body.productName;
        data.barcode = body.barcode === undefined ? newProduct.barcode : body.barcode || null;
        data.fnsku = body.fnsku ?? newProduct.default_fnsku ?? item.fnsku;
        data.needs_bundling = newProduct.needs_bundling;
        data.bundle_size = newProduct.bundle_size ?? 1;
      } else {
        if (body.fnsku !== undefined) data.fnsku = body.fnsku;
        if (body.barcode !== undefined) data.barcode = body.barcode || null;
        if (body.productName !== undefined) data.product_name = body.productName;
      }

      const nextExpected = body.qtyExpected ?? item.qty_expected;
      if (body.qtyExpected !== undefined) data.qty_expected = nextExpected;

      // Already counted in at receiving: re-check it against the corrected expectation.
      if (item.qty_received !== null && (qtyChanging || newProduct)) {
        const difference = item.qty_received - nextExpected;
        data.dispatch_qty = calculateDispatchQty(item.qty_received, effectiveProduct.bundle_size ?? 1);
        data.qty_discrepancy_flag = difference !== 0;
        data.discrepancy_notes = difference !== 0 ? `Expected ${nextExpected}, received ${item.qty_received}` : null;
      }

      const updated = await tx.shipment_line_items.update({ where: { id: item.id }, data, include: { products: true } });
      await tx.shipments.update({ where: { id: params.id }, data: { updated_at: new Date() } });

      const before = snapshot(item);
      const after = snapshot(updated);
      await tx.audit_logs.create({
        data: correctionAudit(user, "shipment_line.corrected", "shipment_line_item", item.id, before, {
          ...after,
          shipmentReference: item.shipments.reference,
        }),
      });

      return {
        lineItem: after,
        // The label on file was made for the old FNSKU — staff should replace it.
        labelMayNeedReplacing: Boolean(item.fnsku_label_file_id) && before.fnsku !== after.fnsku,
      };
    });

    return success(result);
  } catch (err) {
    return handleApiError(err);
  }
}

// Admin removal of a line a client added by mistake. Only while nothing has been packed from it.
export async function DELETE(req: Request, { params }: { params: { id: string; itemId: string } }) {
  try {
    const user = await requireRole(req, ["admin"]);

    const result = await prisma.$transaction(async (tx) => {
      const item = await tx.shipment_line_items.findUnique({ where: { id: params.itemId }, include: lineItemInclude });
      if (!item || item.shipment_id !== params.id || item.shipments.soft_deleted_at) {
        throw new ApiError("Shipment line not found", 404);
      }

      const usage = await getLineItemUsage(tx, params.id, item.id);
      if (isFinalShipmentStatus(item.shipments.status) || usage.inFinalSubShipment) {
        throw new ApiError("This shipment has already been dispatched and invoiced, so its lines can't be deleted.", 422, {
          code: "LINE_LOCKED",
        });
      }
      if (usage.boxedQty > 0 || usage.subShipmentQty > 0) {
        throw new ApiError(
          "This line is already packed into boxes or a sub-shipment. Remove it from those first, then delete it.",
          422,
          { code: "LINE_IN_USE", boxedQty: usage.boxedQty, subShipmentQty: usage.subShipmentQty },
        );
      }
      const lineCount = await tx.shipment_line_items.count({ where: { shipment_id: params.id } });
      if (lineCount <= 1) {
        throw new ApiError("This is the only line on the shipment. Delete the whole shipment instead.", 422, {
          code: "LAST_LINE",
        });
      }

      await tx.shipment_line_items.delete({ where: { id: item.id } });
      await tx.shipments.update({ where: { id: params.id }, data: { updated_at: new Date() } });
      await tx.audit_logs.create({
        data: correctionAudit(user, "shipment_line.deleted", "shipment_line_item", item.id, {
          ...snapshot(item),
          shipmentReference: item.shipments.reference,
        }, null),
      });
      return { deleted: true, lineItemId: item.id };
    });

    return success(result);
  } catch (err) {
    return handleApiError(err);
  }
}
