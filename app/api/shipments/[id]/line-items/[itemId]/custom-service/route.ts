import { Prisma } from "@prisma/client";
import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

type CustomService = {
  name: string;
  price: number;
  status: "PENDING" | "IN_PROGRESS" | "DONE";
};

const createSchema = z.object({
  name: z.string().min(1),
  price: z.number().nonnegative(),
});

const patchSchema = z.object({
  name: z.string().min(1),
  status: z.enum(["PENDING", "IN_PROGRESS", "DONE"]),
});

async function findLineItem(shipmentId: string, itemId: string) {
  const shipment = await prisma.shipments.findFirst({
    where: { id: shipmentId, soft_deleted_at: null },
    select: { id: true },
  });
  if (!shipment) throw new ApiError("Shipment not found", 404);

  const lineItem = await prisma.shipment_line_items.findFirst({
    where: { id: itemId, shipment_id: shipmentId },
    include: { products: true },
  });
  if (!lineItem) throw new ApiError("Shipment line item not found", 404);
  return lineItem;
}

function services(value: unknown): CustomService[] {
  return Array.isArray(value) ? (value as CustomService[]) : [];
}

export async function POST(req: Request, { params }: { params: { id: string; itemId: string } }) {
  try {
    await requireRole(req, ["admin"]);
    const body = await json(req, createSchema);
    const lineItem = await findLineItem(params.id, params.itemId);
    const next = [...services(lineItem.custom_services), { name: body.name, price: body.price, status: "PENDING" as const }];

    const updated = await prisma.shipment_line_items.update({
      where: { id: params.itemId },
      data: { custom_services: next as Prisma.InputJsonValue, updated_at: new Date() },
      include: { products: true },
    });

    return success(updated);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(req: Request, { params }: { params: { id: string; itemId: string } }) {
  try {
    await requireRole(req, ["admin", "staff"]);
    const body = await json(req, patchSchema);
    const lineItem = await findLineItem(params.id, params.itemId);
    const current = services(lineItem.custom_services);
    const index = current.findIndex((entry) => entry.name === body.name);
    if (index < 0) throw new ApiError("Custom service not found", 404);

    const next = current.map((entry, entryIndex) =>
      entryIndex === index ? { ...entry, status: body.status } : entry,
    );
    const updated = await prisma.shipment_line_items.update({
      where: { id: params.itemId },
      data: { custom_services: next as Prisma.InputJsonValue, updated_at: new Date() },
      include: { products: true },
    });

    return success(updated);
  } catch (err) {
    return handleApiError(err);
  }
}
