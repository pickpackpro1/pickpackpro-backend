import { Prisma, ShipmentStatus } from "@prisma/client";
import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { calculateDispatchQty } from "@/lib/businessLogic";
import { sendEmail } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const receiveItemSchema = z
  .object({
    shipmentItemId: z.string().uuid(),
    receivedQty: z.coerce.number().int().min(0).optional(),
    additionalReceivedQty: z.coerce.number().int().min(0).optional(),
  })
  .superRefine((item, ctx) => {
    if (item.receivedQty === undefined && item.additionalReceivedQty === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["receivedQty"],
        message: "receivedQty is required",
      });
    }
    if (item.receivedQty !== undefined && item.additionalReceivedQty !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["additionalReceivedQty"],
        message: "Use either receivedQty or additionalReceivedQty, not both",
      });
    }
  });

const schema = z.object({
  items: z.array(receiveItemSchema).min(1),
});

const RECEIVE_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 60_000,
};

function receivedDelta(item: z.infer<typeof receiveItemSchema>) {
  return item.additionalReceivedQty ?? item.receivedQty ?? 0;
}

function canMoveToReceived(status: ShipmentStatus) {
  return (
    status === ShipmentStatus.submitted ||
    status === ShipmentStatus.pending_arrival ||
    status === ShipmentStatus.received
  );
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireRole(req, ["admin", "staff"]);
    const body = await json(req, schema);
    const receivedQtyByItemId = new Map<string, number>();
    for (const received of body.items) {
      receivedQtyByItemId.set(
        received.shipmentItemId,
        (receivedQtyByItemId.get(received.shipmentItemId) ?? 0) + receivedDelta(received),
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      const shipment = await tx.shipments.findUnique({
        where: { id: params.id },
        select: { id: true, status: true, actual_arrival_date: true },
      });
      if (!shipment) throw new ApiError("Shipment not found", 404);

      const allItems = await tx.shipment_line_items.findMany({
        where: { shipment_id: params.id },
        include: { products: { select: { bundle_size: true } } },
      });
      const itemById = new Map(allItems.map((item) => [item.id, item]));
      const missingItemId = [...receivedQtyByItemId.keys()].find((itemId) => !itemById.has(itemId));
      if (missingItemId) throw new ApiError("Shipment item not found", 404, { shipmentItemId: missingItemId });

      const now = new Date();
      const updates = [...receivedQtyByItemId.entries()].map(([shipmentItemId, qtyToReceive]) => {
        const item = itemById.get(shipmentItemId);
        if (!item) throw new ApiError("Shipment item not found", 404, { shipmentItemId });
        const bundleSize = item.products.bundle_size ?? 1;
        const nextReceivedQty = (item.qty_received ?? 0) + qtyToReceive;
        const difference = nextReceivedQty - item.qty_expected;
        const hasDiscrepancy = difference !== 0;
        return {
          id: item.id,
          qtyReceived: nextReceivedQty,
          dispatchQty: calculateDispatchQty(nextReceivedQty, bundleSize),
          qtyDiscrepancyFlag: hasDiscrepancy,
          discrepancyNotes: hasDiscrepancy ? `Expected ${item.qty_expected}, received ${nextReceivedQty}` : null,
        };
      });

      await tx.$executeRaw`
        update shipment_line_items as item
        set
          qty_received = updates.qty_received,
          dispatch_qty = updates.dispatch_qty,
          qty_discrepancy_flag = updates.qty_discrepancy_flag,
          discrepancy_notes = updates.discrepancy_notes,
          updated_at = ${now}
        from (
          values ${Prisma.join(
            updates.map((update) =>
              Prisma.sql`(${update.id}::uuid, ${update.qtyReceived}::integer, ${update.dispatchQty}::integer, ${update.qtyDiscrepancyFlag}::boolean, ${update.discrepancyNotes}::text)`,
            ),
          )}
        ) as updates(id, qty_received, dispatch_qty, qty_discrepancy_flag, discrepancy_notes)
        where item.id = updates.id
          and item.shipment_id = ${params.id}::uuid
      `;

      const updateById = new Map(updates.map((update) => [update.id, update]));
      const lineItems = allItems.map(({ products, ...item }) => {
        const update = updateById.get(item.id);
        const qtyReceived = update?.qtyReceived ?? item.qty_received;
        const dispatchQty = update?.dispatchQty ?? item.dispatch_qty;
        const qtyDiscrepancyFlag = update?.qtyDiscrepancyFlag ?? item.qty_discrepancy_flag;
        const discrepancyNotes = update ? update.discrepancyNotes : item.discrepancy_notes;
        const expectedQty = Number(item.qty_expected ?? 0);
        const receivedQty = Number(qtyReceived ?? 0);
        const remainingQty = Math.max(expectedQty - receivedQty, 0);
        const difference = receivedQty - expectedQty;
        return {
          ...item,
          qty_received: qtyReceived,
          dispatch_qty: dispatchQty,
          qty_discrepancy_flag: qtyDiscrepancyFlag,
          discrepancy_notes: discrepancyNotes,
          updated_at: update ? now : item.updated_at,
          expectedQty,
          expected_qty: expectedQty,
          receivedQty,
          received_qty: receivedQty,
          remainingQty,
          remaining_qty: remainingQty,
          difference,
          differenceQty: difference,
          difference_qty: difference,
        };
      });
      const totalExpectedQty = lineItems.reduce((sum, item) => sum + item.expectedQty, 0);
      const totalReceivedQty = lineItems.reduce((sum, item) => sum + item.receivedQty, 0);
      const totalRemainingQty = lineItems.reduce((sum, item) => sum + item.remainingQty, 0);
      const discrepancies = lineItems.filter((item) => item.qty_discrepancy_flag);
      const receivingComplete =
        lineItems.every((item) => item.qty_received !== null) &&
        totalRemainingQty === 0 &&
        discrepancies.length === 0;
      const canSetReceivedStatus = canMoveToReceived(shipment.status);

      if (receivingComplete && canSetReceivedStatus) {
        await tx.shipments.update({
          where: { id: params.id },
          data: {
            status: ShipmentStatus.received,
            actual_arrival_date: shipment.actual_arrival_date ?? new Date(),
            received_by: user.userId,
            updated_at: new Date(),
          },
        });
      } else {
        await tx.shipments.update({
          where: { id: params.id },
          data: {
            actual_arrival_date: shipment.actual_arrival_date ?? new Date(),
            received_by: user.userId,
            updated_at: new Date(),
          },
        });
      }

      return {
        discrepancies,
        lineItems,
        line_items: lineItems,
        totalExpectedQty,
        total_expected_qty: totalExpectedQty,
        totalReceivedQty,
        total_received_qty: totalReceivedQty,
        totalRemainingQty,
        total_remaining_qty: totalRemainingQty,
        receivingComplete,
        receiving_complete: receivingComplete,
        status: receivingComplete && canSetReceivedStatus ? ShipmentStatus.received : shipment.status,
      };
    }, RECEIVE_TRANSACTION_OPTIONS);
    await prisma.audit_logs.create({
      data: {
        user_id: user.userId,
        user_email: user.email,
        user_role: user.role,
        action: "shipment.received",
        entity_type: "shipment",
        entity_id: params.id,
        after_value: JSON.parse(JSON.stringify(result)),
      },
    });
    const shipment = await prisma.shipments.findUnique({
      where: { id: params.id },
      select: { client_id: true, reference: true },
    });
    if (shipment) {
      const clientUser = await prisma.users.findFirst({
        where: { client_id: shipment.client_id, role: "client" },
      });
      if (clientUser) {
        const hasReceivingIssue = !result.receivingComplete || result.discrepancies.length > 0;
        await prisma.notifications.create({
          data: {
            user_id: clientUser.id,
            type: hasReceivingIssue ? "discrepancy_flagged" : "shipment_received",
            title: hasReceivingIssue ? "Discrepancy Flagged" : "Shipment Received",
            body: hasReceivingIssue
              ? `Discrepancy found in shipment ${shipment.reference}.`
              : `Your shipment ${shipment.reference} has been received at the warehouse.`,
            link_url: `/shipments/${params.id}`,
          },
        });
        try {
          if (hasReceivingIssue) {
            await sendEmail({
              to: clientUser.email,
              subject: `Discrepancy Found — ${shipment.reference}`,
              html: `<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6f9;padding:40px 0;font-family:Arial,sans-serif;">
  <tr>
    <td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr>
          <td style="background-color:#132347;padding:28px 40px;">
            <div style="color:#ffffff;font-size:20px;font-weight:bold;">📦 PickPackPro</div>
            <div style="color:#8899bb;font-size:12px;margin-top:4px;">Warehouse Management System</div>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 40px 4px 40px;">
            <div style="background-color:#ef4444;height:4px;border-radius:2px;"></div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px;">
            <h2 style="color:#132347;font-size:20px;font-weight:bold;margin:0 0 8px 0;">Discrepancy Found ⚠️</h2>
            <p style="color:#ef4444;font-size:14px;font-weight:bold;margin:0 0 24px 0;">Quantity mismatch detected</p>
            <p style="color:#555555;font-size:15px;line-height:1.6;margin:0 0 16px 0;">
              Your shipment has been received at our warehouse, however a discrepancy was found between the expected and received quantities. Please log in to review the details.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#fff5f5;border-radius:6px;border:1px solid #fecaca;margin:0 0 28px 0;">
              <tr>
                <td style="padding:16px 20px;">
                  <div style="color:#888888;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Shipment Reference</div>
                  <div style="color:#132347;font-size:18px;font-weight:bold;">${shipment.reference}</div>
                </td>
              </tr>
            </table>
            <table cellpadding="0" cellspacing="0">
              <tr>
                <td style="background-color:#FF6B2C;border-radius:6px;padding:12px 24px;">
                  <a href="${process.env.FRONTEND_URL}/shipments" style="color:#ffffff;font-size:14px;font-weight:bold;text-decoration:none;">View Details →</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="background-color:#f4f6f9;padding:20px 40px;border-top:1px solid #e8ecf0;text-align:center;">
            <p style="color:#aaaaaa;font-size:12px;margin:0;">© 2026 Pick Pack Pro · pickpackpro.co.uk</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`,
            });
          } else {
            await sendEmail({
              to: clientUser.email,
              subject: `Shipment Received — ${shipment.reference}`,
              html: `<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6f9;padding:40px 0;font-family:Arial,sans-serif;">
  <tr>
    <td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr>
          <td style="background-color:#132347;padding:28px 40px;">
            <div style="color:#ffffff;font-size:20px;font-weight:bold;">📦 PickPackPro</div>
            <div style="color:#8899bb;font-size:12px;margin-top:4px;">Warehouse Management System</div>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 40px 4px 40px;">
            <div style="background-color:#22c55e;height:4px;border-radius:2px;"></div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px;">
            <h2 style="color:#132347;font-size:20px;font-weight:bold;margin:0 0 8px 0;">Shipment Received ✓</h2>
            <p style="color:#22c55e;font-size:14px;font-weight:bold;margin:0 0 24px 0;">All quantities confirmed</p>
            <p style="color:#555555;font-size:15px;line-height:1.6;margin:0 0 16px 0;">
              Great news! Your shipment has been received at our warehouse and all quantities have been verified. We will begin processing shortly.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border-radius:6px;border:1px solid #e8ecf0;margin:0 0 28px 0;">
              <tr>
                <td style="padding:16px 20px;">
                  <div style="color:#888888;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Shipment Reference</div>
                  <div style="color:#132347;font-size:18px;font-weight:bold;">${shipment.reference}</div>
                </td>
              </tr>
            </table>
            <table cellpadding="0" cellspacing="0">
              <tr>
                <td style="background-color:#FF6B2C;border-radius:6px;padding:12px 24px;">
                  <a href="${process.env.FRONTEND_URL}/shipments" style="color:#ffffff;font-size:14px;font-weight:bold;text-decoration:none;">Track Shipment →</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="background-color:#f4f6f9;padding:20px 40px;border-top:1px solid #e8ecf0;text-align:center;">
            <p style="color:#aaaaaa;font-size:12px;margin:0;">© 2026 Pick Pack Pro · pickpackpro.co.uk</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`,
            });
          }
        } catch (emailErr) {
          console.error("[email] Failed to send shipment received email:", emailErr);
        }
      }
    }
    return success(result);
  } catch (err) {
    return handleApiError(err);
  }
}
