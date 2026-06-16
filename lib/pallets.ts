import { Prisma, PrismaClient } from "@prisma/client";
import { ApiError } from "./apiResponse";

type Db = PrismaClient | Prisma.TransactionClient;

type BoxLike = {
  id: string;
  box_type: string;
  pallet_id: string | null;
  fba_shipping_label_file_id: string | null;
  dispatched_at: Date | null;
};

type PalletChildBox = {
  id: string;
  shipment_id: string;
  sub_shipment_id: string | null;
  pallet_id: string | null;
  box_type: string;
  fba_shipping_label_file_id: string | null;
  dispatched_at: Date | null;
};

export function getDispatchableBoxes<T extends BoxLike>(boxes: T[]) {
  return boxes.filter((box) => box.pallet_id === null);
}

export function areDispatchableBoxesDispatched(boxes: BoxLike[]) {
  const dispatchableBoxes = getDispatchableBoxes(boxes);
  return dispatchableBoxes.length > 0 && dispatchableBoxes.every((box) => box.dispatched_at !== null);
}

export function areDispatchableBoxLabelsReady(boxes: BoxLike[]) {
  const dispatchableBoxes = getDispatchableBoxes(boxes);
  return (
    dispatchableBoxes.length > 0 &&
    dispatchableBoxes.every((box) => box.box_type === "pallet" || box.fba_shipping_label_file_id !== null)
  );
}

function uniqueValues<T>(values: T[]) {
  return [...new Set(values)];
}

export function normalizeBoxIds(boxIds: string[]) {
  return uniqueValues(boxIds.map((boxId) => String(boxId || "").trim()).filter(Boolean));
}

export async function validatePalletChildBoxes(
  prisma: Db,
  shipmentId: string,
  boxIds: string[],
  explicitSubShipmentId?: string | null,
) {
  const uniqueBoxIds = normalizeBoxIds(boxIds);
  if (uniqueBoxIds.length === 0) throw new ApiError("At least one box is required for a pallet", 400);

  const boxes = await prisma.outbound_boxes.findMany({
    where: { id: { in: uniqueBoxIds } },
    select: {
      id: true,
      shipment_id: true,
      sub_shipment_id: true,
      pallet_id: true,
      box_type: true,
      fba_shipping_label_file_id: true,
      dispatched_at: true,
    },
  });

  if (boxes.length !== uniqueBoxIds.length) {
    const foundIds = new Set(boxes.map((box) => box.id));
    const missingBoxIds = uniqueBoxIds.filter((boxId) => !foundIds.has(boxId));
    throw new ApiError("One or more selected boxes were not found", 404, { missingBoxIds });
  }

  for (const box of boxes) {
    if (box.shipment_id !== shipmentId) throw new ApiError("All pallet boxes must belong to the same shipment", 422);
    if (box.box_type !== "box") throw new ApiError("Only normal boxes can be placed inside a pallet", 422);
    if (box.pallet_id) throw new ApiError("One or more boxes are already inside a pallet", 422);
    if (box.dispatched_at) throw new ApiError("Dispatched boxes cannot be placed inside a pallet", 422);
    if (!box.fba_shipping_label_file_id) {
      throw new ApiError("Only boxes with uploaded FBA labels can be placed inside a pallet", 422);
    }
  }

  const subShipmentIds = uniqueValues(boxes.map((box) => box.sub_shipment_id ?? null));
  if (subShipmentIds.length > 1) {
    throw new ApiError("A pallet cannot mix boxes from different sub-shipments or parent shipment boxes", 422);
  }

  const resolvedSubShipmentId = explicitSubShipmentId ?? subShipmentIds[0] ?? null;
  if (explicitSubShipmentId !== undefined && (explicitSubShipmentId ?? null) !== (subShipmentIds[0] ?? null)) {
    throw new ApiError("Selected boxes do not belong to the requested sub-shipment", 422);
  }

  if (resolvedSubShipmentId) {
    const subShipment = await prisma.sub_shipments.findUnique({
      where: { id: resolvedSubShipmentId },
      select: { id: true, parent_shipment_id: true, status: true },
    });
    if (!subShipment) throw new ApiError("Sub-shipment not found", 404);
    if (subShipment.parent_shipment_id !== shipmentId) throw new ApiError("Sub-shipment does not belong to this shipment", 422);
    if (subShipment.status === "dispatched" || subShipment.status === "completed" || subShipment.status === "cancelled") {
      throw new ApiError("Cannot create a pallet for this sub-shipment", 422);
    }
  }

  return { boxes, boxIds: uniqueBoxIds, subShipmentId: resolvedSubShipmentId };
}

