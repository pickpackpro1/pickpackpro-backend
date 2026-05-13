import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { bucketFor, supabaseAdmin } from "@/lib/supabase";

const allowedTypes = new Set(["image/jpeg", "image/png"]);
const maxBytes = 5 * 1024 * 1024;

function safeName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "-");
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireRole(req, ["admin"]);
    const product = await prisma.products.findFirst({ where: { id: params.id, soft_deleted_at: null } });
    if (!product) throw new ApiError("Product not found", 404);

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError("file is required", 400);
    if (!allowedTypes.has(file.type)) throw new ApiError("Product image must be a JPEG or PNG", 422);
    if (file.size > maxBytes) throw new ApiError("Product image must be 5MB or smaller", 422);

    const bucket = bucketFor("product_image");
    const path = `${product.client_id}/${product.id}/${Date.now()}-${safeName(file.name)}`;
    const upload = await supabaseAdmin.storage.from(bucket).upload(path, file, {
      contentType: file.type,
      upsert: true,
    });
    if (upload.error) throw new ApiError(upload.error.message, 400);

    const { data } = supabaseAdmin.storage.from(bucket).getPublicUrl(path);
    const publicUrl = data.publicUrl;

    await prisma.uploaded_files.create({
      data: {
        uploader_user_id: user.userId,
        client_id: product.client_id,
        file_type: "product_image",
        original_filename: file.name,
        storage_path: publicUrl,
        file_size_bytes: file.size,
        mime_type: file.type,
        linked_entity_type: "product",
        linked_entity_id: product.id,
      },
    });

    const updated = await prisma.products.update({
      where: { id: product.id },
      data: { image_path: publicUrl },
      include: { clients: true },
    });

    return success(updated);
  } catch (err) {
    return handleApiError(err);
  }
}
