import { InvoiceType } from "@prisma/client";
import { z } from "zod";
import { handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { bucketFor, supabaseAdmin } from "@/lib/supabase";
import { json } from "@/lib/validation";

const schema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
});

async function deleteClientInvoices(req: Request) {
  const user = await requireRole(req, ["admin"]);
  const body = await json(req, schema);
  const uniqueIds = [...new Set(body.ids)];

  const invoices = await prisma.invoices.findMany({
    where: {
      id: { in: uniqueIds },
      invoice_type: { in: [InvoiceType.monthly, InvoiceType.ad_hoc] },
      shipment_id: null,
      sub_shipment_id: null,
    },
    select: {
      id: true,
      invoice_number: true,
      status: true,
      invoice_type: true,
      client_id: true,
      pdf_file_id: true,
      xlsx_file_id: true,
    },
  });
  const invoiceIds = invoices.map((invoice) => invoice.id);
  const linkedFileIds = invoices.flatMap((invoice) => [invoice.pdf_file_id, invoice.xlsx_file_id]).filter((id): id is string => Boolean(id));
  const relatedFiles = invoiceIds.length
    ? await prisma.uploaded_files.findMany({
        where: {
          OR: [
            ...(linkedFileIds.length ? [{ id: { in: linkedFileIds } }] : []),
            { linked_entity_type: "invoice", linked_entity_id: { in: invoiceIds } },
          ],
        },
      })
    : [];
  const relatedFileIds = [...new Set(relatedFiles.map((file) => file.id))];

  await prisma.$transaction(async (tx) => {
    if (invoiceIds.length) {
      await tx.invoice_line_items.deleteMany({ where: { invoice_id: { in: invoiceIds } } });
      await tx.invoices.deleteMany({ where: { id: { in: invoiceIds } } });
    }
    if (relatedFileIds.length) {
      await tx.uploaded_files.deleteMany({ where: { id: { in: relatedFileIds } } });
    }
    await tx.audit_logs.create({
      data: {
        user_id: user.userId,
        user_email: user.email,
        user_role: user.role,
        action: "client_invoice.bulk_delete",
        entity_type: "invoice",
        entity_id: invoiceIds[0] ?? uniqueIds[0],
        before_value: JSON.parse(JSON.stringify(invoices)),
        after_value: { deletedIds: invoiceIds, requestedIds: uniqueIds },
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
        console.error("[storage] Failed to remove client invoice files:", remove.error);
      }
    }),
  );

  return success({
    deleted: true,
    deletedCount: invoiceIds.length,
    deleted_count: invoiceIds.length,
    deletedIds: invoiceIds,
    deleted_ids: invoiceIds,
    skippedIds: uniqueIds.filter((id) => !invoiceIds.includes(id)),
    skipped_ids: uniqueIds.filter((id) => !invoiceIds.includes(id)),
    deletedFileCount: relatedFileIds.length,
    deleted_file_count: relatedFileIds.length,
  });
}

export async function POST(req: Request) {
  try {
    return await deleteClientInvoices(req);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(req: Request) {
  try {
    return await deleteClientInvoices(req);
  } catch (err) {
    return handleApiError(err);
  }
}
