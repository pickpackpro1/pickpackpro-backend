import { InvoiceStatus, InvoiceType, Prisma } from "@prisma/client";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole, requireUser } from "@/lib/auth";
import { finalInvoiceDates } from "@/lib/invoicing";
import { prisma } from "@/lib/prisma";
import { generateInvoiceNumber, invoiceMonthKey } from "@/lib/referenceGen";
import { json } from "@/lib/validation";
import { z } from "zod";

const CLIENT_INVOICE_TYPES = [InvoiceType.monthly, InvoiceType.ad_hoc] as const;
const DISPATCH_INVOICE_TYPES = [InvoiceType.shipment, InvoiceType.sub_shipment] as const;
const MAX_INVOICE_NUMBER_ATTEMPTS = 5;

const clientInvoiceLineSchema = z.object({
  description: z.string().trim().min(1),
  unit: z.coerce.number().positive().optional(),
  qty: z.coerce.number().positive().optional(),
  rate: z.coerce.number().nonnegative().optional(),
  unitRate: z.coerce.number().nonnegative().optional(),
  unit_rate: z.coerce.number().nonnegative().optional(),
  amount: z.coerce.number().nonnegative().optional(),
});

const createClientInvoiceSchema = z.object({
  clientId: z.string().uuid(),
  invoiceDate: z.coerce.date(),
  invoiceType: z.nativeEnum(InvoiceType).default(InvoiceType.monthly),
  notes: z.string().trim().optional().nullable(),
  description: z.string().trim().min(1).optional(),
  unit: z.coerce.number().positive().optional(),
  qty: z.coerce.number().positive().optional(),
  rate: z.coerce.number().nonnegative().optional(),
  unitRate: z.coerce.number().nonnegative().optional(),
  unit_rate: z.coerce.number().nonnegative().optional(),
  amount: z.coerce.number().nonnegative().optional(),
  lineItems: z.array(clientInvoiceLineSchema).optional(),
  line_items: z.array(clientInvoiceLineSchema).optional(),
});

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

function normalizeCategory(value: string | null) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "all") return undefined;
  if (normalized === "client" || normalized === "dispatch") return normalized;
  throw new ApiError("Invalid invoice category", 400);
}

function isClientInvoiceType(type: InvoiceType | string | null | undefined) {
  return type === InvoiceType.monthly || type === InvoiceType.ad_hoc;
}

function lineInputValues(line: z.infer<typeof clientInvoiceLineSchema>) {
  const unit = line.unit ?? line.qty;
  const rate = line.rate ?? line.unitRate ?? line.unit_rate;
  if (unit == null) throw new ApiError("Client invoice line unit is required", 400);
  if (rate == null) throw new ApiError("Client invoice line rate is required", 400);
  const calculatedAmount = Number((unit * rate).toFixed(2));
  const amount = line.amount == null ? calculatedAmount : Number(line.amount.toFixed(2));
  if (Math.abs(amount - calculatedAmount) > 0.01) {
    throw new ApiError("Client invoice line amount must equal unit multiplied by rate", 400);
  }
  return { unit, rate, amount };
}

function clientInvoiceLinesFromBody(body: z.infer<typeof createClientInvoiceSchema>) {
  const explicitLines = body.lineItems ?? body.line_items;
  const lines =
    explicitLines && explicitLines.length
      ? explicitLines
      : body.description
        ? [
            {
              description: body.description,
              unit: body.unit ?? body.qty,
              rate: body.rate ?? body.unitRate ?? body.unit_rate,
              amount: body.amount,
            },
          ]
        : [];

  if (!lines.length) throw new ApiError("At least one client invoice line is required", 400);

  return lines.map((line, index) => {
    const { unit, rate, amount } = lineInputValues(line);
    return {
      service_code: "client_invoice",
      description: line.description,
      qty: unit,
      unit_rate: rate,
      amount,
      vat_rate: 0,
      vat_amount: 0,
      line_source: "manual",
      sort_order: index + 1,
    };
  });
}

function isInvoiceNumberCollision(err: unknown) {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") return false;
  const target = err.meta?.target;
  if (Array.isArray(target)) return target.includes("invoice_number");
  return String(target ?? "").includes("invoice_number");
}

