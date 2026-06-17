import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireClientAccess, requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { bucketFor, supabaseAdmin } from "@/lib/supabase";

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

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireRole(req, ["admin"]);
    const invoice = await prisma.invoices.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        invoice_number: true,
        status: true,
        invoice_type: true,
        client_id: true,
        shipment_id: true,
        sub_shipment_id: true,
        pdf_file_id: true,
        xlsx_file_id: true,
      },
    });
    if (!invoice) throw new ApiError("Invoice not found", 404);

    const linkedFileIds = [invoice.pdf_file_id, invoice.xlsx_file_id].filter((id): id is string => Boolean(id));
    const relatedFiles = await prisma.uploaded_files.findMany({
      where: {
        OR: [
          ...(linkedFileIds.length > 0 ? [{ id: { in: linkedFileIds } }] : []),
          { linked_entity_type: "invoice", linked_entity_id: invoice.id },
        ],
      },
    });
    const relatedFileIds = [...new Set(relatedFiles.map((file) => file.id))];

    await prisma.$transaction(async (tx) => {
      await tx.invoice_line_items.deleteMany({ where: { invoice_id: invoice.id } });
      await tx.invoices.delete({ where: { id: invoice.id } });
      if (relatedFileIds.length > 0) {
        await tx.uploaded_files.deleteMany({ where: { id: { in: relatedFileIds } } });
      }
      await tx.audit_logs.create({
        data: {
          user_id: user.userId,
          user_email: user.email,
          user_role: user.role,
          action: "invoice.deleted",
          entity_type: "invoice",
          entity_id: invoice.id,
          before_value: JSON.parse(JSON.stringify(invoice)),
          after_value: { deleted: true },
        },
      });
    });

    const filesByBucket = new Map<string, string[]>();
    for (const file of relatedFiles) {
      const bucket = bucketFor(file.file_type);
      filesByBucket.set(bucket, [...(filesByBucket.get(bucket) ?? []), file.storage_path]);
    }
    await Promise.all(
      [...filesByBucket.entries()].map(async ([bucket, paths]) => {
        const remove = await supabaseAdmin.storage.from(bucket).remove(paths);
        if (remove.error) {
          console.error("[storage] Failed to remove invoice files:", remove.error);
        }
      }),
    );

    return success({
      deleted: true,
      invoice: {
        id: invoice.id,
        invoiceNumber: invoice.invoice_number,
        invoice_number: invoice.invoice_number,
        status: invoice.status,
        invoiceType: invoice.invoice_type,
        invoice_type: invoice.invoice_type,
        shipmentId: invoice.shipment_id,
        shipment_id: invoice.shipment_id,
        subShipmentId: invoice.sub_shipment_id,
        sub_shipment_id: invoice.sub_shipment_id,
      },
      deletedFileCount: relatedFileIds.length,
      deleted_file_count: relatedFileIds.length,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
