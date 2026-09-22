import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { isolateLineItemLabel } from "@/lib/shipmentLabelSplit";

export const runtime = "nodejs";
// Reading a big client PDF and writing the isolated copy needs more than the default function time.
export const maxDuration = 60;

// Called right before a label is printed: makes sure the file holds only this product's labels.
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireRole(req, ["admin", "staff"]);
    const result = await isolateLineItemLabel({ lineItemId: params.id, actor: user });
    return success(result);
  } catch (err) {
    return handleApiError(err);
  }
}
