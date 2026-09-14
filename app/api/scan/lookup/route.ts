import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { lookupScanMatches } from "@/lib/scanLookup";

const schema = z.object({
  code: z.string().trim().min(1),
  mode: z.enum(["receiving", "packing", "any"]),
});

// Global scan: search every client's shipments for a barcode/FNSKU/SKU, so staff can scan a box
// before opening a specific shipment. The frontend narrows client -> shipment -> line when a code
// matches more than one.
export async function GET(req: Request) {
  try {
    await requireRole(req, ["admin", "staff"]);
    const url = new URL(req.url);
    const parsed = schema.safeParse({
      code: url.searchParams.get("code"),
      mode: url.searchParams.get("mode"),
    });
    if (!parsed.success) throw new ApiError("code and mode are required", 400, parsed.error.flatten());

    const matches = await lookupScanMatches(prisma, parsed.data.code, parsed.data.mode);
    return success({ matches, count: matches.length });
  } catch (err) {
    return handleApiError(err);
  }
}
