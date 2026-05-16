import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireRole(req, ["admin"]);
    const invoice = await prisma.invoices.update({
      where: { id: params.id },
      data: { status: "sent", sent_at: new Date() },
    });
    await prisma.audit_logs.create({
      data: {
        user_id: user.userId,
        user_email: user.email,
        user_role: user.role,
        action: "invoice.sent",
        entity_type: "invoice",
        entity_id: params.id,
        after_value: JSON.parse(JSON.stringify(invoice)),
      },
    });
    return success({ invoice, emailQueued: false });
  } catch (err) {
    return handleApiError(err);
  }
}
