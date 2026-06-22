import { FileType } from "@prisma/client";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireClientAccess, requireUser } from "@/lib/auth";
import { sendEmail } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { DRAFT_FNSKU_ENTITY_TYPES } from "@/lib/shipmentDrafts";
import { refreshSubShipmentStatusFromBoxes } from "@/lib/subShipments";
import { bucketFor, supabaseAdmin } from "@/lib/supabase";

async function clientIdForEntity(entityType: string, entityId: string, fallback?: string | null) {
  if (entityType === "shipment") return (await prisma.shipments.findUnique({ where: { id: entityId } }))?.client_id;
  if (DRAFT_FNSKU_ENTITY_TYPES.includes(entityType)) {
    return (await prisma.shipments.findUnique({ where: { id: entityId } }))?.client_id;
  }
  if (entityType === "sub_shipment" || entityType === "subShipment") {
    const subShipment = await prisma.sub_shipments.findUnique({
      where: { id: entityId },
      include: { shipments: { select: { client_id: true } } },
    });
    return subShipment?.shipments.client_id;
  }
  if (entityType === "invoice") return (await prisma.invoices.findUnique({ where: { id: entityId } }))?.client_id;
  if (entityType === "product") {
    return (await prisma.products.findFirst({ where: { id: entityId, soft_deleted_at: null } }))?.client_id;
  }
  if (entityType === "item" || entityType === "label") {
    const item = await prisma.shipment_line_items.findUnique({ where: { id: entityId }, include: { shipments: true } });
    return item?.shipments.client_id;
  }
  if (entityType === "box" || entityType === "pallet") {
    const box = await prisma.outbound_boxes.findUnique({
      where: { id: entityId },
      include: { shipments: { select: { client_id: true } } },
    });
    return box?.shipments?.client_id;
  }
  return fallback ?? undefined;
}

