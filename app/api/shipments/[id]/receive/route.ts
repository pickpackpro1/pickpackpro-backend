import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { calculateDispatchQty } from "@/lib/businessLogic";
import { sendEmail } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const schema = z.object({
  items: z.array(z.object({ shipmentItemId: z.string().uuid(), receivedQty: z.number().int().min(0) })).min(1),
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireRole(req, ["admin", "staff"]);
    const body = await json(req, schema);
    const result = await prisma.$transaction(async (tx) => {
      const discrepancies = [];
      for (const received of body.items) {
        const item = await tx.shipment_line_items.findUnique({
          where: { id: received.shipmentItemId },
          include: { products: true },
        });
        if (!item || item.shipment_id !== params.id) throw new ApiError("Shipment item not found", 404);
        const bundleSize = item.products.bundle_size ?? 1;
        const difference = received.receivedQty - item.qty_expected;
        const updated = await tx.shipment_line_items.update({
          where: { id: item.id },
          data: {
            qty_received: received.receivedQty,
            dispatch_qty: calculateDispatchQty(received.receivedQty, bundleSize),
            qty_discrepancy_flag: difference !== 0,
            discrepancy_notes: difference !== 0 ? `Expected ${item.qty_expected}, received ${received.receivedQty}` : item.discrepancy_notes,
            updated_at: new Date(),
          },
        });
        if (difference !== 0) discrepancies.push({ ...updated, difference });
      }
      const allItems = await tx.shipment_line_items.findMany({ where: { shipment_id: params.id } });
      const allReceived = allItems.every((item) => item.qty_received !== null);
      if (allReceived) {
        await tx.shipments.update({
          where: { id: params.id },
          data: { status: "received", actual_arrival_date: new Date(), received_by: user.userId, updated_at: new Date() },
        });
      }
      return { discrepancies, status: allReceived ? "received" : undefined };
    });
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
        await prisma.notifications.create({
          data: {
            user_id: clientUser.id,
            type: result.discrepancies.length > 0 ? "discrepancy_flagged" : "shipment_received",
            title: result.discrepancies.length > 0 ? "Discrepancy Flagged" : "Shipment Received",
            body: result.discrepancies.length > 0
              ? `Discrepancy found in shipment ${shipment.reference}.`
              : `Your shipment ${shipment.reference} has been received at the warehouse.`,
            link_url: `/shipments/${params.id}`,
          },
        });
        try {
          if (result.discrepancies.length > 0) {
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
