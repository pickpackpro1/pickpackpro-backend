import { Prisma } from "@prisma/client";
import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { bucketFor, supabaseAdmin } from "@/lib/supabase";
import { json } from "@/lib/validation";

const MAX_BATCH_LOOKUPS = 250;

const entityLookupSchema = z.object({
  entityType: z.string().trim().min(1).max(80),
  entityId: z.string().uuid(),
});

const batchFilesSchema = z.object({
  entities: z.array(entityLookupSchema).max(MAX_BATCH_LOOKUPS).default([]),
  fileIds: z.array(z.string().uuid()).max(MAX_BATCH_LOOKUPS).default([]),
});

type EntityLookup = z.infer<typeof entityLookupSchema>;

function entityKey(entityType: string | null | undefined, entityId: string | null | undefined) {
  return `${String(entityType || "").trim()}:${String(entityId || "").trim()}`;
}

function uniqueValues(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueEntities(entities: EntityLookup[]) {
  const seen = new Set<string>();
  return entities.filter((entity) => {
    const key = entityKey(entity.entityType, entity.entityId);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseEntityParam(value: string): EntityLookup | null {
  const separatorIndex = value.indexOf(":");
  if (separatorIndex <= 0) return null;
  const entityType = value.slice(0, separatorIndex).trim();
  const entityId = value.slice(separatorIndex + 1).trim();
  const parsed = entityLookupSchema.safeParse({ entityType, entityId });
  return parsed.success ? parsed.data : null;
}

function parseGetRequest(req: Request) {
  const url = new URL(req.url);
  const entities = url.searchParams
    .getAll("entity")
    .map(parseEntityParam)
    .filter((entity): entity is EntityLookup => Boolean(entity));
  const commaSeparatedFileIds = url.searchParams
    .getAll("fileIds")
    .flatMap((value) => value.split(","));
  const fileIds = [...url.searchParams.getAll("fileId"), ...commaSeparatedFileIds];

  return batchFilesSchema.parse({
    entities,
    fileIds,
  });
}

function serializeFile(file: Prisma.uploaded_filesGetPayload<{ select: typeof fileSelect }>) {
  const publicUrl = supabaseAdmin.storage
    .from(bucketFor(file.file_type))
    .getPublicUrl(file.storage_path).data.publicUrl;

  return {
    ...file,
    fileId: file.id,
    file_id: file.id,
    fileType: file.file_type,
    file_type: file.file_type,
    fileName: file.original_filename,
    file_name: file.original_filename,
    originalFilename: file.original_filename,
    original_filename: file.original_filename,
    mimeType: file.mime_type,
    mime_type: file.mime_type,
    storagePath: file.storage_path,
    storage_path: file.storage_path,
    entityType: file.linked_entity_type,
    entity_type: file.linked_entity_type,
    linkedEntityType: file.linked_entity_type,
    linked_entity_type: file.linked_entity_type,
    entityId: file.linked_entity_id,
    entity_id: file.linked_entity_id,
    linkedEntityId: file.linked_entity_id,
    linked_entity_id: file.linked_entity_id,
    uploadedAt: file.uploaded_at,
    uploaded_at: file.uploaded_at,
    url: publicUrl,
    publicUrl,
    public_url: publicUrl,
  };
}

const fileSelect = {
  id: true,
  uploader_user_id: true,
  client_id: true,
  file_type: true,
  original_filename: true,
  storage_path: true,
  file_size_bytes: true,
  mime_type: true,
  linked_entity_type: true,
  linked_entity_id: true,
  metadata: true,
  uploaded_at: true,
} satisfies Prisma.uploaded_filesSelect;

async function getBatchFiles(req: Request, input: z.infer<typeof batchFilesSchema>) {
  const user = await requireUser(req);
  if (user.role === "client" && !user.clientId) {
    throw new ApiError("Client user has no clientId", 403);
  }

  const entities = uniqueEntities(input.entities);
  const fileIds = uniqueValues(input.fileIds);
  const lookupCount = entities.length + fileIds.length;
  if (lookupCount > MAX_BATCH_LOOKUPS) {
    throw new ApiError(`Batch can include at most ${MAX_BATCH_LOOKUPS} lookups`, 400);
  }

  if (lookupCount === 0) {
    return success({
      files: [],
      filesByEntity: {},
      entityFiles: [],
      filesById: {},
      total: 0,
    });
  }

  const entityIdsByType = new Map<string, string[]>();
  for (const entity of entities) {
    entityIdsByType.set(entity.entityType, [
      ...(entityIdsByType.get(entity.entityType) ?? []),
      entity.entityId,
    ]);
  }

  const entityFilters = [...entityIdsByType.entries()].map(([entityType, entityIds]) => ({
    linked_entity_type: entityType,
    linked_entity_id: { in: uniqueValues(entityIds) },
  }));

  const where: Prisma.uploaded_filesWhereInput = {
    ...(user.role === "client" ? { client_id: user.clientId! } : {}),
    OR: [
      ...entityFilters,
      ...(fileIds.length ? [{ id: { in: fileIds } }] : []),
    ],
  };

  const files = await prisma.uploaded_files.findMany({
    where,
    select: fileSelect,
    orderBy: { uploaded_at: "desc" },
  });

  const serializedFiles = files.map(serializeFile);
  const filesByEntity: Record<string, ReturnType<typeof serializeFile>[]> = {};
  const filesById: Record<string, ReturnType<typeof serializeFile>> = {};

  for (const file of serializedFiles) {
    filesById[file.id] = file;
    const key = entityKey(file.linked_entity_type, file.linked_entity_id);
    if (key !== ":") {
      filesByEntity[key] ??= [];
      filesByEntity[key].push(file);
    }
  }

  const entityFiles = entities.map((entity) => {
    const key = entityKey(entity.entityType, entity.entityId);
    return {
      entityType: entity.entityType,
      entityId: entity.entityId,
      key,
      files: filesByEntity[key] ?? [],
    };
  });

  return success({
    files: serializedFiles,
    filesByEntity,
    entityFiles,
    filesById,
    total: serializedFiles.length,
  });
}

export async function GET(req: Request) {
  try {
    return await getBatchFiles(req, parseGetRequest(req));
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    return await getBatchFiles(req, await json(req, batchFilesSchema));
  } catch (err) {
    return handleApiError(err);
  }
}
