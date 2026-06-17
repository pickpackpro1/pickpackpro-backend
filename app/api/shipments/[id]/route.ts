import { Prisma } from "@prisma/client";
import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireClientAccess, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  attachDraftFnskuFiles,
  buildDraftPayload,
  createShipmentLineItems,
  DRAFT_FNSKU_ENTITY_TYPES,
  draftItemSchema,
  parseSubmittedItems,
} from "@/lib/shipmentDrafts";
import { serializeShipment, serializeUploadedFile, shipmentContractInclude } from "@/lib/shipmentContract";
import { PRODUCT_FNSKU_LABEL_ENTITY_TYPE } from "@/lib/productFnskuLabels";
import { bucketFor, supabaseAdmin } from "@/lib/supabase";
import { json } from "@/lib/validation";

const patchSchema = z.object({
  notes: z.string().optional(),
  expectedArrivalDate: z.coerce.date().optional(),
  isDraft: z.boolean().default(true),
  items: z.array(draftItemSchema).optional(),
});

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser(req);
    const shipment = await prisma.shipments.findUnique({
      where: { id: params.id, soft_deleted_at: null },
      include: shipmentContractInclude,
    });
    if (!shipment) throw new ApiError("Shipment not found", 404);
    if (user.role === "client") await requireClientAccess(req, shipment.client_id);
    const draftFiles = await prisma.uploaded_files.findMany({
      where: {
        linked_entity_type: { in: DRAFT_FNSKU_ENTITY_TYPES },
        linked_entity_id: shipment.id,
      },
      orderBy: { uploaded_at: "desc" },
    });
    const serializedDraftFiles = draftFiles.map(serializeUploadedFile).filter(Boolean);
    return success({
      ...serializeShipment(shipment),
      draftFiles: serializedDraftFiles,
      draft_files: serializedDraftFiles,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser(req);
    const shipment = await prisma.shipments.findFirst({
      where: { id: params.id, soft_deleted_at: null },
    });
    if (!shipment) throw new ApiError("Shipment not found", 404);
    if (shipment.status !== "draft") throw new ApiError("Only draft shipments can be edited", 422);
    if (user.role === "client") await requireClientAccess(req, shipment.client_id);

    const body = await json(req, patchSchema);
    const existingDraftPayload =
      shipment.draft_payload && typeof shipment.draft_payload === "object" && !Array.isArray(shipment.draft_payload)
        ? (shipment.draft_payload as Record<string, unknown>)
        : {};
    const payloadItems = body.items ?? (Array.isArray(existingDraftPayload.items) ? existingDraftPayload.items : []);
    const submittedItems = body.isDraft ? [] : parseSubmittedItems(payloadItems);
    const draftPayload = body.isDraft
      ? buildDraftPayload({
          clientId: shipment.client_id,
          notes: body.notes ?? shipment.client_notes ?? null,
          expectedArrivalDate: body.expectedArrivalDate ?? shipment.expected_arrival_date,
          items: payloadItems,
        })
      : undefined;

    const updated = await prisma.$transaction(async (tx) => {
      const shipmentUpdate = await tx.shipments.update({
        where: { id: params.id },
        data: {
          client_notes: body.notes,
          expected_arrival_date: body.expectedArrivalDate,
          status: body.isDraft ? "draft" : "submitted",
          draft_payload: body.isDraft ? draftPayload : Prisma.JsonNull,
          draft_saved_at: body.isDraft ? new Date() : null,
          submitted_at: body.isDraft ? undefined : new Date(),
          submitted_by: body.isDraft ? undefined : user.userId,
          updated_at: new Date(),
        },
      });

      if (!body.isDraft) {
        await tx.shipment_line_items.deleteMany({ where: { shipment_id: params.id } });
        const createdLineItems = await createShipmentLineItems(tx, params.id, shipment.client_id, submittedItems);
        await attachDraftFnskuFiles(tx, params.id, createdLineItems);
      }

      return tx.shipments.findUniqueOrThrow({
        where: { id: shipmentUpdate.id },
        include: shipmentContractInclude,
      });
    });
    const serializedShipment = serializeShipment(updated);

    await prisma.audit_logs.create({
      data: {
        user_id: user.userId,
        user_email: user.email,
        user_role: user.role,
        action: "shipment.updated",
        entity_type: "shipment",
        entity_id: params.id,
        before_value: { status: shipment.status },
        after_value: JSON.parse(JSON.stringify(serializedShipment)),
      },
    });

    return success(serializedShipment);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser(req);
    const shipment = await prisma.shipments.findFirst({
      where: { id: params.id, soft_deleted_at: null },
      include: {
        shipment_line_items: {
          select: {
            id: true,
            fnsku_label_file_id: true,
          },
        },
        outbound_boxes: {
          select: {
            id: true,
            fba_shipping_label_file_id: true,
          },
        },
        sub_shipments: {
          select: {
            id: true,
            reference: true,
            status: true,
          },
        },
      },
    });
    if (!shipment) throw new ApiError("Shipment not found", 404);
    if (user.role === "client") {
      await requireClientAccess(req, shipment.client_id);
    } else if (user.role !== "admin") {
      throw new ApiError("Forbidden", 403);
    }

    const lineItemIds = shipment.shipment_line_items.map((item) => item.id);
    const boxIds = shipment.outbound_boxes.map((box) => box.id);
    const subShipmentIds = shipment.sub_shipments.map((subShipment) => subShipment.id);
    const invoiceSelect = {
      id: true,
      invoice_number: true,
      status: true,
      invoice_type: true,
      shipment_id: true,
      sub_shipment_id: true,
    } satisfies Prisma.invoicesSelect;
    const directInvoiceWhere: Prisma.invoicesWhereInput[] = [{ shipment_id: params.id }];
    const invoiceLineWhere: Prisma.invoice_line_itemsWhereInput[] = [{ shipment_id: params.id }];
    if (subShipmentIds.length > 0) {
      directInvoiceWhere.push({ sub_shipment_id: { in: subShipmentIds } });
      invoiceLineWhere.push({ sub_shipment_id: { in: subShipmentIds } });
    }
    if (lineItemIds.length > 0) {
      invoiceLineWhere.push({ shipment_line_item_id: { in: lineItemIds } });
    }

    const [directInvoices, invoiceLines] = await Promise.all([
      prisma.invoices.findMany({
        where: { OR: directInvoiceWhere },
        select: invoiceSelect,
      }),
      prisma.invoice_line_items.findMany({
        where: { OR: invoiceLineWhere },
        select: {
          invoices: {
            select: invoiceSelect,
          },
        },
      }),
    ]);
    const blockingInvoicesById = new Map<string, (typeof directInvoices)[number]>();
    for (const invoice of directInvoices) blockingInvoicesById.set(invoice.id, invoice);
    for (const line of invoiceLines) blockingInvoicesById.set(line.invoices.id, line.invoices);
    const blockingInvoices = [...blockingInvoicesById.values()].map((invoice) => ({
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
    }));

    if (blockingInvoices.length > 0) {
      if (user.role === "client") {
        throw new ApiError(
          "This shipment has an invoice. You do not have permission to delete this shipment. Please contact admin.",
          403,
          {
            reason: "linked_invoice",
            canDelete: false,
            role: user.role,
          },
        );
      }

      throw new ApiError(
        "This shipment has linked invoices. Delete or cancel the invoices first, then delete the shipment.",
        409,
        {
          reason: "linked_invoice",
          canDelete: false,
          role: user.role,
          blockingInvoices,
        },
      );
    }

    const linkedFileIds = [
      ...shipment.shipment_line_items.map((item) => item.fnsku_label_file_id),
      ...shipment.outbound_boxes.map((box) => box.fba_shipping_label_file_id),
    ].filter((id): id is string => Boolean(id));

    const relatedFiles = await prisma.uploaded_files.findMany({
      where: {
        OR: [
          { linked_entity_type: "shipment", linked_entity_id: params.id },
          { linked_entity_type: { in: DRAFT_FNSKU_ENTITY_TYPES }, linked_entity_id: params.id },
          { linked_entity_type: { in: ["item", "label", "shipment_line_item"] }, linked_entity_id: { in: lineItemIds } },
          { linked_entity_type: { in: ["box", "outbound_box"] }, linked_entity_id: { in: boxIds } },
          { id: { in: linkedFileIds } },
        ],
      },
    });
    const deletableRelatedFiles = relatedFiles.filter(
      (file) => file.linked_entity_type !== PRODUCT_FNSKU_LABEL_ENTITY_TYPE,
    );
    const relatedFileIds = [...new Set(deletableRelatedFiles.map((file) => file.id))];

    const deletedShipment = await prisma.$transaction(async (tx) => {
      await tx.outbound_boxes.deleteMany({ where: { shipment_id: params.id } });
      await tx.sub_shipments.deleteMany({ where: { parent_shipment_id: params.id } });
      await tx.shipment_line_items.deleteMany({ where: { shipment_id: params.id } });
      await tx.staff_check_ins.deleteMany({ where: { shipment_id: params.id } });
      if (relatedFileIds.length > 0) {
        await tx.uploaded_files.deleteMany({ where: { id: { in: relatedFileIds } } });
      }
      const deleted = await tx.shipments.update({
        where: { id: params.id },
        data: { soft_deleted_at: new Date(), updated_at: new Date() },
      });
      await tx.audit_logs.create({
        data: {
          user_id: user.userId,
          user_email: user.email,
          user_role: user.role,
          action: "shipment.soft_delete",
          entity_type: "shipment",
          entity_id: params.id,
          before_value: JSON.parse(JSON.stringify(shipment)),
          after_value: JSON.parse(JSON.stringify(deleted)),
        },
      });
      return deleted;
    });

    const filesByBucket = new Map<string, string[]>();
    for (const file of deletableRelatedFiles) {
      const bucket = bucketFor(file.file_type);
      filesByBucket.set(bucket, [...(filesByBucket.get(bucket) ?? []), file.storage_path]);
    }
    await Promise.all(
      [...filesByBucket.entries()].map(async ([bucket, paths]) => {
        const remove = await supabaseAdmin.storage.from(bucket).remove(paths);
        if (remove.error) {
          console.error("[storage] Failed to remove shipment files:", remove.error);
        }
      })
    );

    return success({ deleted: true, shipment: deletedShipment });
  } catch (err) {
    return handleApiError(err);
  }
}
