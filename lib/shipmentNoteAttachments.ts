import { serializeUploadedFile } from "@/lib/shipmentContract";

const NOTE_ATTACHMENT_PURPOSE = "shipment_note_attachment";
const NOTE_ATTACHMENT_LABEL = "Invoice / Dispatch Note";

type JsonRecord = Record<string, any>;

function metadataObject(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

export function serializeShipmentNoteAttachment(file: unknown) {
  const serialized = serializeUploadedFile(file) as JsonRecord | null;
  if (!serialized) return null;

  const metadata = metadataObject(serialized.metadata);
  const purpose = String(metadata.purpose ?? serialized.purpose ?? "").trim();
  const label = String(metadata.label ?? serialized.label ?? "").trim();

  if (purpose !== NOTE_ATTACHMENT_PURPOSE && label !== NOTE_ATTACHMENT_LABEL) return null;

  return {
    ...serialized,
    purpose: NOTE_ATTACHMENT_PURPOSE,
    label: label || NOTE_ATTACHMENT_LABEL,
    noteAttachment: true,
    note_attachment: true,
  };
}

export function serializeShipmentNoteAttachments(files: unknown[]) {
  return files.map(serializeShipmentNoteAttachment).filter((file): file is NonNullable<typeof file> => Boolean(file));
}