function optionalText(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function optionalNumber(value: FormDataEntryValue | null) {
  const text = optionalText(value);
  if (!text) return undefined;
  const number = Number(text);
  return Number.isFinite(number) ? number : undefined;
}

function metadataFromForm(form: FormData) {
  const rawMetadata = optionalText(form.get("metadata"));
  let metadata: Record<string, unknown> = {};
  if (rawMetadata) {
    try {
      const parsed = JSON.parse(rawMetadata);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        metadata = parsed;
      }
    } catch {
      throw new ApiError("metadata must be valid JSON", 400);
    }
  }

  const draftItemId = optionalText(form.get("draftItemId")) ?? optionalText(form.get("draft_item_id"));
  const itemIndex = optionalNumber(form.get("itemIndex")) ?? optionalNumber(form.get("item_index"));
  const lineItemIndex = optionalNumber(form.get("lineItemIndex")) ?? optionalNumber(form.get("line_item_index"));
  const displayOrder = optionalNumber(form.get("displayOrder")) ?? optionalNumber(form.get("display_order"));
  const sku = optionalText(form.get("sku"));
  const fnsku = optionalText(form.get("fnsku")) ?? optionalText(form.get("fnskuLabel")) ?? optionalText(form.get("fnsku_label"));
  const productName = optionalText(form.get("productName")) ?? optionalText(form.get("product_name"));
  const purpose = optionalText(form.get("purpose"));
  const label = optionalText(form.get("label"));

  return JSON.parse(
    JSON.stringify({
      ...metadata,
      ...(purpose ? { purpose } : {}),
      ...(label ? { label } : {}),
      ...(draftItemId ? { draftItemId, draft_item_id: draftItemId } : {}),
      ...(itemIndex != null ? { itemIndex, item_index: itemIndex } : {}),
      ...(lineItemIndex != null ? { lineItemIndex, line_item_index: lineItemIndex } : {}),
      ...(displayOrder != null ? { displayOrder, display_order: displayOrder } : {}),
      ...(sku ? { sku } : {}),
      ...(fnsku ? { fnsku, fnskuLabel: fnsku, fnsku_label: fnsku } : {}),
      ...(productName ? { productName, product_name: productName } : {}),
    })
  );
}

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const url = new URL(req.url);
    const entityType = url.searchParams.get("entityType") ?? undefined;
    const entityId = url.searchParams.get("entityId") ?? undefined;
    if (entityType === "product" && user.role === "staff") throw new ApiError("Forbidden", 403);
    const clientId = entityType && entityId ? await clientIdForEntity(entityType, entityId, user.clientId) : user.clientId;
    const resolvedClientId = user.role === "client" ? user.clientId! : clientId;
    if (resolvedClientId) await requireClientAccess(req, resolvedClientId);
    const files = await prisma.uploaded_files.findMany({
      where: {
        ...(resolvedClientId ? { client_id: resolvedClientId } : {}),
        linked_entity_type: entityType,
        linked_entity_id: entityId,
      },
      orderBy: { uploaded_at: "desc" },
    });
    const filesWithUrls = files.map((file) => {
      const { data } = supabaseAdmin.storage
        .from(bucketFor(file.file_type))
        .getPublicUrl(file.storage_path);
      return {
        ...file,
        url: data.publicUrl,
        publicUrl: data.publicUrl,
      };
    });
    return success(filesWithUrls);
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
    if (entityType === "product" && user.role === "staff") throw new ApiError("Forbidden", 403);
    const isDraftFnskuFile = DRAFT_FNSKU_ENTITY_TYPES.includes(entityType);
    const metadata = metadataFromForm(form);
    if (!(file instanceof File)) throw new ApiError("file is required", 400);
    const clientId = await clientIdForEntity(entityType, entityId, user.clientId);
    if (!clientId) throw new ApiError("Could not resolve client for file", 400);
    await requireClientAccess(req, clientId);
    if (isDraftFnskuFile && fileType !== "fnsku_label") {
      throw new ApiError("Draft shipment item uploads must use fileType fnsku_label", 422);
    }
    if (
      isDraftFnskuFile &&
      !metadata.draftItemId &&
      metadata.itemIndex == null &&
      metadata.lineItemIndex == null &&
      metadata.displayOrder == null
    ) {
      throw new ApiError("Draft FNSKU uploads require draftItemId or item index metadata", 422);
    }
    if (entityType === "shipment" && fileType === "fnsku_label") {
      throw new ApiError("FNSKU labels must be uploaded against a shipment line item", 422);
    }
    if (entityType === "product" && fileType !== "fnsku_label") {
      throw new ApiError("Product default FNSKU label uploads must use fileType fnsku_label", 422);
    }
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
        metadata,
      },
    });
    // Link when entityType is 'item' or 'label' (line item UUID passed directly)
    if ((entityType === "label" || entityType === "item") && fileType === "fnsku_label") {
      const lineItem = await prisma.shipment_line_items.update({
        where: { id: entityId },
        data: { fnsku_label_file_id: record.id, updated_at: new Date() },
        select: { product_id: true },
      });
      await prisma.products.updateMany({
        where: {
          id: lineItem.product_id,
          default_fnsku_label_file_id: null,
        },
        data: { default_fnsku_label_file_id: record.id },
      });
    }

    if (entityType === "product" && fileType === "fnsku_label") {
      await prisma.products.update({
        where: { id: entityId },
        data: { default_fnsku_label_file_id: record.id },
      });
    }

    if ((entityType === "box" || entityType === "pallet") && fileType === "fba_shipping_label") {
      await prisma.outbound_boxes.update({
        where: { id: entityId },
        data: { fba_shipping_label_file_id: record.id, label_uploaded_at: new Date() },
      });
      const box = await prisma.outbound_boxes.findUnique({
        where: { id: entityId },
        include: { shipments: true },
      });
      if (box?.sub_shipment_id) {
        await refreshSubShipmentStatusFromBoxes(prisma, box.sub_shipment_id);
      }
      if (box) {
        const staffToNotify = box.shipments.assigned_to
          ? [box.shipments.assigned_to]
          : (await prisma.users.findMany({
              where: { role: "staff", active: true },
            })).map((staff) => staff.id);

        await prisma.notifications.createMany({
          data: staffToNotify.map((userId) => ({
            user_id: userId,
            type: "label_uploaded",
            title: "FBA Label Uploaded",
            body: `FBA label uploaded for shipment ${box.shipments.reference}.`,
            link_url: `/shipments/${box.shipments.id}`,
          })),
        });
        try {
          const staffEmails = await prisma.users.findMany({
            where: { id: { in: staffToNotify }, active: true },
            select: { email: true },
          });
          await sendEmail({
            to: staffEmails.map((staff) => staff.email),
            subject: `FBA Label Uploaded — ${box.shipments.reference}`,
            html: `<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6f9;padding:40px 0;font-family:Arial,sans-serif;">
  <tr>
    <td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr>
          <td style="background-color:#132347;padding:28px 40px;">
            <div style="color:#ffffff;font-size:20px;font-weight:bold;">📦 PickPackPro</div>
            <div style="color:#8899bb;font-size:12px;margin-top:4px;">Warehouse Management System</div>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 40px 4px 40px;">
            <div style="background-color:#FF6B2C;height:4px;border-radius:2px;"></div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px;">
            <h2 style="color:#132347;font-size:20px;font-weight:bold;margin:0 0 8px 0;">FBA Label Uploaded</h2>
            <p style="color:#FF6B2C;font-size:14px;font-weight:bold;margin:0 0 24px 0;">Ready for dispatch</p>
            <p style="color:#555555;font-size:15px;line-height:1.6;margin:0 0 16px 0;">
              A client has uploaded an FBA shipping label. This shipment is now ready to be dispatched.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border-radius:6px;border:1px solid #e8ecf0;margin:0 0 28px 0;">
              <tr>
                <td style="padding:16px 20px;">
                  <div style="color:#888888;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Shipment Reference</div>
                  <div style="color:#132347;font-size:18px;font-weight:bold;">${box.shipments.reference}</div>
                </td>
              </tr>
            </table>
            <table cellpadding="0" cellspacing="0">
              <tr>
                <td style="background-color:#FF6B2C;border-radius:6px;padding:12px 24px;">
                  <a href="${process.env.FRONTEND_URL}/dispatch" style="color:#ffffff;font-size:14px;font-weight:bold;text-decoration:none;">Go to Dispatch →</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="background-color:#f4f6f9;padding:20px 40px;border-top:1px solid #e8ecf0;text-align:center;">
            <p style="color:#aaaaaa;font-size:12px;margin:0;">© 2026 Pick Pack Pro · pickpackpro.co.uk</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`,
          });
        } catch (emailErr) {
          console.error("[email] Failed to send FBA label uploaded email:", emailErr);
        }
      }
    }
    if (entityType === "invoice" && (fileType === "invoice_pdf" || fileType === "invoice_xlsx")) {
      await prisma.invoices.update({
        where: { id: entityId },
        data: fileType === "invoice_pdf" ? { pdf_file_id: record.id } : { xlsx_file_id: record.id },
      });
    }
    const { data: publicData } = supabaseAdmin.storage
      .from(bucket)
      .getPublicUrl(path);
    return success({
      url: publicData.publicUrl,
      publicUrl: publicData.publicUrl,
      storagePath: path,
      fileRecordId: record.id,
      metadata,
    }, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
