import { z } from "zod";
import { Prisma } from "@prisma/client";
import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const schema = z.object({
  serviceType: z.string().min(1),
  status: z.enum(["PENDING", "IN_PROGRESS", "DONE", "pending", "in_progress", "done"]),
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireRole(req, ["admin", "staff"]);
    const body = await json(req, schema);
    const result = await prisma.$transaction(async (tx) => {
      const items = await tx.shipment_line_items.findMany({ where: { shipment_id: params.id } });
      for (const item of items) {
        const selected = item.services_selected as string[] | null;
        if (!(selected ?? []).includes(body.serviceType)) continue;
        const current = (item.service_status as Record<string, unknown> | null) ?? {};
        await tx.shipment_line_items.update({
          where: { id: item.id },
          data: {
            service_status: {
              ...current,
              [body.serviceType]: body.status.toUpperCase(),
              [`${body.serviceType}:staffId`]: user.userId,
              [`${body.serviceType}:completedAt`]: body.status.toUpperCase() === "DONE" ? new Date().toISOString() : current[`${body.serviceType}:completedAt`],
            } as Prisma.InputJsonValue,
            updated_at: new Date(),
          },
        });
      }
      return tx.shipment_line_items.findMany({ where: { shipment_id: params.id } });
    });
    return success(result);
  } catch (err) {
    return handleApiError(err);
  }
}
