import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireClientAccess } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const invoice = await prisma.invoices.findUnique({
      where: { id: params.id },
      include: {
        clients: true,
        invoice_line_items: { orderBy: { sort_order: "asc" } },
      },
    });
    if (!invoice) throw new ApiError("Invoice not found", 404);
    await requireClientAccess(req, invoice.client_id);
    return success(invoice);
  } catch (err) {
    return handleApiError(err);
  }
}
