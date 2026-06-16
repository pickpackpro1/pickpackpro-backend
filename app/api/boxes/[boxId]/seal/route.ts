import { z } from "zod";
import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { sendEmail } from "@/lib/email";
import { ensureShipmentDraftInvoice, ensureSubShipmentDraftInvoice } from "@/lib/invoicing";
import { areDispatchableBoxesDispatched, dispatchBoxOrPallet } from "@/lib/pallets";
import { prisma } from "@/lib/prisma";
import { refreshSubShipmentStatusFromBoxes } from "@/lib/subShipments";
import { json } from "@/lib/validation";

const schema = z.object({ trackingCode: z.string().optional().nullable() });

export async function PATCH(req: Request, { params }: { params: { boxId: string } }) {
  try {
    const user = await requireRole(req, ["admin", "staff"]);
    await json(req, schema);
    const box = await prisma.$transaction(async (tx) => {
      const updatedBox = await dispatchBoxOrPallet(tx, params.boxId);
      if (updatedBox.sub_shipment_id) {
        await refreshSubShipmentStatusFromBoxes(tx, updatedBox.sub_shipment_id, user.userId);
      }
      const boxes = await tx.outbound_boxes.findMany({
        where: { shipment_id: updatedBox.shipment_id, sub_shipment_id: null },
      });
      const subShipmentCount = await tx.sub_shipments.count({
        where: { parent_shipment_id: updatedBox.shipment_id, status: { not: "cancelled" } },
      });
      if (!updatedBox.sub_shipment_id && subShipmentCount === 0 && areDispatchableBoxesDispatched(boxes)) {
        const shipment = await tx.shipments.update({
          where: { id: updatedBox.shipment_id },
          data: { status: "dispatched", dispatched_date: new Date(), updated_at: new Date() },
        });
        await tx.audit_logs.create({
          data: {
            user_id: user.userId,
            user_email: user.email,
            user_role: user.role,
            action: "shipment.status_changed",
            entity_type: "shipment",
            entity_id: shipment.id,
            before_value: { status: "prepped" },
            after_value: { status: "dispatched" },
          },
        });
        const clientUser = await tx.users.findFirst({
          where: { client_id: shipment.client_id, role: "client" },
        });
        if (clientUser) {
          await tx.notifications.create({
            data: {
              user_id: clientUser.id,
              type: "shipment_dispatched",
              title: "Shipment Dispatched",
              body: `Your shipment ${shipment.reference} has been dispatched to Amazon.`,
              link_url: "/shipments",
            },
          });
          try {
            await sendEmail({
              to: clientUser.email,
              subject: `Shipment Dispatched — ${shipment.reference}`,
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
            <h2 style="color:#132347;font-size:20px;font-weight:bold;margin:0 0 8px 0;">Shipment Dispatched 🚀</h2>
            <p style="color:#22c55e;font-size:14px;font-weight:bold;margin:0 0 24px 0;">On its way to Amazon</p>
            <p style="color:#555555;font-size:15px;line-height:1.6;margin:0 0 16px 0;">
              Your shipment has been dispatched from our warehouse and is on its way to the Amazon fulfilment centre.
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
                  <a href="${process.env.FRONTEND_URL}/shipments" style="color:#ffffff;font-size:14px;font-weight:bold;text-decoration:none;">View Shipment →</a>
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
          } catch (emailErr) {
            console.error("[email] Failed to send shipment dispatched email:", emailErr);
          }
        }
      }
      await tx.audit_logs.create({
        data: {
          user_id: user.userId,
          user_email: user.email,
          user_role: user.role,
          action: "box.dispatched",
          entity_type: "box",
          entity_id: params.boxId,
          after_value: JSON.parse(JSON.stringify(updatedBox)),
        },
      });
      return updatedBox;
    });
    if (box.sub_shipment_id) {
      const subShipment = await prisma.sub_shipments.findUnique({
        where: { id: box.sub_shipment_id },
        select: { id: true, parent_shipment_id: true, status: true },
      });
      if (subShipment?.status === "dispatched" || subShipment?.status === "completed") {
        await ensureSubShipmentDraftInvoice(prisma, subShipment.id, user.userId);
      }
      if (subShipment) {
        const parentShipment = await prisma.shipments.findUnique({
          where: { id: subShipment.parent_shipment_id },
          select: { id: true, status: true },
        });
        if (parentShipment?.status === "dispatched" || parentShipment?.status === "completed") {
          await ensureShipmentDraftInvoice(prisma, parentShipment.id, user.userId);
        }
      }
    } else {
      const shipment = await prisma.shipments.findUnique({
        where: { id: box.shipment_id },
        select: { id: true, status: true },
      });
      if (shipment?.status === "dispatched" || shipment?.status === "completed") {
        await ensureShipmentDraftInvoice(prisma, shipment.id, user.userId);
      }
    }
    return success(box);
  } catch (err) {
    return handleApiError(err);
  }
}
