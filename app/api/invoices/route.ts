import { InvoiceStatus, InvoiceType, Prisma } from "@prisma/client";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

function positiveInt(value: string | null, fallback: number, max?: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return max ? Math.min(parsed, max) : parsed;
}

function normalizeEnum<T extends string>(value: string | null, allowed: readonly T[], field: string) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "all") return undefined;
  if (!allowed.includes(normalized as T)) throw new ApiError(`Invalid ${field}`, 400);
  return normalized as T;
}

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const url = new URL(req.url);
    const hasPagination = url.searchParams.has("page") || url.searchParams.has("limit");
    const page = positiveInt(url.searchParams.get("page"), 1);
    const limit = positiveInt(url.searchParams.get("limit"), 25, 100);
    const clientId = url.searchParams.get("clientId") ?? undefined;
    const status = normalizeEnum(url.searchParams.get("status"), Object.values(InvoiceStatus), "invoice status");
    const invoiceType = normalizeEnum(url.searchParams.get("invoiceType") ?? url.searchParams.get("type"), Object.values(InvoiceType), "invoice type");
    const search = url.searchParams.get("search")?.trim();
    const month = url.searchParams.get("month");
    const dateFrom = url.searchParams.get("dateFrom");
    const dateTo = url.searchParams.get("dateTo");
    let invoiceDate: { gte?: Date; lte?: Date } | undefined;

    if (user.role === "client" && !user.clientId) throw new ApiError("Client user has no clientId", 403);

    if (month) {
      const [year, monthNumber] = month.split("-").map(Number);
      if (year && monthNumber) {
        invoiceDate = {
          gte: new Date(year, monthNumber - 1, 1),
          lte: new Date(year, monthNumber, 0),
        };
      }
    }
    if (dateFrom) invoiceDate = { ...invoiceDate, gte: new Date(dateFrom) };
    if (dateTo) invoiceDate = { ...invoiceDate, lte: new Date(dateTo) };

    const effectiveClientId = user.role === "client" ? user.clientId! : clientId;
    const [matchingShipments, matchingSubShipments] = search
      ? await Promise.all([
          prisma.shipments.findMany({
            where: {
              soft_deleted_at: null,
              client_id: effectiveClientId,
              reference: { contains: search, mode: "insensitive" },
            },
            select: { id: true },
            take: 100,
          }),
          prisma.sub_shipments.findMany({
            where: {
              reference: { contains: search, mode: "insensitive" },
              shipments: {
                soft_deleted_at: null,
                client_id: effectiveClientId,
              },
            },
            select: { id: true },
            take: 100,
          }),
        ])
      : [[], []];
    const shipmentSearchIds = matchingShipments.map((shipment) => shipment.id);
    const subShipmentSearchIds = matchingSubShipments.map((subShipment) => subShipment.id);
    const searchOr: Prisma.invoicesWhereInput[] = search
      ? [
          { invoice_number: { contains: search, mode: "insensitive" } },
          { notes: { contains: search, mode: "insensitive" } },
          { clients: { company_name: { contains: search, mode: "insensitive" } } },
          { clients: { email: { contains: search, mode: "insensitive" } } },
          ...(shipmentSearchIds.length ? [{ shipment_id: { in: shipmentSearchIds } }] : []),
          ...(subShipmentSearchIds.length ? [{ sub_shipment_id: { in: subShipmentSearchIds } }] : []),
        ]
      : [];
    const where: Prisma.invoicesWhereInput = {
      client_id: effectiveClientId,
      status,
      invoice_type: invoiceType,
      invoice_date: invoiceDate,
      ...(searchOr.length ? { OR: searchOr } : {}),
    };
    const select = {
      id: true,
      shipment_id: true,
      sub_shipment_id: true,
      invoice_number: true,
      invoice_date: true,
      due_date: true,
      status: true,
      invoice_type: true,
      period_start: true,
      period_end: true,
      subtotal: true,
      vat_amount: true,
      total: true,
      sent_at: true,
      paid_at: true,
      created_at: true,
      notes: true,
      client_id: true,
      clients: { select: { id: true, company_name: true, email: true, vat_registered: true } },
      _count: { select: { invoice_line_items: true } },
    } satisfies Prisma.invoicesSelect;

    const [invoices, total] = await Promise.all([
      prisma.invoices.findMany({
        where,
        select,
        orderBy: { created_at: "desc" },
        ...(hasPagination ? { skip: (page - 1) * limit, take: limit } : {}),
      }),
      hasPagination ? prisma.invoices.count({ where }) : Promise.resolve(0),
    ]);

    const shipmentIds = [...new Set(invoices.map((invoice) => invoice.shipment_id).filter((id): id is string => Boolean(id)))];
    const subShipmentIds = [...new Set(invoices.map((invoice) => invoice.sub_shipment_id).filter((id): id is string => Boolean(id)))];
    const [sourceShipments, sourceSubShipments] = await Promise.all([
      shipmentIds.length
        ? prisma.shipments.findMany({
            where: { id: { in: shipmentIds } },
            select: { id: true, reference: true },
          })
        : Promise.resolve([]),
      subShipmentIds.length
        ? prisma.sub_shipments.findMany({
            where: { id: { in: subShipmentIds } },
            select: {
              id: true,
              reference: true,
              parent_shipment_id: true,
              shipments: { select: { id: true, reference: true } },
            },
          })
        : Promise.resolve([]),
    ]);
    const shipmentsById = new Map(sourceShipments.map((shipment) => [shipment.id, shipment]));
    const subShipmentsById = new Map(sourceSubShipments.map((subShipment) => [subShipment.id, subShipment]));
    const normalizedInvoices = invoices.map((invoice) => {
      const shipment = invoice.shipment_id ? shipmentsById.get(invoice.shipment_id) : null;
      const subShipment = invoice.sub_shipment_id ? subShipmentsById.get(invoice.sub_shipment_id) : null;
      const sourceReference = subShipment?.reference ?? shipment?.reference ?? null;
      const parentShipmentReference = subShipment?.shipments?.reference ?? shipment?.reference ?? null;

      return {
        ...invoice,
        invoiceNumber: invoice.invoice_number,
        invoice_number: invoice.invoice_number,
        invoiceDate: invoice.invoice_date,
        invoice_date: invoice.invoice_date,
        dueDate: invoice.due_date,
        due_date: invoice.due_date,
        invoiceType: invoice.invoice_type,
        invoice_type: invoice.invoice_type,
        clientId: invoice.client_id,
        client_id: invoice.client_id,
        shipmentId: invoice.shipment_id,
        shipment_id: invoice.shipment_id,
        subShipmentId: invoice.sub_shipment_id,
        sub_shipment_id: invoice.sub_shipment_id,
        shipmentReference: shipment?.reference ?? parentShipmentReference,
        shipment_reference: shipment?.reference ?? parentShipmentReference,
        subShipmentReference: subShipment?.reference ?? null,
        sub_shipment_reference: subShipment?.reference ?? null,
        sourceReference,
        source_reference: sourceReference,
        sourceType: invoice.sub_shipment_id ? "sub_shipment" : invoice.shipment_id ? "shipment" : invoice.invoice_type,
        source_type: invoice.sub_shipment_id ? "sub_shipment" : invoice.shipment_id ? "shipment" : invoice.invoice_type,
        lineItemCount: invoice._count.invoice_line_items,
        line_item_count: invoice._count.invoice_line_items,
      };
    });

    if (hasPagination) {
      return success({
        invoices: normalizedInvoices,
        rows: normalizedInvoices,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      });
    }

    return success(normalizedInvoices);
  } catch (err) {
    return handleApiError(err);
  }
}
