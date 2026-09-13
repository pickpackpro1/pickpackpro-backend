import { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { ApiError } from "@/lib/apiResponse";

type Db = PrismaClient | Prisma.TransactionClient;
type Actor = { userId: string; email: string; role: string };

// Amazon FBA rejects single boxes over 23 kg unless they are specially marked.
export const MAX_FBA_BOX_WEIGHT_KG = 23;
// Amazon UK wants a "Heavy Package" marking on boxes over 15 kg.
export const HEAVY_PACKAGE_THRESHOLD_KG = 15;

export const boxWeightOverrideFields = {
  weightOverride: z.boolean().optional(),
  weight_override: z.boolean().optional(),
  weightOverrideReason: z.string().trim().max(500).optional().nullable(),
  weight_override_reason: z.string().trim().max(500).optional().nullable(),
};

export function overrideFromBody(body: {
  weightOverride?: boolean;
  weight_override?: boolean;
  weightOverrideReason?: string | null;
  weight_override_reason?: string | null;
}) {
  return {
    override: body.weightOverride ?? body.weight_override ?? false,
    reason: body.weightOverrideReason ?? body.weight_override_reason ?? null,
  };
}

function boxLabel(box: { box_number?: number | null; manual_box_number?: string | null }) {
  return box.manual_box_number || (box.box_number ? `#${box.box_number}` : "this box");
}

export function resolveBoxWeightFields(input: {
  weightKg: number;
  boxType: string;
  override?: boolean;
  reason?: string | null;
  userId: string;
}) {
  const weightKg = Number.isFinite(Number(input.weightKg)) ? Number(input.weightKg) : 0;
  if (input.boxType === "pallet") {
    return {
      weight_kg: weightKg,
      weight_override: false,
      weight_override_reason: null,
      weight_override_by: null,
      heavy_package_flag: false,
    };
  }

  const overLimit = weightKg > MAX_FBA_BOX_WEIGHT_KG;
  const reason = input.reason?.trim() || null;
  if (overLimit && !input.override) {
    throw new ApiError(
      `Box weight ${weightKg} kg is over the ${MAX_FBA_BOX_WEIGHT_KG} kg Amazon FBA limit. Override with a reason to continue.`,
      422,
      { code: "BOX_WEIGHT_OVER_LIMIT", weightKg, maxWeightKg: MAX_FBA_BOX_WEIGHT_KG },
    );
  }
  if (overLimit && !reason) {
    throw new ApiError(`A reason is required to override the ${MAX_FBA_BOX_WEIGHT_KG} kg box limit.`, 422, {
      code: "BOX_WEIGHT_OVERRIDE_REASON_REQUIRED",
      weightKg,
      maxWeightKg: MAX_FBA_BOX_WEIGHT_KG,
    });
  }

  return {
    weight_kg: weightKg,
    weight_override: overLimit,
    weight_override_reason: overLimit ? reason : null,
    weight_override_by: overLimit ? input.userId : null,
    heavy_package_flag: weightKg > HEAVY_PACKAGE_THRESHOLD_KG,
  };
}

export function weightOverrideAuditData(
  actor: Actor,
  box: { id: string; weight_kg: Prisma.Decimal | number; weight_override_reason: string | null },
) {
  return {
    user_id: actor.userId,
    user_email: actor.email,
    user_role: actor.role,
    action: "box.weight_override",
    entity_type: "box",
    entity_id: box.id,
    after_value: {
      weight_kg: Number(box.weight_kg),
      max_weight_kg: MAX_FBA_BOX_WEIGHT_KG,
      reason: box.weight_override_reason,
    },
  };
}

type SealWeightBox = {
  id: string;
  box_number: number;
  manual_box_number: string | null;
  weight_kg: Prisma.Decimal;
  weight_override: boolean;
};

function assertBoxWeightOk(box: SealWeightBox, onPallet: boolean) {
  const weightKg = Number(box.weight_kg);
  const label = boxLabel(box);
  if (!(weightKg > 0)) {
    throw new ApiError(
      onPallet
        ? `Box ${label} on this pallet needs its weight before the pallet can be dispatched.`
        : "Enter this box's weight before dispatching it.",
      422,
      { code: "BOX_WEIGHT_REQUIRED", boxId: box.id, boxLabel: label },
    );
  }
  if (weightKg > MAX_FBA_BOX_WEIGHT_KG && !box.weight_override) {
    throw new ApiError(
      `Box ${label} weighs ${weightKg} kg, over the ${MAX_FBA_BOX_WEIGHT_KG} kg FBA limit. Override it with a reason before dispatching.`,
      422,
      { code: "BOX_WEIGHT_OVER_LIMIT", boxId: box.id, boxLabel: label, weightKg, maxWeightKg: MAX_FBA_BOX_WEIGHT_KG },
    );
  }
}

// Every box leaving the warehouse needs a real weight within the FBA limit (or an audited override).
export async function assertBoxWeightsReadyToSeal(prisma: Db, boxId: string) {
  const select = {
    id: true,
    box_type: true,
    box_number: true,
    manual_box_number: true,
    weight_kg: true,
    weight_override: true,
    pallet_id: true,
    dispatched_at: true,
  } as const;
  const box = await prisma.outbound_boxes.findUnique({
    where: { id: boxId },
    select: { ...select, pallet_children: { select } },
  });
  // Not found, already dispatched, and inside-a-pallet are all reported by dispatchBoxOrPallet.
  if (!box || box.dispatched_at || box.pallet_id) return;

  if (box.box_type === "pallet") {
    for (const child of box.pallet_children) {
      if (!child.dispatched_at) assertBoxWeightOk(child, true);
    }
    return;
  }
  assertBoxWeightOk(box, false);
}
