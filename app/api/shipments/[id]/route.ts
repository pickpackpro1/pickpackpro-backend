import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireClientAccess, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser(req);
    const shipment = await prisma.shipments.findUnique({
      where: { id: params.id },
      include: {
        clients: true,
        shipment_line_items: { include: { products: true } },
        outbound_boxes: true,
        staff_check_ins: true,
      },
    });
    if (!shipment) throw new ApiError("Shipment not found", 404);
    if (user.role === "client") await requireClientAccess(req, shipment.client_id);
    const discrepancies = shipment.shipment_line_items.filter((item) => item.qty_discrepancy_flag);
    return success({ ...shipment, discrepancies });
  } catch (err) {
    return handleApiError(err);
  }
}
