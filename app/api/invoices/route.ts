import { InvoiceStatus } from "@prisma/client";
import { handleApiError, success } from "@/lib/apiResponse";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const url = new URL(req.url);
    const clientId = url.searchParams.get("clientId") ?? undefined;
    const status = url.searchParams.get("status")?.toLowerCase() as InvoiceStatus | undefined;
    const invoices = await prisma.invoices.findMany({
      where: {
        client_id: user.role === "client" ? user.clientId! : clientId,
        status,
      },
      include: { clients: true, invoice_line_items: true },
      orderBy: { created_at: "desc" },
    });
    return success(invoices);
  } catch (err) {
    return handleApiError(err);
  }
}