export async function createPalletWithBoxes(
  prisma: Db,
  input: {
    shipmentId: string;
    boxIds: string[];
    subShipmentId?: string | null;
    dimensions?: { l?: number; w?: number; h?: number } | null;
    weight?: number | null;
  },
) {
  const shipment = await prisma.shipments.findFirst({
    where: { id: input.shipmentId, soft_deleted_at: null },
    select: { id: true, status: true },
  });
  if (!shipment) throw new ApiError("Shipment not found", 404);
  if (shipment.status === "dispatched" || shipment.status === "completed") {
    throw new ApiError("Cannot create pallets for dispatched or completed shipments", 422);
  }

  const validated = await validatePalletChildBoxes(prisma, input.shipmentId, input.boxIds, input.subShipmentId);
  const count = await prisma.outbound_boxes.count({ where: { shipment_id: input.shipmentId } });
  const pallet = await prisma.outbound_boxes.create({
    data: {
      shipment_id: input.shipmentId,
      sub_shipment_id: validated.subShipmentId,
      box_number: count + 1,
      box_type: "pallet",
      box_size: null,
      length_cm: input.dimensions?.l ?? 0,
      width_cm: input.dimensions?.w ?? 0,
      height_cm: input.dimensions?.h ?? 0,
      weight_kg: input.weight ?? 0,
      contents: [],
    },
  });

  await prisma.outbound_boxes.updateMany({
    where: { id: { in: validated.boxIds } },
    data: { pallet_id: pallet.id },
  });

  return prisma.outbound_boxes.findUniqueOrThrow({
    where: { id: pallet.id },
    include: {
      uploaded_files: true,
      pallet_children: { include: { uploaded_files: true }, orderBy: { box_number: "asc" } },
    },
  });
}

export async function attachBoxesToPallet(prisma: Db, palletId: string, boxIds: string[]) {
  const pallet = await prisma.outbound_boxes.findUnique({
    where: { id: palletId },
    select: {
      id: true,
      shipment_id: true,
      sub_shipment_id: true,
      box_type: true,
      dispatched_at: true,
    },
  });
  if (!pallet) throw new ApiError("Pallet not found", 404);
  if (pallet.box_type !== "pallet") throw new ApiError("Selected target is not a pallet", 422);
  if (pallet.dispatched_at) throw new ApiError("Cannot add boxes to a dispatched pallet", 422);

  const validated = await validatePalletChildBoxes(prisma, pallet.shipment_id, boxIds, pallet.sub_shipment_id);
  await prisma.outbound_boxes.updateMany({
    where: { id: { in: validated.boxIds } },
    data: { pallet_id: pallet.id },
  });

  return prisma.outbound_boxes.findUniqueOrThrow({
    where: { id: pallet.id },
    include: {
      uploaded_files: true,
      pallet_children: { include: { uploaded_files: true }, orderBy: { box_number: "asc" } },
    },
  });
}

export async function assertBoxCanBeModified(prisma: Db, boxId: string) {
  const box = await prisma.outbound_boxes.findUnique({
    where: { id: boxId },
    select: { id: true, box_type: true, pallet_id: true, dispatched_at: true, contents: true },
  });
  if (!box) throw new ApiError("Box not found", 404);
  if (box.dispatched_at) throw new ApiError("Sealed boxes cannot be modified", 422);
  if (box.box_type === "pallet") throw new ApiError("Pallet contents are managed by assigning boxes to the pallet", 422);
  if (box.pallet_id) throw new ApiError("Boxes inside a pallet cannot be modified individually", 422);
  return box;
}

export async function dispatchBoxOrPallet(prisma: Db, boxId: string) {
  const box = await prisma.outbound_boxes.findUnique({
    where: { id: boxId },
    include: {
      pallet_children: {
        select: {
          id: true,
          shipment_id: true,
          sub_shipment_id: true,
          pallet_id: true,
          box_type: true,
          fba_shipping_label_file_id: true,
          dispatched_at: true,
        },
      },
    },
  });
  if (!box) throw new ApiError("Box not found", 404);
  if (box.pallet_id) throw new ApiError("Boxes inside a pallet must be dispatched by dispatching the pallet", 422);
  if (box.dispatched_at) return box;

  const now = new Date();
  if (box.box_type === "pallet") {
    const children = box.pallet_children as PalletChildBox[];
    if (children.length === 0) throw new ApiError("Cannot dispatch an empty pallet", 422);
    if (children.some((child) => child.box_type !== "box")) {
      throw new ApiError("Pallet can only dispatch normal child boxes", 422);
    }
    if (children.some((child) => child.dispatched_at)) {
      throw new ApiError("One or more boxes inside this pallet are already dispatched", 422);
    }
    if (children.some((child) => !child.fba_shipping_label_file_id)) {
      throw new ApiError("All boxes inside a pallet must have FBA labels before pallet dispatch", 422);
    }
    await prisma.outbound_boxes.updateMany({
      where: { pallet_id: box.id, dispatched_at: null },
      data: { dispatched_at: now },
    });
  } else if (!box.fba_shipping_label_file_id) {
    throw new ApiError("Upload an FBA label before dispatching this box", 422);
  }

  return prisma.outbound_boxes.update({
    where: { id: box.id },
    data: { dispatched_at: now },
  });
}
