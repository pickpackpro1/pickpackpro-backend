import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    const user = await requireRole(req, ["admin", "staff"]);
    const today = new Date();
    today.setHours(23, 59, 59, 999);

    const [
      myAssignedShipments,
      unassignedShipments,
      pendingArrivals,
      awaitingFbaLabels,
      myCheckIns,
    ] = await Promise.all([
      prisma.shipments.findMany({
        where: {
          assigned_to: user.userId,
          status: { notIn: ["completed", "dispatched"] },
          soft_deleted_at: null,
        },
        include: { clients: true, shipment_line_items: { include: { products: true } }, outbound_boxes: true },
        orderBy: { expected_arrival_date: "asc" },
      }),
      prisma.shipments.findMany({
        where: {
          assigned_to: null,
          status: { in: ["received", "in_progress"] },
          soft_deleted_at: null,
        },
        include: { clients: true, shipment_line_items: { include: { products: true } }, outbound_boxes: true },
        orderBy: { expected_arrival_date: "asc" },
      }),
      prisma.shipments.findMany({
        where: {
          status: { in: ["pending_arrival", "submitted"] },
          expected_arrival_date: { lte: today },
          soft_deleted_at: null,
        },
        include: { clients: true, shipment_line_items: { include: { products: true } }, outbound_boxes: true },
        orderBy: { expected_arrival_date: "asc" },
      }),
      prisma.outbound_boxes.findMany({
        where: {
          fba_shipping_label_file_id: null,
          pallet_id: null,
          shipments: { status: "prepped", soft_deleted_at: null },
        },
        include: { shipments: { include: { clients: true } } },
        orderBy: { created_at: "asc" },
      }),
      prisma.staff_check_ins.findMany({
        where: { user_id: user.userId, checked_out_at: null },
        include: { shipments: true },
        orderBy: { checked_in_at: "desc" },
      }),
    ]);

    return success({
      myAssignedShipments,
      unassignedShipments,
      pendingArrivals,
      awaitingFbaLabels,
      myCheckIns,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
