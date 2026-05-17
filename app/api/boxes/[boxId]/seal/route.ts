import { z } from "zod";
import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const schema = z.object({ trackingCode: z.string().optional().nullable() });

export async function PATCH(req: Request, { params }: { params: { boxId: string } }) {
  try {
    const user = await requireRole(req, ["admin", "staff"]);
    await json(req, schema);
    const box = await prisma.$transaction(async (tx) => {
      const updatedBox = await tx.outbound_boxes.update({
        where: { id: params.boxId },
        data: { dispatched_at: new Date() },
      });
      const boxes = await tx.outbound_boxes.findMany({
        where: { shipment_id: updatedBox.shipment_id },
      });
      if (boxes.every((box) => box.dispatched_at !== null)) {
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
    return success(box);
  } catch (err) {
    return handleApiError(err);
  }
}
