import { z } from "zod";
import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { generateInvoice } from "@/lib/businessLogic";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const schema = z.object({
  clientId: z.string().uuid(),
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
});

export async function POST(req: Request) {
  try {
    const user = await requireRole(req, ["admin"]);
    const body = await json(req, schema);
    const invoice = await prisma.$transaction((tx) =>
      generateInvoice(tx, body.clientId, body.periodStart, body.periodEnd, user.userId),
    );
    await prisma.audit_logs.create({
      data: {
        user_id: user.userId,
        user_email: user.email,
        user_role: user.role,
        action: "invoice.generated",
        entity_type: "invoice",
        entity_id: invoice.id,
        after_value: JSON.parse(JSON.stringify(invoice)),
      },
    });
    return success(invoice, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
