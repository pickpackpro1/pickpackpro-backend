import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireClientAccess, requireRole, requireUser } from "@/lib/auth";
import { buildValidatedBoxContents, extractBoxAllocationInputs } from "@/lib/boxAllocations";
import { assertManualBoxNumberAvailable, manualBoxNumberFromBody, normalizeBoxSize, normalizeBoxType } from "@/lib/boxNumbers";
import { getSubShipmentBoxesWorkflowState } from "@/lib/boxWorkflowState";
import { serializeBoxOwnership } from "@/lib/pallets";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const schema = z.object({
  weight: z.coerce.number().nonnegative().optional(),
  weightKg: z.coerce.number().nonnegative().optional(),
  weight_kg: z.coerce.number().nonnegative().optional(),
  dimensions: z.object({ l: z.coerce.number().nonnegative(), w: z.coerce.number().nonnegative(), h: z.coerce.number().nonnegative() }).optional(),
  lengthCm: z.coerce.number().nonnegative().optional(),
  length_cm: z.coerce.number().nonnegative().optional(),
  widthCm: z.coerce.number().nonnegative().optional(),
  width_cm: z.coerce.number().nonnegative().optional(),
  heightCm: z.coerce.number().nonnegative().optional(),
  height_cm: z.coerce.number().nonnegative().optional(),
  boxType: z.string().optional().nullable(),
  box_type: z.string().optional().nullable(),
  boxSize: z.string().optional().nullable(),
  box_size: z.string().optional().nullable(),
  size: z.string().optional().nullable(),
  boxNumber: z.union([z.string(), z.number()]).optional().nullable(),
  box_number: z.union([z.string(), z.number()]).optional().nullable(),
  manualBoxNumber: z.union([z.string(), z.number()]).optional().nullable(),
  manual_box_number: z.union([z.string(), z.number()]).optional().nullable(),
  items: z.array(z.unknown()).optional(),
  boxItems: z.array(z.unknown()).optional(),
  box_items: z.array(z.unknown()).optional(),
  contents: z.array(z.unknown()).optional(),
});

function normalizedDimensions(body: z.infer<typeof schema>) {
  return {
    l: body.dimensions?.l ?? body.lengthCm ?? body.length_cm ?? 0,
    w: body.dimensions?.w ?? body.widthCm ?? body.width_cm ?? 0,
    h: body.dimensions?.h ?? body.heightCm ?? body.height_cm ?? 0,
  };
}

function normalizedWeight(body: z.infer<typeof schema>) {
  return body.weight ?? body.weightKg ?? body.weight_kg ?? 0;
}

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser(req);
    const subShipment = await prisma.sub_shipments.findUnique({
      where: { id: params.id },
      include: {
        shipments: { select: { client_id: true } },
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
        sub_shipment_items: {
          include: {
            shipment_line_items: {
              include: { products: true },
            },
          },
        },
      },
    });
    if (!subShipment) throw new ApiError("Sub-shipment not found", 404);
    if (user.role === "client") await requireClientAccess(req, subShipment.shipments.client_id);

    const allocationSummary = subShipment.sub_shipment_items.map((subItem) => {
      const allocated = subShipment.outbound_boxes.reduce((sum, box) => {
        const contents = box.contents as Array<{ shipmentItemId?: string; shipment_line_item_id?: string; quantity?: number }> | null;
        return (
          sum +
          (contents ?? [])
            .filter(
              (entry) =>
                entry.shipmentItemId === subItem.shipment_line_item_id ||
                entry.shipment_line_item_id === subItem.shipment_line_item_id,
            )
            .reduce((inner, entry) => inner + (entry.quantity ?? 0), 0)
        );
      }, 0);
      return {
        shipmentItemId: subItem.shipment_line_item_id,
        sku: subItem.shipment_line_items.products.sku,
        productName: subItem.shipment_line_items.product_name ?? subItem.shipment_line_items.products.product_name,
        product_name: subItem.shipment_line_items.product_name ?? subItem.shipment_line_items.products.product_name,
        plannedQty: subItem.quantity,
        allocated,
        remainingQty: Math.max(subItem.quantity - allocated, 0),
      };
    });

    return success({
      boxes: subShipment.outbound_boxes.map((box) =>
        serializeBoxOwnership(box, { subShipmentReference: subShipment.reference }),
      ),
      allocationSummary,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    await requireRole(req, ["admin", "staff"]);
    const includeWorkflow = new URL(req.url).searchParams.get("includeWorkflow") === "true";
    const body = await json(req, schema);
    const boxType = normalizeBoxType(body.boxType ?? body.box_type);
    const boxSize = normalizeBoxSize(body.boxSize ?? body.box_size ?? body.size);
    const manualBoxNumber = manualBoxNumberFromBody(body);
    const dims = normalizedDimensions(body);
    const box = await prisma.$transaction(async (tx) => {
      if (boxType === "pallet") {
        throw new ApiError("Use the pallet endpoint to create pallets from selected boxes", 422);
      }
      const subShipment = await tx.sub_shipments.findUnique({ where: { id: params.id } });
      if (!subShipment) throw new ApiError("Sub-shipment not found", 404);
      if (subShipment.status === "dispatched" || subShipment.status === "completed" || subShipment.status === "cancelled") {
        throw new ApiError("Cannot add boxes to this sub-shipment", 422);
      }
      await assertManualBoxNumberAvailable(tx, { shipmentId: subShipment.parent_shipment_id, subShipmentId: subShipment.id, boxNumber: manualBoxNumber });
      const count = await tx.outbound_boxes.count({ where: { shipment_id: subShipment.parent_shipment_id } });
      const contents = await buildValidatedBoxContents(tx, {
        shipmentId: subShipment.parent_shipment_id,
        subShipmentId: subShipment.id,
        rows: extractBoxAllocationInputs(body),
      });
      const created = await tx.outbound_boxes.create({
        data: {
          shipment_id: subShipment.parent_shipment_id,
          sub_shipment_id: subShipment.id,
          box_number: count + 1,
          manual_box_number: manualBoxNumber,
          box_type: boxType,
          box_size: boxSize,
          length_cm: dims.l,
          width_cm: dims.w,
          height_cm: dims.h,
          weight_kg: normalizedWeight(body),
          contents,
        },
      });
      if (subShipment.status === "draft") {
        await tx.sub_shipments.update({
          where: { id: subShipment.id },
          data: { status: "awaiting_fba_labels", updated_at: new Date() },
        });
      }
      return created;
    });

    if (includeWorkflow) {
      const subShipmentBoxes = await getSubShipmentBoxesWorkflowState(prisma, params.id);

      return success(
        {
          box: serializeBoxOwnership(box),
          workflowPatch: {
            scope: "subShipmentBoxes",
            shipmentId: subShipmentBoxes.subShipment.parentShipmentId,
            subShipmentId: params.id,
            subShipmentBoxes,
          },
        },
        201,
      );
    }

    return success(serializeBoxOwnership(box), 201);
  } catch (err) {
    return handleApiError(err);
  }
}
