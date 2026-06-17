import { Prisma, PrismaClient } from "@prisma/client";
import { serializeUploadedFile } from "@/lib/shipmentContract";

type Db = PrismaClient | Prisma.TransactionClient;

export const PRODUCT_FNSKU_LABEL_ENTITY_TYPE = "product";

export async function getLatestProductFnskuLabelsByProductId(prisma: Db, productIds: string[]) {
  const uniqueProductIds = [...new Set(productIds)].filter(Boolean);
  if (uniqueProductIds.length === 0) return new Map<string, ReturnType<typeof serializeUploadedFile>>();

  const files = await prisma.uploaded_files.findMany({
    where: {
      file_type: "fnsku_label",
      linked_entity_type: PRODUCT_FNSKU_LABEL_ENTITY_TYPE,
      linked_entity_id: { in: uniqueProductIds },
    },
    orderBy: { uploaded_at: "desc" },
  });

  const labelsByProductId = new Map<string, ReturnType<typeof serializeUploadedFile>>();
  for (const file of files) {
    if (!file.linked_entity_id || labelsByProductId.has(file.linked_entity_id)) continue;
    labelsByProductId.set(file.linked_entity_id, serializeUploadedFile(file));
  }

  return labelsByProductId;
}

export function withDefaultFnskuLabelFile<T extends { id: string }>(
  product: T,
  labelFile: ReturnType<typeof serializeUploadedFile> | undefined | null,
) {
  const labelFileId = labelFile?.fileId ?? null;
  return {
    ...product,
    defaultFnskuLabelFileId: labelFileId,
    default_fnsku_label_file_id: labelFileId,
    defaultFnskuLabelFile: labelFile ?? null,
    default_fnsku_label_file: labelFile ?? null,
  };
}
