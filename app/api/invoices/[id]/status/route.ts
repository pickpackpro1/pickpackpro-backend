import { InvoiceStatus } from "@prisma/client";
import { z } from "zod";
import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const schema = z.object({ status: z.nativeEnum(InvoiceStatus) });

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    await requireRole(req, ["admin"]);
    const body = await json(req, schema);
    const invoice = await prisma.invoices.update({
      where: { id: params.id },
      data: {
        status: body.status,
        sent_at: body.status === "sent" ? new Date() : undefined,
        paid_at: body.status === "paid" ? new Date() : undefined,
      },
    });
    return success(invoice);
  } catch (err) {
    return handleApiError(err);
  }
}
