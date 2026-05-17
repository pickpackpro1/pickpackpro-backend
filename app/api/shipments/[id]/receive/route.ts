import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { calculateDispatchQty } from "@/lib/businessLogic";
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
      }
    }
    return success(result);
  } catch (err) {
    return handleApiError(err);
  }
}