async function createClientInvoiceWithNumber(data: Omit<Prisma.invoicesUncheckedCreateInput, "invoice_number">) {
  const lockKey = `invoice-create:${invoiceMonthKey(data.invoice_date as Date)}`;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
    for (let attempt = 0; attempt < MAX_INVOICE_NUMBER_ATTEMPTS; attempt++) {
      try {
        return await tx.invoices.create({
          data: {
            ...data,
            invoice_number: await generateInvoiceNumber(tx, data.invoice_date as Date),
          },
          include: {
            clients: true,
            invoice_line_items: { orderBy: { sort_order: "asc" } },
          },
        });
      } catch (err) {
        if (!isInvoiceNumberCollision(err)) throw err;
      }
    }
    throw new ApiError("Could not generate a unique invoice number. Please try again.", 409);
  });
}

function serializeLineItem(line: Prisma.invoice_line_itemsGetPayload<Record<string, never>>) {
  return {
    ...line,
    unit: Number(line.qty),
    qty: Number(line.qty),
    rate: Number(line.unit_rate),
    unitRate: Number(line.unit_rate),
    unit_rate: Number(line.unit_rate),
    amount: Number(line.amount),
    vatRate: Number(line.vat_rate),
    vat_rate: Number(line.vat_rate),
    vatAmount: Number(line.vat_amount),
    vat_amount: Number(line.vat_amount),
  };
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
    const category = normalizeCategory(url.searchParams.get("category"));
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
    const [matchingShipments, matchingSubShipments, matchingInvoiceLines] = search
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
          prisma.invoice_line_items.findMany({
            where: {
              description: { contains: search, mode: "insensitive" },
              invoices: {
                client_id: effectiveClientId,
              },
            },
            select: { invoice_id: true },
            take: 100,
          }),
        ])
      : [[], [], []];
    const shipmentSearchIds = matchingShipments.map((shipment) => shipment.id);
    const subShipmentSearchIds = matchingSubShipments.map((subShipment) => subShipment.id);
    const invoiceLineSearchIds = [...new Set(matchingInvoiceLines.map((line) => line.invoice_id))];
    const searchOr: Prisma.invoicesWhereInput[] = search
      ? [
          { invoice_number: { contains: search, mode: "insensitive" } },
          { notes: { contains: search, mode: "insensitive" } },
          { clients: { company_name: { contains: search, mode: "insensitive" } } },
          { clients: { email: { contains: search, mode: "insensitive" } } },
          ...(shipmentSearchIds.length ? [{ shipment_id: { in: shipmentSearchIds } }] : []),
          ...(subShipmentSearchIds.length ? [{ sub_shipment_id: { in: subShipmentSearchIds } }] : []),
          ...(invoiceLineSearchIds.length ? [{ id: { in: invoiceLineSearchIds } }] : []),
        ]
      : [];
    const invoiceTypeFilter: InvoiceType | Prisma.EnumInvoiceTypeFilter<"invoices"> | undefined =
      invoiceType ??
      (category === "client"
        ? { in: [...CLIENT_INVOICE_TYPES] }
        : category === "dispatch"
          ? { in: [...DISPATCH_INVOICE_TYPES] }
          : undefined);
    const where: Prisma.invoicesWhereInput = {
      client_id: effectiveClientId,
      status,
      invoice_type: invoiceTypeFilter,
      ...(category === "client" ? { shipment_id: null, sub_shipment_id: null } : {}),
      invoice_date: invoiceDate,
      ...(searchOr.length ? { OR: searchOr } : {}),
    };

    await prisma.invoices.updateMany({
      where: {
        client_id: effectiveClientId,
        invoice_type: { in: [...CLIENT_INVOICE_TYPES] },
        status: InvoiceStatus.sent,
        due_date: { lt: new Date() },
      },
      data: { status: InvoiceStatus.overdue },
    });

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

    const includeClientLines =
      category === "client" || invoiceType === InvoiceType.monthly || invoiceType === InvoiceType.ad_hoc;
    const shipmentIds = [...new Set(invoices.map((invoice) => invoice.shipment_id).filter((id): id is string => Boolean(id)))];
    const subShipmentIds = [...new Set(invoices.map((invoice) => invoice.sub_shipment_id).filter((id): id is string => Boolean(id)))];
    const invoiceIds = invoices.map((invoice) => invoice.id);
    const [sourceShipments, sourceSubShipments, invoiceLines] = await Promise.all([
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
      includeClientLines && invoiceIds.length
        ? prisma.invoice_line_items.findMany({
            where: { invoice_id: { in: invoiceIds } },
            orderBy: [{ invoice_id: "asc" }, { sort_order: "asc" }],
          })
        : Promise.resolve([]),
    ]);
    const shipmentsById = new Map(sourceShipments.map((shipment) => [shipment.id, shipment]));
    const subShipmentsById = new Map(sourceSubShipments.map((subShipment) => [subShipment.id, subShipment]));
    const invoiceLinesByInvoiceId = new Map<string, ReturnType<typeof serializeLineItem>[]>();
    for (const line of invoiceLines) {
      const serializedLine = serializeLineItem(line);
      invoiceLinesByInvoiceId.set(line.invoice_id, [...(invoiceLinesByInvoiceId.get(line.invoice_id) ?? []), serializedLine]);
    }
    const normalizedInvoices = invoices.map((invoice) => {
      const shipment = invoice.shipment_id ? shipmentsById.get(invoice.shipment_id) : null;
      const subShipment = invoice.sub_shipment_id ? subShipmentsById.get(invoice.sub_shipment_id) : null;
      const sourceReference = subShipment?.reference ?? shipment?.reference ?? null;
      const parentShipmentReference = subShipment?.shipments?.reference ?? shipment?.reference ?? null;
      const isClientInvoice = isClientInvoiceType(invoice.invoice_type) && !invoice.shipment_id && !invoice.sub_shipment_id;
      const lineItems = invoiceLinesByInvoiceId.get(invoice.id) ?? [];
      const firstLine = lineItems[0] ?? null;

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
        sourceReference: isClientInvoice ? "Client Invoice" : sourceReference,
        source_reference: isClientInvoice ? "Client Invoice" : sourceReference,
        sourceType: isClientInvoice ? "client_invoice" : invoice.sub_shipment_id ? "sub_shipment" : invoice.shipment_id ? "shipment" : invoice.invoice_type,
        source_type: isClientInvoice ? "client_invoice" : invoice.sub_shipment_id ? "sub_shipment" : invoice.shipment_id ? "shipment" : invoice.invoice_type,
        category: isClientInvoice ? "client" : "dispatch",
        isClientInvoice,
        is_client_invoice: isClientInvoice,
        lineItems,
        line_items: lineItems,
        description: firstLine?.description ?? null,
        unit: firstLine?.unit ?? null,
        rate: firstLine?.rate ?? null,
        amount: firstLine?.amount ?? Number(invoice.total),
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

export async function POST(req: Request) {
  try {
    const user = await requireRole(req, ["admin"]);
    const body = await json(req, createClientInvoiceSchema);
    if (!isClientInvoiceType(body.invoiceType)) {
      throw new ApiError("Client invoices must use invoiceType monthly or ad_hoc", 400);
    }

    const client = await prisma.clients.findFirst({
      where: { id: body.clientId, soft_deleted_at: null },
      select: { id: true },
    });
    if (!client) throw new ApiError("Client not found", 404);

    const lines = clientInvoiceLinesFromBody(body);
    const total = lines.reduce((sum, line) => sum + Number(line.amount), 0);
    const invoiceDate = body.invoiceDate;
    const { dueDate } = await finalInvoiceDates(prisma, invoiceDate);
    const invoice = await createClientInvoiceWithNumber({
      client_id: body.clientId,
      shipment_id: null,
      sub_shipment_id: null,
      invoice_date: invoiceDate,
      due_date: dueDate,
      invoice_type: body.invoiceType,
      status: InvoiceStatus.draft,
      subtotal: total,
      vat_amount: 0,
      total,
      notes: body.notes ?? null,
      created_by: user.userId,
      invoice_line_items: {
        create: lines,
      },
    });

    await prisma.audit_logs.create({
      data: {
        user_id: user.userId,
        user_email: user.email,
        user_role: user.role,
        action: "client_invoice.created",
        entity_type: "invoice",
        entity_id: invoice.id,
        after_value: JSON.parse(JSON.stringify(invoice)),
      },
    });

    return success(
      {
        ...invoice,
        isClientInvoice: true,
        is_client_invoice: true,
        category: "client",
        lineItems: invoice.invoice_line_items.map(serializeLineItem),
        line_items: invoice.invoice_line_items.map(serializeLineItem),
      },
      201,
    );
  } catch (err) {
    return handleApiError(err);
  }
}
