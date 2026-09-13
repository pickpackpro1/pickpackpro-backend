import { z } from "zod";
import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { splitShipmentLabelPdf } from "@/lib/shipmentLabelSplit";
import { json } from "@/lib/validation";

export const runtime = "nodejs";
// Big label PDFs (hundreds of pages) need more than the default function time.
export const maxDuration = 60;

const schema = z.object({
  fileId: z.string().uuid(),
  // Replace labels that were already split or uploaded separately for a line.
  overwrite: z.boolean().optional(),
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireRole(req, ["admin", "staff"]);
    const body = await json(req, schema);
    const result = await splitShipmentLabelPdf({
      shipmentId: params.id,
      fileId: body.fileId,
      overwrite: body.overwrite,
      actor: user,
    });
    return success(result);
  } catch (err) {
    return handleApiError(err);
  }
}
