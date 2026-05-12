import { z } from "zod";
import { Prisma } from "@prisma/client";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const schema = z.object({
  status: z.enum(["PENDING", "IN_PROGRESS", "DONE", "pending", "in_progress", "done"]),
  unitsDone: z.number().int().min(0).optional(),
  notes: z.string().optional().nullable(),
});

export async function PATCH(req: Request, { params }: { params: { taskId: string } }) {
  try {
    const user = await requireRole(req, ["admin", "staff"]);
    const body = await json(req, schema);
    const [shipmentItemId, serviceType] = params.taskId.split(":");
    if (!shipmentItemId || !serviceType) throw new ApiError("taskId must be shipmentItemId:serviceType", 400);
    const updated = await prisma.$transaction(async (tx) => {
      const item = await tx.shipment_line_items.findUnique({ where: { id: shipmentItemId } });
      if (!item) throw new ApiError("Service task not found", 404);
      if ((body.status === "DONE" || body.status === "done") && body.unitsDone !== (item.qty_received ?? 0)) {
        throw new ApiError("unitsDone must equal item's received quantity", 422);
      }
      const current = (item.service_status as Record<string, unknown> | null) ?? {};
      const nextStatus = body.status.toUpperCase();
      const next = {
        ...current,
        [serviceType]: nextStatus,
        [`${serviceType}:unitsDone`]: body.unitsDone ?? current[`${serviceType}:unitsDone`] ?? 0,
        [`${serviceType}:staffId`]: nextStatus === "IN_PROGRESS" || nextStatus === "DONE" ? user.userId : current[`${serviceType}:staffId`],
        [`${serviceType}:startedAt`]: nextStatus === "IN_PROGRESS" ? new Date().toISOString() : current[`${serviceType}:startedAt`],
        [`${serviceType}:completedAt`]: nextStatus === "DONE" ? new Date().toISOString() : current[`${serviceType}:completedAt`],
        [`${serviceType}:notes`]: body.notes ?? current[`${serviceType}:notes`],
      };
      const line = await tx.shipment_line_items.update({
        where: { id: shipmentItemId },
        data: { service_status: next as Prisma.InputJsonValue, updated_at: new Date() },
      });
      const shipmentItems = await tx.shipment_line_items.findMany({ where: { shipment_id: item.shipment_id } });
      const allDone = shipmentItems.every((shipmentItem) => {
        const selected = shipmentItem.services_selected as string[] | null;
        const statuses = (shipmentItem.id === shipmentItemId ? next : shipmentItem.service_status) as Record<string, string> | null;
        return (selected ?? []).every((service) => statuses?.[service] === "DONE");
      });
      if (allDone) await tx.shipments.update({ where: { id: item.shipment_id }, data: { status: "prepped", updated_at: new Date() } });
      return line;
    });
    return success(updated);
  } catch (err) {
    return handleApiError(err);
  }
}
