import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireClientAccess, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { bucketFor, supabaseAdmin } from "@/lib/supabase";

function parseBoxIds(form: FormData) {
  const repeated = [...form.getAll("boxIds"), ...form.getAll("boxIds[]")]
    .filter((value): value is string => typeof value === "string")
    .flatMap((value) => {
      const trimmed = value.trim();
      if (!trimmed) return [];
      if (trimmed.startsWith("[")) {
        try {
          const parsed = JSON.parse(trimmed);
          return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
        } catch {
          return [];
        }
      }
      return [trimmed];
    });

  return [...new Set(repeated)];
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const form = await req.formData();
    const file = form.get("file");
    const fileType = String(form.get("fileType") ?? "");
    const shipmentId = String(form.get("shipmentId") ?? "");
    const boxIds = parseBoxIds(form);

    if (!(file instanceof File)) throw new ApiError("file is required", 400);
    if (fileType !== "fba_shipping_label") throw new ApiError("fileType must be fba_shipping_label", 400);
    if (!shipmentId) throw new ApiError("shipmentId is required", 400);
    if (boxIds.length === 0) throw new ApiError("boxIds must be a non-empty array", 400);

    const shipment = await prisma.shipments.findFirst({
      where: { id: shipmentId, soft_deleted_at: null },
      select: { id: true, client_id: true },
    });
    if (!shipment) throw new ApiError("Shipment not found", 404);

    await requireClientAccess(req, shipment.client_id);

    const boxes = await prisma.outbound_boxes.findMany({
      where: { id: { in: boxIds } },
      select: { id: true, shipment_id: true },
    });
    if (boxes.length !== boxIds.length) {
      const foundIds = new Set(boxes.map((box) => box.id));
      const missingBoxIds = boxIds.filter((boxId) => !foundIds.has(boxId));
      throw new ApiError("One or more selected boxes were not found", 404, { missingBoxIds });
    }
    if (boxes.some((box) => box.shipment_id !== shipmentId)) {
      throw new ApiError("Boxes belong to different shipments", 400);
    }

    const bucket = bucketFor("fba_shipping_label");
    const path = `shipment/${shipmentId}/fba_shipping_label/${Date.now()}-${file.name}`;
    const upload = await supabaseAdmin.storage.from(bucket).upload(path, file, {
      contentType: file.type,
      upsert: false,
    });
    if (upload.error) throw new ApiError(upload.error.message, 400);

    const now = new Date();
    const fileRecords = await prisma.$transaction(async (tx) => {
      const created = [];
      for (const box of boxes) {
        const record = await tx.uploaded_files.create({
          data: {
            uploader_user_id: user.userId,
            client_id: shipment.client_id,
            file_type: "fba_shipping_label",
            original_filename: file.name,
            storage_path: path,
            file_size_bytes: file.size,
            mime_type: file.type || "application/octet-stream",
            linked_entity_type: "box",
            linked_entity_id: box.id,
          },
        });
        await tx.outbound_boxes.update({
          where: { id: box.id },
          data: { fba_shipping_label_file_id: record.id, label_uploaded_at: now },
        });
        created.push(record);
      }
      return created;
    });

    return success(
      {
        fileId: fileRecords[0]?.id,
        boxIds,
        updatedCount: fileRecords.length,
      },
      201
    );
  } catch (err) {
    return handleApiError(err);
  }
}
