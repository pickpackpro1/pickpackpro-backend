import { ShipmentStatus } from "@prisma/client";
import { z } from "zod";
import { handleApiError, success } from "@/lib/apiResponse";
import { requireClientAccess, requireUser } from "@/lib/auth";
import { calculateDispatchQty } from "@/lib/businessLogic";
import { prisma } from "@/lib/prisma";
import { generateShipmentRef } from "@/lib/referenceGen";
import { json } from "@/lib/validation";

const itemSchema = z.object({
  sku: z.string().min(1),
  productName: z.string().min(1),
  expectedQty: z.number().int().positive(),
  bundleSize: z.number().int().positive().default(1),
  fnskuLabel: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  services: z.array(z.string()).default(["FNSKU_LABEL", "POLY_BAG", "BUBBLE_WRAP", "BUNDLING"]),
});

const createSchema = z.object({
  clientId: z.string().uuid(),
  notes: z.string().optional().nullable(),
  expectedArrivalDate: z.coerce.date().optional(),
  items: z.array(itemSchema).min(1),
});

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const url = new URL(req.url);
    const page = Number(url.searchParams.get("page") ?? 1);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 100);
    const status = url.searchParams.get("status")?.toLowerCase() as ShipmentStatus | undefined;
    const clientId = url.searchParams.get("clientId") ?? undefined;
    const search = url.searchParams.get("search") ?? undefined;
    const where = {
      soft_deleted_at: null,
      status,
      client_id: user.role === "client" ? user.clientId! : clientId,
      shipment_line_items: search
        ? { some: { products: { sku: { contains: search, mode: "insensitive" as const } } } }
        : undefined,
    };
    const [rows, total] = await Promise.all([
      prisma.shipments.findMany({
        where,
        include: { clients: true, shipment_line_items: { include: { products: true } }, outbound_boxes: true },
        orderBy: { created_at: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.shipments.count({ where }),
    ]);
    return success({ rows, total, page, limit });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireClientAccess(req, (await req.clone().json()).clientId);
    const body = await json(req, createSchema);
    await requireClientAccess(req, body.clientId);
    const shipment = await prisma.$transaction(async (tx) => {
      const reference = await generateShipmentRef(tx as typeof prisma);
      return tx.shipments.create({
        data: {
          client_id: body.clientId,
          reference,
          status: "submitted",
          expected_arrival_date: body.expectedArrivalDate ?? new Date(),
          client_notes: body.notes ?? null,
          submitted_at: new Date(),
          submitted_by: user.userId,
          shipment_line_items: {
            create: body.items.map((item) => ({
              fnsku: item.fnskuLabel ?? item.sku,
              qty_expected: item.expectedQty,
              dispatch_qty: null,
              services_selected: item.services,
              service_status: Object.fromEntries(item.services.map((service) => [service, "PENDING"])),
              discrepancy_notes: item.notes ?? null,
              products: {
                connectOrCreate: {
                  where: { client_id_sku: { client_id: body.clientId, sku: item.sku } },
                  create: {
                    client_id: body.clientId,
                    sku: item.sku,
                    product_name: item.productName,
                    default_fnsku: item.fnskuLabel ?? null,
                    length_cm: 0,
                    width_cm: 0,
                    height_cm: 0,
                    weight_kg: 0,
                    needs_bundling: item.bundleSize > 1,
                    bundle_size: item.bundleSize,
                  },
                },
              },
            })),
          },
        },
        include: { shipment_line_items: { include: { products: true } } },
      });
    });
    return success(shipment, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
