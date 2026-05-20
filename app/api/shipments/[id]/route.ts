import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireClientAccess, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const itemSchema = z.object({
  sku: z.string().min(1),
  productName: z.string().min(1),
  expectedQty: z.number().int().positive(),
  fnskuLabel: z.string().optional().nullable(),
  services: z.array(z.string()),
});

const patchSchema = z.object({
  notes: z.string().optional(),
  expectedArrivalDate: z.coerce.date().optional(),
  isDraft: z.boolean().default(true),
  items: z.array(itemSchema).optional(),
});

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser(req);
    const shipment = await prisma.shipments.findUnique({
      where: { id: params.id },
      include: {
        clients: true,
        shipment_line_items: {
          include: {
            products: true,
            uploaded_files: true,
          },
        },
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

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser(req);
    const shipment = await prisma.shipments.findUnique({
      where: { id: params.id },
    });
    if (!shipment) throw new ApiError("Shipment not found", 404);
    if (shipment.status !== "draft") throw new ApiError("Only draft shipments can be edited", 422);
    if (user.role === "client") await requireClientAccess(req, shipment.client_id);

    const body = await json(req, patchSchema);
    const updated = await prisma.$transaction(async (tx) => {
      const shipmentUpdate = await tx.shipments.update({
        where: { id: params.id },
        data: {
          client_notes: body.notes,
          expected_arrival_date: body.expectedArrivalDate,
          status: body.isDraft ? "draft" : "submitted",
          submitted_at: body.isDraft ? undefined : new Date(),
          submitted_by: body.isDraft ? undefined : user.userId,
          updated_at: new Date(),
        },
      });

      if (body.items) {
        await tx.shipment_line_items.deleteMany({ where: { shipment_id: params.id } });
        for (const item of body.items) {
          await tx.shipment_line_items.create({
            data: {
              shipments: { connect: { id: params.id } },
              fnsku: item.fnskuLabel ?? item.sku,
              qty_expected: item.expectedQty,
              dispatch_qty: null,
              services_selected: item.services,
              service_status: Object.fromEntries(item.services.map((service) => [service, "PENDING"])),
              products: {
                connectOrCreate: {
                  where: { client_id_sku: { client_id: shipment.client_id, sku: item.sku } },
                  create: {
                    client_id: shipment.client_id,
                    sku: item.sku,
                    product_name: item.productName,
                    default_fnsku: item.fnskuLabel ?? null,
                    length_cm: 0,
                    width_cm: 0,
                    height_cm: 0,
                    weight_kg: 0,
                    needs_bundling: false,
                    bundle_size: 1,
                  },
                },
              },
            },
          });
        }
      }

      return shipmentUpdate;
    });

    await prisma.audit_logs.create({
      data: {
        user_id: user.userId,
        user_email: user.email,
        user_role: user.role,
        action: "shipment.updated",
        entity_type: "shipment",
        entity_id: params.id,
        before_value: { status: shipment.status },
        after_value: { status: updated.status },
      },
    });

    return success(updated);
  } catch (err) {
    return handleApiError(err);
  }
}
