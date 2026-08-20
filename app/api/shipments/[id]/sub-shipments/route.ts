import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireClientAccess, requireRole, requireUser } from "@/lib/auth";
import { serializeBoxOwnership } from "@/lib/pallets";
import { prisma } from "@/lib/prisma";
import { assertSubShipmentItemsAvailable, getSubShipmentAvailability, refreshSubShipmentStatusFromBoxes } from "@/lib/subShipments";
import { json } from "@/lib/validation";

const itemSchema = z.object({
  shipmentItemId: z.string().uuid(),
  quantity: z.number().int().positive(),
});

const createSchema = z.object({
  notes: z.string().optional().nullable(),
  items: z.array(itemSchema).min(1),
});

function normalizeItems(items: z.infer<typeof itemSchema>[]) {
  const grouped = new Map<string, number>();
  for (const item of items) {
    grouped.set(item.shipmentItemId, (grouped.get(item.shipmentItemId) ?? 0) + item.quantity);
  }
  return [...grouped.entries()].map(([shipmentItemId, quantity]) => ({ shipmentItemId, quantity }));
}

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser(req);
    const shipment = await prisma.shipments.findUnique({
      where: { id: params.id, soft_deleted_at: null },
      include: {
        sub_shipments: {
          orderBy: { sequence_no: "asc" },
          include: {
            sub_shipment_items: {
              include: {
                shipment_line_items: {
                  include: { products: true },
                },
              },
            },
            outbound_boxes: {
              include: {
                uploaded_files: true,
                pallet: { select: { id: true, box_number: true, manual_box_number: true, pallet_number: true, box_type: true, dispatched_at: true } },
                sub_shipments: { select: { id: true, reference: true, status: true, sequence_no: true } },
                pallet_children: {
                  include: {
                    uploaded_files: true,
                    sub_shipments: { select: { id: true, reference: true, status: true, sequence_no: true } },
                  },
                  orderBy: { box_number: "asc" },
                },
              },
              orderBy: { box_number: "asc" },
            },
          },
        },
      },
    });
    if (!shipment) throw new ApiError("Shipment not found", 404);
    if (user.role === "client") await requireClientAccess(req, shipment.client_id);

    const refreshedRows = await Promise.all(
      shipment.sub_shipments.map((subShipment) => refreshSubShipmentStatusFromBoxes(prisma, subShipment.id)),
    );
    const refreshedById = new Map(refreshedRows.filter(Boolean).map((subShipment) => [subShipment!.id, subShipment!]));
    for (const subShipment of shipment.sub_shipments) {
      const refreshed = refreshedById.get(subShipment.id);
      if (!refreshed) continue;
      subShipment.status = refreshed.status;
      subShipment.updated_at = refreshed.updated_at;
      subShipment.dispatched_at = refreshed.dispatched_at;
      subShipment.dispatched_by = refreshed.dispatched_by;
    }

    const availability = await getSubShipmentAvailability(prisma, params.id);
    const subShipments = shipment.sub_shipments.map((subShipment) => {
      const boxes = subShipment.outbound_boxes.map((box) =>
        serializeBoxOwnership(box, { subShipmentReference: subShipment.reference }),
      );
      return { ...subShipment, outbound_boxes: boxes, boxes };
    });
    return success({ subShipments, sub_shipments: subShipments, availability });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireRole(req, ["admin", "staff"]);
    const body = await json(req, createSchema);
    const items = normalizeItems(body.items);

    const subShipment = await prisma.$transaction(async (tx) => {
      const shipment = await tx.shipments.findUnique({
        where: { id: params.id, soft_deleted_at: null },
      });
      if (!shipment) throw new ApiError("Shipment not found", 404);
      if (!["received", "in_progress", "prepped"].includes(shipment.status)) {
        throw new ApiError("Sub-shipments can only be created after shipment receiving has started", 422);
      }

      await assertSubShipmentItemsAvailable(tx, params.id, items);

      const sequence = await tx.sub_shipments.aggregate({
        where: { parent_shipment_id: params.id },
        _max: { sequence_no: true },
      });
      const sequenceNo = (sequence._max.sequence_no ?? 0) + 1;
      const created = await tx.sub_shipments.create({
        data: {
          parent_shipment_id: params.id,
          sequence_no: sequenceNo,
          reference: `${shipment.reference}-${sequenceNo}`,
          notes: body.notes ?? null,
          created_by: user.userId,
          sub_shipment_items: {
            create: items.map((item) => ({
              shipment_line_item_id: item.shipmentItemId,
              quantity: item.quantity,
            })),
          },
        },
        include: {
          sub_shipment_items: {
            include: {
              shipment_line_items: {
                include: { products: true },
              },
            },
          },
          outbound_boxes: true,
        },
      });

      if (shipment.status === "received") {
        await tx.shipments.update({
          where: { id: shipment.id },
          data: { status: "in_progress", updated_at: new Date() },
        });
      }

      await tx.audit_logs.create({
        data: {
          user_id: user.userId,
          user_email: user.email,
          user_role: user.role,
          action: "sub_shipment.created",
          entity_type: "sub_shipment",
          entity_id: created.id,
          after_value: JSON.parse(JSON.stringify(created)),
        },
      });

      return created;
    });

    return success(subShipment, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
