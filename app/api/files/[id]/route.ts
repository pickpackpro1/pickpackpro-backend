import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { bucketFor, supabaseAdmin } from "@/lib/supabase";

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  try {
    await requireRole(req, ["admin", "staff"]);
    const record = await prisma.uploaded_files.findUnique({ where: { id: params.id } });
    if (!record) throw new ApiError("File not found", 404);
    if (record.file_type === "fnsku_label") {
      await prisma.shipment_line_items.updateMany({
        where: { fnsku_label_file_id: record.id },
        data: { fnsku_label_file_id: null, updated_at: new Date() },
      });
    }
    if (record.file_type === "fba_shipping_label") {
      await prisma.outbound_boxes.updateMany({
        where: { fba_shipping_label_file_id: record.id },
        data: { fba_shipping_label_file_id: null, label_uploaded_at: null },
      });
    }
    if (record.file_type === "invoice_pdf") {
      await prisma.invoices.updateMany({ where: { pdf_file_id: record.id }, data: { pdf_file_id: null } });
    }
    if (record.file_type === "invoice_xlsx") {
      await prisma.invoices.updateMany({ where: { xlsx_file_id: record.id }, data: { xlsx_file_id: null } });
    }
    await supabaseAdmin.storage.from(bucketFor(record.file_type)).remove([record.storage_path]);
    await prisma.uploaded_files.delete({ where: { id: params.id } });
    return success({ deleted: true });
  } catch (err) {
    return handleApiError(err);
  }
}
