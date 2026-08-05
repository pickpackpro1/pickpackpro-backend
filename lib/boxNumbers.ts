import { ApiError } from "./apiResponse";

const BOX_TYPES = new Set(["box", "pallet"]);
const BOX_SIZES = new Set(["small", "medium", "large", "oversize"]);

type BoxNumberRecord = {
  box_number?: number | string | null;
  manual_box_number?: string | null;
  manualBoxNumber?: string | null;
  pallet_number?: string | null;
  palletNumber?: string | null;
  box_type?: string | null;
};

export function normalizeBoxType(value: unknown) {
  const boxType = String(value ?? "box").trim().toLowerCase();
  if (BOX_TYPES.has(boxType)) return boxType as "box" | "pallet";
  throw new ApiError("Invalid box type.", 422);
}

export function normalizeBoxSize(value: unknown) {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;

  const boxSize = String(value).trim().toLowerCase();
  if (BOX_SIZES.has(boxSize)) return boxSize as "small" | "medium" | "large" | "oversize";
  throw new ApiError("Invalid box size.", 422);
}

export function normalizeManualBoxNumber(value: unknown) {
  const boxNumber = String(value ?? "").trim();
  return boxNumber || null;
}

export function manualBoxNumberFromBody(body: Record<string, unknown>) {
  const raw =
    body.boxNumber ??
    body.box_number ??
    body.manualBoxNumber ??
    body.manual_box_number;
  if (raw === undefined || raw === null) return null;

  const boxNumber = normalizeManualBoxNumber(raw);
  if (!boxNumber) {
    throw new ApiError("Box number cannot be empty.", 422);
  }
  return boxNumber;
}

export function normalizedBoxNumberKey(value: unknown) {
  return normalizeManualBoxNumber(value)?.toLowerCase() ?? null;
}

export function manualBoxNumber(box: BoxNumberRecord) {
  return normalizeManualBoxNumber(box.manual_box_number ?? box.manualBoxNumber);
}

export function boxSequenceNumber(box: BoxNumberRecord) {
  return box.box_number ?? null;
}

export function effectiveBoxNumber(box: BoxNumberRecord) {
  return manualBoxNumber(box) ?? boxSequenceNumber(box);
}

export function boxNumberResponseFields(box: BoxNumberRecord) {
  const manual = manualBoxNumber(box);
  const sequence = boxSequenceNumber(box);
  const effective = manual ?? sequence;
  return {
    boxNumber: effective,
    box_number: effective,
    manualBoxNumber: manual,
    manual_box_number: manual,
    boxSequenceNumber: sequence,
    box_sequence_number: sequence,
  };
}

export function displayBoxTitle(box: BoxNumberRecord) {
  const palletNumber = normalizeManualBoxNumber(box.pallet_number ?? box.palletNumber);
  if (box.box_type === "pallet") {
    return palletNumber ?? `Pallet ${boxSequenceNumber(box)}`;
  }
  return manualBoxNumber(box) ?? `Box ${boxSequenceNumber(box)}`;
}

export function existingBoxNumberMatches(candidate: string, box: BoxNumberRecord) {
  const normalized = normalizedBoxNumberKey(candidate);
  if (!normalized) return false;

  const sequence = boxSequenceNumber(box);
  const existing = [
    manualBoxNumber(box),
    sequence === null || sequence === undefined ? null : String(sequence),
    sequence === null || sequence === undefined ? null : `Box ${sequence}`,
  ];

  return existing.some((value) => normalizedBoxNumberKey(value) === normalized);
}

type BoxNumberDb = {
  outbound_boxes: {
    findMany(args: {
      where: {
        shipment_id: string;
        sub_shipment_id: string | null;
        box_type: "box";
      };
      select: {
        id: true;
        box_number: true;
        manual_box_number: true;
      };
    }): Promise<Array<BoxNumberRecord & { id: string }>>;
  };
};

export async function assertManualBoxNumberAvailable(
  prisma: BoxNumberDb,
  input: { shipmentId: string; subShipmentId: string | null; boxNumber: string | null },
) {
  if (!input.boxNumber) return;

  const existingBoxes = await prisma.outbound_boxes.findMany({
    where: {
      shipment_id: input.shipmentId,
      sub_shipment_id: input.subShipmentId,
      box_type: "box",
    },
    select: {
      id: true,
      box_number: true,
      manual_box_number: true,
    },
  });

  if (existingBoxes.some((box) => existingBoxNumberMatches(input.boxNumber!, box))) {
    throw new ApiError("Box number already exists for this shipment.", 422, {
      boxNumber: input.boxNumber,
      shipmentId: input.shipmentId,
      subShipmentId: input.subShipmentId,
    });
  }
}
