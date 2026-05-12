import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    await requireRole(req, ["admin"]);
    const invoice = await prisma.invoices.update({
      where: { id: params.id },
      data: { status: "sent", sent_at: new Date() },
    });
    return success({ invoice, emailQueued: false });
  } catch (err) {
    return handleApiError(err);
  }
}
