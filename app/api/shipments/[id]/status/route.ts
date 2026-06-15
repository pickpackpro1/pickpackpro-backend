import { ShipmentStatus } from "@prisma/client";
import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { assertTransition } from "@/lib/businessLogic";
import { sendEmail } from "@/lib/email";
import { ensureShipmentDraftInvoice } from "@/lib/invoicing";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const schema = z.object({ status: z.nativeEnum(ShipmentStatus) });

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireRole(req, ["admin", "staff"]);
    const body = await json(req, schema);
    const shipment = await prisma.shipments.findUnique({
      where: { id: params.id },
      include: { shipment_line_items: true },
    });
    if (!shipment) throw new ApiError("Shipment not found", 404);
    await assertTransition(prisma, shipment, body.status);
    const updated = await prisma.shipments.update({
      where: { id: params.id },
      data: {
        status: body.status,
        updated_at: new Date(),
        dispatched_date: body.status === "dispatched" ? new Date() : undefined,
        completed_date: body.status === "completed" ? new Date() : undefined,
      },
    });
    if (body.status === "dispatched") {
      await ensureShipmentDraftInvoice(prisma, updated.id, user.userId);
      const clientUser = await prisma.users.findFirst({
        where: { client_id: shipment.client_id, role: "client" },
      });
      if (clientUser) {
        await prisma.notifications.create({
          data: {
            user_id: clientUser.id,
            type: "shipment_dispatched",
            title: "Shipment Dispatched",
            body: `Your shipment ${shipment.reference} has been dispatched to Amazon.`,
            link_url: `/shipments`,
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
            <div style="background-color:#FF6B2C;height:4px;border-radius:2px;"></div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px;">
            <h2 style="color:#132347;font-size:20px;font-weight:bold;margin:0 0 8px 0;">Shipment Dispatched 🚚</h2>
            <p style="color:#FF6B2C;font-size:14px;font-weight:bold;margin:0 0 24px 0;">On its way to Amazon</p>
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
                  <a href="${process.env.FRONTEND_URL}/shipments" style="color:#ffffff;font-size:14px;font-weight:bold;text-decoration:none;">Track Shipment →</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="background-color:#f4f6f9;padding:20px 40px;border-top:1px solid #e8ecf0;text-align:center;">
            <p style="color:#aaaaaa;font-size:12px;margin:0;">©️ 2026 Pick Pack Pro · pickpackpro.co.uk</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`,
          });
        } catch (emailErr) {
          console.error("[email] Failed to send dispatch email:", emailErr);
        }
      }
    }
    await prisma.audit_logs.create({
      data: {
        user_id: user.userId,
        user_email: user.email,
        user_role: user.role,
        action: "shipment.status_changed",
        entity_type: "shipment",
        entity_id: params.id,
        before_value: { status: shipment.status },
        after_value: { status: updated.status },
      },
    });
    return success(updated);
  } catch (err) {
    return handleApiError(err);
  }
}
