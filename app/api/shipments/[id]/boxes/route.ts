import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireClientAccess, requireRole, requireUser } from "@/lib/auth";
import { buildValidatedBoxContents, extractBoxAllocationInputs } from "@/lib/boxAllocations";
import { getShipmentBoxesWorkflowState, getSubShipmentBoxesWorkflowState } from "@/lib/boxWorkflowState";
import { prisma } from "@/lib/prisma";
import { getSubShipmentAvailability } from "@/lib/subShipments";
import { json } from "@/lib/validation";

const schema = z.object({
  weight: z.number().nonnegative().optional(),
  dimensions: z.object({ l: z.number().nonnegative(), w: z.number().nonnegative(), h: z.number().nonnegative() }).optional(),
  boxType: z.enum(["box", "pallet"]).default("box"),
  boxSize: z.enum(["small", "medium", "large", "oversize"]).optional(),
  subShipmentId: z.string().uuid().optional().nullable(),
  items: z.array(z.unknown()).optional(),
  boxItems: z.array(z.unknown()).optional(),
  box_items: z.array(z.unknown()).optional(),
  contents: z.array(z.unknown()).optional(),
});

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser(req);
    const shipment = await prisma.shipments.findUnique({
      where: { id: params.id },
      include: {
        outbound_boxes: {
          include: {
            uploaded_files: true,
            pallet: { select: { id: true, box_number: true, box_type: true, dispatched_at: true } },
            pallet_children: { include: { uploaded_files: true }, orderBy: { box_number: "asc" } },
          },
          orderBy: { box_number: "asc" },
        },
        shipment_line_items: { include: { products: true } },
      },
    });
    if (!shipment) throw new ApiError("Shipment not found", 404);
    if (user.role === "client") await requireClientAccess(req, shipment.client_id);
    const availability = await getSubShipmentAvailability(prisma, params.id);
    const availabilityById = new Map(availability.map((item) => [item.shipmentItemId, item]));
    const allocationSummary = shipment.shipment_line_items.map((item) => {
      const allocated = shipment.outbound_boxes.reduce((sum, box) => {
        const contents = box.contents as Array<{ shipmentItemId?: string; shipment_line_item_id?: string; quantity?: number }> | null;
        return (
          sum +
          (contents ?? [])
            .filter((entry) => entry.shipmentItemId === item.id || entry.shipment_line_item_id === item.id)
            .reduce((inner, entry) => inner + (entry.quantity ?? 0), 0)
        );
      }, 0);
      const available = availabilityById.get(item.id);
      return {
        shipmentItemId: item.id,
        sku: item.products.sku,
        dispatchQty: item.dispatch_qty,
        allocated,
        assignedToSubShipments: available?.assignedQty ?? 0,
        remainingForSubShipments: available?.remainingQty ?? 0,
        prepared: available?.prepared ?? false,
      };
    });
    return success({ boxes: shipment.outbound_boxes, allocationSummary, availability });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    await requireRole(req, ["admin", "staff"]);
    const includeWorkflow = new URL(req.url).searchParams.get("includeWorkflow") === "true";
    const body = await json(req, schema);
    const box = await prisma.$transaction(async (tx) => {
      if (body.boxType === "pallet") {
        throw new ApiError("Use the pallet endpoint to create pallets from selected boxes", 422);
      }
      if (body.subShipmentId) {
        const subShipment = await tx.sub_shipments.findUnique({ where: { id: body.subShipmentId } });
        if (!subShipment) throw new ApiError("Sub-shipment not found", 404);
        if (subShipment.parent_shipment_id !== params.id) throw new ApiError("Sub-shipment does not belong to this shipment", 422);
        if (subShipment.status === "dispatched" || subShipment.status === "completed" || subShipment.status === "cancelled") {
          throw new ApiError("Cannot add boxes to this sub-shipment", 422);
        }
      }
      const count = await tx.outbound_boxes.count({ where: { shipment_id: params.id } });
      const contents = await buildValidatedBoxContents(tx, {
        shipmentId: params.id,
        subShipmentId: body.subShipmentId ?? null,
        rows: extractBoxAllocationInputs(body),
      });
      const created = await tx.outbound_boxes.create({
        data: {
          shipment_id: params.id,
          sub_shipment_id: body.subShipmentId ?? null,
          box_number: count + 1,
          box_type: body.boxType,
          box_size: body.boxSize,
          length_cm: body.dimensions?.l ?? 0,
          width_cm: body.dimensions?.w ?? 0,
          height_cm: body.dimensions?.h ?? 0,
          weight_kg: body.weight ?? 0,
          contents,
        },
      });
      if (body.subShipmentId) {
        await tx.sub_shipments.updateMany({
          where: { id: body.subShipmentId, status: "draft" },
          data: { status: "awaiting_fba_labels", updated_at: new Date() },
        });
      }
      return created;
    });
    if (includeWorkflow) {
      if (body.subShipmentId) {
        const subShipmentBoxes = await getSubShipmentBoxesWorkflowState(prisma, body.subShipmentId);

        return success(
          {
            box,
            workflowPatch: {
              scope: "subShipmentBoxes",
              shipmentId: params.id,
              subShipmentId: body.subShipmentId,
              subShipmentBoxes,
            },
          },
          201,
        );
      }

      const shipmentBoxes = await getShipmentBoxesWorkflowState(prisma, params.id);

      return success(
        {
          box,
          workflowPatch: {
            scope: "shipmentBoxes",
            shipmentId: params.id,
            subShipmentId: null,
            shipmentBoxes,
          },
        },
        201,
      );
    }
    return success(box, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
