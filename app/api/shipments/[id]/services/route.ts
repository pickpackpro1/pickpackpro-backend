import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireClientAccess, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser(req);
    const shipment = await prisma.shipments.findUnique({
      where: { id: params.id },
      include: { shipment_line_items: { include: { products: true } } },
    });
    if (!shipment) throw new ApiError("Shipment not found", 404);
    if (user.role === "client") await requireClientAccess(req, shipment.client_id);
    const tasks = shipment.shipment_line_items.flatMap((item) => {
      const selected = item.services_selected as string[] | null;
      const statuses = item.service_status as Record<string, string> | null;
      return (selected ?? []).map((service) => ({
        id: `${item.id}:${service}`,
        shipmentItemId: item.id,
        serviceType: service,
        status: statuses?.[service] ?? "PENDING",
        unitsDone: statuses?.[`${service}:unitsDone`] ?? 0,
        product: item.products,
      }));
    });
    const grouped = tasks.reduce<Record<string, typeof tasks>>((acc, task) => {
      acc[task.serviceType] ??= [];
      acc[task.serviceType].push(task);
      return acc;
    }, {});
    return success({ tasks, grouped });
  } catch (err) {
    return handleApiError(err);
  }
}
