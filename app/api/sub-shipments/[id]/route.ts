import { SubShipmentStatus } from "@prisma/client";
import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireClientAccess, requireRole, requireUser } from "@/lib/auth";
import { ensureShipmentDraftInvoice, ensureSubShipmentDraftInvoice } from "@/lib/invoicing";
import { areDispatchableBoxesDispatched, serializeBoxOwnership } from "@/lib/pallets";
import { prisma } from "@/lib/prisma";
import { refreshParentShipmentDispatchStatus } from "@/lib/subShipments";
import { json } from "@/lib/validation";

const patchSchema = z.object({
  status: z.nativeEnum(SubShipmentStatus).optional(),
  notes: z.string().optional().nullable(),
});

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser(req);
    const subShipment = await prisma.sub_shipments.findUnique({
      where: { id: params.id },
      include: {
        shipments: { select: { id: true, reference: true, client_id: true, status: true } },
        sub_shipment_items: {
          include: {
            shipment_line_items: {
              include: { products: true },
            },
          },
          orderBy: { created_at: "asc" },
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
    });
    if (!subShipment) throw new ApiError("Sub-shipment not found", 404);
    if (user.role === "client") await requireClientAccess(req, subShipment.shipments.client_id);
    const boxes = subShipment.outbound_boxes.map((box) =>
      serializeBoxOwnership(box, { subShipmentReference: subShipment.reference }),
    );
    return success({ ...subShipment, outbound_boxes: boxes, boxes });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireRole(req, ["admin", "staff"]);
    const body = await json(req, patchSchema);
    const updated = await prisma.$transaction(async (tx) => {
      const subShipment = await tx.sub_shipments.findUnique({
        where: { id: params.id },
        include: { outbound_boxes: true },
      });
      if (!subShipment) throw new ApiError("Sub-shipment not found", 404);

      if (subShipment.status === "completed" || subShipment.status === "cancelled") {
        throw new ApiError("Completed or cancelled sub-shipments cannot be changed", 422);
      }

      if (body.status === "dispatched") {
        if (subShipment.outbound_boxes.length === 0) throw new ApiError("No boxes created for this sub-shipment", 422);
        if (!areDispatchableBoxesDispatched(subShipment.outbound_boxes)) {
          throw new ApiError("Dispatch all sub-shipment boxes or pallets before marking it dispatched", 422);
        }
      }

      if (body.status === "completed" && subShipment.status !== "dispatched") {
        throw new ApiError("Only dispatched sub-shipments can be completed", 422);
      }

      const nextStatus = body.status ?? subShipment.status;
      const next = await tx.sub_shipments.update({
        where: { id: params.id },
        data: {
          status: nextStatus,
          notes: body.notes === undefined ? undefined : body.notes,
          updated_at: new Date(),
          dispatched_at: nextStatus === "dispatched" ? subShipment.dispatched_at ?? new Date() : subShipment.dispatched_at,
          dispatched_by: nextStatus === "dispatched" ? user.userId : subShipment.dispatched_by,
          completed_at: nextStatus === "completed" ? subShipment.completed_at ?? new Date() : subShipment.completed_at,
          cancelled_at: nextStatus === "cancelled" ? subShipment.cancelled_at ?? new Date() : subShipment.cancelled_at,
        },
      });

      if (next.status === "dispatched" || next.status === "completed") {
        await refreshParentShipmentDispatchStatus(tx, next.parent_shipment_id);
      }

      await tx.audit_logs.create({
        data: {
          user_id: user.userId,
          user_email: user.email,
          user_role: user.role,
          action: "sub_shipment.updated",
          entity_type: "sub_shipment",
          entity_id: next.id,
          before_value: JSON.parse(JSON.stringify(subShipment)),
          after_value: JSON.parse(JSON.stringify(next)),
        },
      });

      return next;
    });

    if (updated.status === "dispatched" || updated.status === "completed") {
      await ensureSubShipmentDraftInvoice(prisma, updated.id, user.userId);
      const parentShipment = await prisma.shipments.findUnique({
        where: { id: updated.parent_shipment_id },
        select: { id: true, status: true },
      });
      if (parentShipment?.status === "dispatched" || parentShipment?.status === "completed") {
        await ensureShipmentDraftInvoice(prisma, parentShipment.id, user.userId);
      }
    }

    return success(updated);
  } catch (err) {
    return handleApiError(err);
  }
}
