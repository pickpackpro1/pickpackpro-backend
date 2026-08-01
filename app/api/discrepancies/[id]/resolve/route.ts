import { ShipmentStatus } from "@prisma/client";
import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { calculateDispatchQty } from "@/lib/businessLogic";
import { prisma } from "@/lib/prisma";
import { serializeShipment, shipmentContractInclude } from "@/lib/shipmentContract";
import { json } from "@/lib/validation";

const schema = z
  .object({
    receivedQty: z.coerce.number().int().min(0).optional(),
    additionalReceivedQty: z.coerce.number().int().min(0).optional(),
    notes: z.string().optional().nullable(),
  })
  .refine((body) => body.receivedQty === undefined || body.additionalReceivedQty === undefined, {
    message: "Use either receivedQty or additionalReceivedQty, not both",
  });

function canMoveToReceived(status: ShipmentStatus) {
  return (
    status === ShipmentStatus.submitted ||
    status === ShipmentStatus.pending_arrival ||
    status === ShipmentStatus.received
  );
}

function getAllocatedBoxQty(contents: unknown, shipmentItemId: string) {
  if (!Array.isArray(contents)) return 0;
  return contents.reduce((sum, item) => {
    if (!item || typeof item !== "object") return sum;
    const row = item as { shipmentItemId?: string; shipment_line_item_id?: string; quantity?: number; qty?: number };
    const rowItemId = row.shipmentItemId ?? row.shipment_line_item_id;
    if (rowItemId !== shipmentItemId) return sum;
    return sum + Number(row.quantity ?? row.qty ?? 0);
  }, 0);
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireRole(req, ["admin", "staff"]);
    const body = await json(req, schema);
    const result = await prisma.$transaction(async (tx) => {
      const item = await tx.shipment_line_items.findUnique({
        where: { id: params.id },
        include: { products: true },
      });
      if (!item) throw new ApiError("Shipment item not found", 404);

      const hasQuantityCorrection = body.receivedQty !== undefined || body.additionalReceivedQty !== undefined;
      const nextReceivedQty = body.receivedQty ?? (body.additionalReceivedQty !== undefined ? (item.qty_received ?? 0) + body.additionalReceivedQty : item.qty_received);

      if (hasQuantityCorrection && nextReceivedQty !== null) {
        const [subShipmentItems, boxes] = await Promise.all([
          tx.sub_shipment_items.findMany({
            where: {
              shipment_line_item_id: item.id,
              sub_shipments: { status: { not: "cancelled" } },
            },
          }),
          tx.outbound_boxes.findMany({ where: { shipment_id: item.shipment_id } }),
        ]);
        const allocatedToSubShipments = subShipmentItems.reduce((sum, subItem) => sum + subItem.quantity, 0);
        const allocatedToBoxes = boxes.reduce((sum, box) => sum + getAllocatedBoxQty(box.contents, item.id), 0);
        const allocatedQty = Math.max(allocatedToSubShipments, allocatedToBoxes);
        if (nextReceivedQty < allocatedQty) {
          throw new ApiError(`Received quantity cannot be less than already allocated quantity (${allocatedQty})`, 422);
        }
      }

      const difference = nextReceivedQty === null ? 0 : nextReceivedQty - item.qty_expected;
      const stillHasDiscrepancy = hasQuantityCorrection ? difference !== 0 : false;
      const bundleSize = item.bundle_size ?? item.products.bundle_size ?? 1;
      const updated = await tx.shipment_line_items.update({
        where: { id: item.id },
        data: {
          ...(hasQuantityCorrection && nextReceivedQty !== null
            ? {
                qty_received: nextReceivedQty,
                dispatch_qty: calculateDispatchQty(nextReceivedQty, bundleSize),
              }
            : {}),
          qty_discrepancy_flag: stillHasDiscrepancy,
          discrepancy_notes: body.notes ?? (stillHasDiscrepancy ? `Expected ${item.qty_expected}, received ${nextReceivedQty}` : null),
          updated_at: new Date(),
        },
        include: { products: true, uploaded_files: true },
      });

      const allItems = await tx.shipment_line_items.findMany({ where: { shipment_id: item.shipment_id } });
      const totalRemainingQty = allItems.reduce(
        (sum, shipmentItem) =>
          sum + Math.max(Number(shipmentItem.qty_expected ?? 0) - Number(shipmentItem.qty_received ?? 0), 0),
        0,
      );
      const receivingComplete =
        allItems.every((shipmentItem) => shipmentItem.qty_received !== null) &&
        totalRemainingQty === 0 &&
        allItems.every((shipmentItem) => !shipmentItem.qty_discrepancy_flag);
      const shipmentStatus = await tx.shipments.findUnique({
        where: { id: item.shipment_id },
        select: { status: true, actual_arrival_date: true },
      });
      const canSetReceivedStatus = shipmentStatus && canMoveToReceived(shipmentStatus.status);

      if (receivingComplete && canSetReceivedStatus) {
        await tx.shipments.update({
          where: { id: item.shipment_id },
          data: {
            status: ShipmentStatus.received,
            actual_arrival_date: shipmentStatus.actual_arrival_date ?? new Date(),
            received_by: user.userId,
            updated_at: new Date(),
          },
        });
      } else if (allItems.some((shipmentItem) => shipmentItem.qty_received !== null)) {
        await tx.shipments.update({
          where: { id: item.shipment_id },
          data: {
            actual_arrival_date: shipmentStatus?.actual_arrival_date ?? new Date(),
            received_by: user.userId,
            updated_at: new Date(),
          },
        });
      }

      await tx.audit_logs.create({
        data: {
          user_id: user.userId,
          user_email: user.email,
          user_role: user.role,
          action: stillHasDiscrepancy ? "discrepancy.updated" : "discrepancy.resolved",
          entity_type: "shipment_line_item",
          entity_id: item.id,
          before_value: JSON.parse(JSON.stringify(item)),
          after_value: JSON.parse(JSON.stringify({ ...updated, difference })),
        },
      });

      const shipment = await tx.shipments.findUniqueOrThrow({
        where: { id: item.shipment_id },
        include: shipmentContractInclude,
      });

      return {
        ...updated,
        difference,
        resolved: !stillHasDiscrepancy,
        totalRemainingQty,
        total_remaining_qty: totalRemainingQty,
        receivingComplete,
        receiving_complete: receivingComplete,
        shipment: serializeShipment(shipment),
      };
    });
    return success(result);
  } catch (err) {
    return handleApiError(err);
  }
}
