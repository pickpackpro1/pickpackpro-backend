import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { isolateLineItemLabel } from "@/lib/shipmentLabelSplit";

export const runtime = "nodejs";
// Reading a big client PDF and writing the isolated copy needs more than the default function time.
export const maxDuration = 60;

const schema = z.object({
  // How many labels to prepare. Defaults to the shipment quantity for this line.
  quantity: z.coerce.number().int().positive().max(10_000).optional(),
});

// Called right before a label is printed: makes sure the file holds only this product's labels,
// in the number of units being shipped.
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireRole(req, ["admin", "staff"]);
    const raw = await req.json().catch(() => ({}));
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) throw new ApiError("Invalid quantity", 400, parsed.error.flatten());

    const result = await isolateLineItemLabel({
      lineItemId: params.id,
      actor: user,
      quantity: parsed.data.quantity,
    });
    return success(result);
  } catch (err) {
    return handleApiError(err);
  }
}
