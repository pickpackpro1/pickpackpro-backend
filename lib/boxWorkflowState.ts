import { Prisma } from "@prisma/client";
import { ApiError } from "./apiResponse";
import { serializeBoxOwnership } from "./pallets";
import { getSubShipmentAvailability, publicSubShipmentStatusFields } from "./subShipments";

type Db = Prisma.TransactionClient;

type BoxContentsEntry = {
  shipmentItemId?: string;
  shipment_line_item_id?: string;
  quantity?: number | string | null;
};

const uploadedFileSelect = {
  id: true,
  uploader_user_id: true,
  client_id: true,
  file_type: true,
  original_filename: true,
  storage_path: true,
  file_size_bytes: true,
  mime_type: true,
  linked_entity_type: true,
  linked_entity_id: true,
  metadata: true,
  uploaded_at: true,
};

const childBoxSelect = {
  id: true,
  shipment_id: true,
  sub_shipment_id: true,
  pallet_id: true,
  box_number: true,
  manual_box_number: true,
  pallet_number: true,
  box_type: true,
  box_size: true,
  length_cm: true,
  width_cm: true,
  height_cm: true,
  weight_kg: true,
  contents: true,
  fba_shipping_label_file_id: true,
  label_uploaded_at: true,
  dispatched_at: true,
  created_at: true,
  uploaded_files: { select: uploadedFileSelect },
  sub_shipments: { select: { id: true, reference: true, status: true, sequence_no: true } },
};

const workflowBoxSelect = {
  ...childBoxSelect,
  pallet: { select: { id: true, box_number: true, manual_box_number: true, pallet_number: true, box_type: true, dispatched_at: true } },
  pallet_children: {
    select: childBoxSelect,
    orderBy: { box_number: "asc" as const },
  },
};

function boxContents(contents: Prisma.JsonValue): BoxContentsEntry[] {
  return Array.isArray(contents) ? (contents as BoxContentsEntry[]) : [];
}

function quantity(value: BoxContentsEntry["quantity"]) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function allocatedQtyForItem(
  boxes: Array<{ contents: Prisma.JsonValue }>,
  shipmentItemId: string,
) {
  return boxes.reduce((sum, box) => {
    return (
      sum +
      boxContents(box.contents)
        .filter((entry) => entry.shipmentItemId === shipmentItemId || entry.shipment_line_item_id === shipmentItemId)
        .reduce((inner, entry) => inner + quantity(entry.quantity), 0)
    );
  }, 0);
}

export async function getShipmentBoxesWorkflowState(prisma: Db, shipmentId: string) {
  const shipment = await prisma.shipments.findUnique({
    where: { id: shipmentId },
    select: {
      id: true,
      outbound_boxes: {
        select: workflowBoxSelect,
        orderBy: { box_number: "asc" },
      },
      shipment_line_items: {
        select: {
          id: true,
          dispatch_qty: true,
          products: { select: { sku: true } },
        },
        orderBy: { created_at: "asc" },
      },
    },
  });
  if (!shipment) throw new ApiError("Shipment not found", 404);

  const availability = await getSubShipmentAvailability(prisma, shipmentId);
  const availabilityById = new Map(availability.map((item) => [item.shipmentItemId, item]));
  const allocationSummary = shipment.shipment_line_items.map((item) => {
    const available = availabilityById.get(item.id);
    return {
      shipmentItemId: item.id,
      sku: item.products.sku,
      dispatchQty: item.dispatch_qty,
      allocated: allocatedQtyForItem(shipment.outbound_boxes, item.id),
      assignedToSubShipments: available?.assignedToSubShipments ?? available?.assignedQty ?? 0,
      packedInParentBoxes: available?.packedInParentBoxes ?? 0,
      consumedQty: available?.consumedQty ?? available?.assignedDisplayQty ?? available?.assignedQty ?? 0,
      assignedDisplayQty: available?.assignedDisplayQty ?? available?.consumedQty ?? available?.assignedQty ?? 0,
      remainingForSubShipments: available?.remainingQty ?? 0,
      prepared: available?.prepared ?? false,
    };
  });

  return {
    boxes: shipment.outbound_boxes.map((box) => serializeBoxOwnership(box)),
    allocationSummary,
    availability,
  };
}

export async function getSubShipmentBoxesWorkflowState(prisma: Db, subShipmentId: string) {
  const subShipment = await prisma.sub_shipments.findUnique({
    where: { id: subShipmentId },
    select: {
      id: true,
      parent_shipment_id: true,
      status: true,
      updated_at: true,
      outbound_boxes: {
        select: workflowBoxSelect,
        orderBy: { box_number: "asc" },
      },
      sub_shipment_items: {
        select: {
          shipment_line_item_id: true,
          quantity: true,
          shipment_line_items: {
            select: {
              products: { select: { sku: true } },
            },
          },
        },
        orderBy: { created_at: "asc" },
      },
    },
  });
  if (!subShipment) throw new ApiError("Sub-shipment not found", 404);

  const allocationSummary = subShipment.sub_shipment_items.map((subItem) => {
    const allocated = allocatedQtyForItem(subShipment.outbound_boxes, subItem.shipment_line_item_id);
    return {
      shipmentItemId: subItem.shipment_line_item_id,
      sku: subItem.shipment_line_items.products.sku,
      plannedQty: subItem.quantity,
      allocated,
      remainingQty: Math.max(subItem.quantity - allocated, 0),
    };
  });

  return {
    subShipment: {
      id: subShipment.id,
      parentShipmentId: subShipment.parent_shipment_id,
      parent_shipment_id: subShipment.parent_shipment_id,
      ...publicSubShipmentStatusFields(subShipment.status),
      updatedAt: subShipment.updated_at,
      updated_at: subShipment.updated_at,
    },
    boxes: subShipment.outbound_boxes.map((box) =>
      serializeBoxOwnership(box, { subShipmentReference: box.sub_shipments?.reference ?? null }),
    ),
    allocationSummary,
  };
}
