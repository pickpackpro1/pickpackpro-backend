import { FileType } from "@prisma/client";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireClientAccess, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { bucketFor, supabaseAdmin } from "@/lib/supabase";

async function clientIdForEntity(entityType: string, entityId: string, fallback?: string | null) {
  if (entityType === "shipment") return (await prisma.shipments.findUnique({ where: { id: entityId } }))?.client_id;
  if (entityType === "invoice") return (await prisma.invoices.findUnique({ where: { id: entityId } }))?.client_id;
  if (entityType === "item" || entityType === "label") {
    const item = await prisma.shipment_line_items.findUnique({ where: { id: entityId }, include: { shipments: true } });
    return item?.shipments.client_id;
  }
  return fallback ?? undefined;
}

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const url = new URL(req.url);
    const entityType = url.searchParams.get("entityType") ?? undefined;
    const entityId = url.searchParams.get("entityId") ?? undefined;
    const clientId = entityType && entityId ? await clientIdForEntity(entityType, entityId, user.clientId) : user.clientId;
    if (clientId) await requireClientAccess(req, clientId);
    const files = await prisma.uploaded_files.findMany({
      where: {
        client_id: (user.role === "client" ? user.clientId! : clientId) ?? undefined,
        linked_entity_type: entityType,
        linked_entity_id: entityId,
      },
      orderBy: { uploaded_at: "desc" },
    });
    return success(files);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const form = await req.formData();
    const file = form.get("file");
    const entityType = String(form.get("entityType") ?? "");
    const entityId = String(form.get("entityId") ?? "");
    const fileType = String(form.get("fileType") ?? "other") as FileType;
    if (!(file instanceof File)) throw new ApiError("file is required", 400);
    const clientId = await clientIdForEntity(entityType, entityId, user.clientId);
    if (!clientId) throw new ApiError("Could not resolve client for file", 400);
    await requireClientAccess(req, clientId);
    const bucket = bucketFor(fileType);
    const path = `${entityType}/${entityId}/${fileType}/${Date.now()}-${file.name}`;
    const upload = await supabaseAdmin.storage.from(bucket).upload(path, file, { contentType: file.type, upsert: false });
    if (upload.error) throw new ApiError(upload.error.message, 400);
    const record = await prisma.uploaded_files.create({
      data: {
        uploader_user_id: user.userId,
        client_id: clientId,
        file_type: fileType,
        original_filename: file.name,
        storage_path: path,
        file_size_bytes: file.size,
        mime_type: file.type || "application/octet-stream",
        linked_entity_type: entityType,
        linked_entity_id: entityId,
      },
    });
    if (entityType === "label" || (entityType === "item" && fileType === "fnsku_label")) {
      await prisma.shipment_line_items.update({
        where: { id: entityId },
        data: { fnsku_label_file_id: record.id, updated_at: new Date() },
      });
    }
    if (entityType === "box" && fileType === "fba_shipping_label") {
      await prisma.outbound_boxes.update({
        where: { id: entityId },
        data: { fba_shipping_label_file_id: record.id, label_uploaded_at: new Date() },
      });
    }
    if (entityType === "invoice" && (fileType === "invoice_pdf" || fileType === "invoice_xlsx")) {
      await prisma.invoices.update({
        where: { id: entityId },
        data: fileType === "invoice_pdf" ? { pdf_file_id: record.id } : { xlsx_file_id: record.id },
      });
    }
    return success({ url: path, fileRecordId: record.id }, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
