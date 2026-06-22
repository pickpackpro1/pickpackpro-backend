import { Prisma, ShipmentStatus } from "@prisma/client";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const RECEIVING_STATUSES: ShipmentStatus[] = [ShipmentStatus.submitted, ShipmentStatus.pending_arrival];

function positiveInt(value: string | null, fallback: number, max?: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return max ? Math.min(parsed, max) : parsed;
}

function parseStatus(value: string | null) {
  const normalized = String(value ?? "all").trim().toLowerCase();
  if (!normalized || normalized === "all") return { in: RECEIVING_STATUSES };
  if (normalized === ShipmentStatus.submitted || normalized === ShipmentStatus.pending_arrival) {
    return normalized as ShipmentStatus;
  }
  throw new ApiError("Invalid receiving queue status", 400);
}

export async function GET(req: Request) {
  try {
    await requireRole(req, ["admin", "staff"]);
    const url = new URL(req.url);
    const page = positiveInt(url.searchParams.get("page"), 1);
    const limit = positiveInt(url.searchParams.get("limit"), DEFAULT_LIMIT, MAX_LIMIT);
    const search = url.searchParams.get("search")?.trim();
    const status = parseStatus(url.searchParams.get("status"));
    const clientId = url.searchParams.get("clientId")?.trim() || undefined;
    const where: Prisma.shipmentsWhereInput = {
      soft_deleted_at: null,
      status,
      client_id: clientId,
      ...(search
        ? {
            OR: [
              { reference: { contains: search, mode: "insensitive" } },
              { clients: { company_name: { contains: search, mode: "insensitive" } } },
              { clients: { email: { contains: search, mode: "insensitive" } } },
              {
                shipment_line_items: {
                  some: {
                    OR: [
                      { product_name: { contains: search, mode: "insensitive" } },
                      { fnsku: { contains: search, mode: "insensitive" } },
                      { products: { sku: { contains: search, mode: "insensitive" } } },
                      { products: { product_name: { contains: search, mode: "insensitive" } } },
                    ],
                  },
                },
              },
            ],
          }
        : {}),
    };

    const [shipments, total, submittedCount, pendingArrivalCount] = await Promise.all([
      prisma.shipments.findMany({
        where,
        select: {
          id: true,
          reference: true,
          status: true,
          client_id: true,
          expected_arrival_date: true,
          actual_arrival_date: true,
          submitted_at: true,
          assigned_to: true,
          created_at: true,
          updated_at: true,
          clients: {
            select: {
              id: true,
              company_name: true,
              email: true,
              status: true,
            },
          },
          users_shipments_assigned_toTousers: {
            select: { id: true, full_name: true, email: true, role: true },
          },
          shipment_line_items: {
            select: {
              id: true,
              product_name: true,
              fnsku: true,
              qty_expected: true,
              qty_received: true,
              products: {
                select: {
                  id: true,
                  sku: true,
                  product_name: true,
                  default_fnsku: true,
                },
              },
            },
            orderBy: [{ display_order: "asc" }, { created_at: "asc" }],
          },
        },
        orderBy: { created_at: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.shipments.count({ where }),
      prisma.shipments.count({
        where: {
          ...where,
          status: ShipmentStatus.submitted,
        },
      }),
      prisma.shipments.count({
        where: {
          ...where,
          status: ShipmentStatus.pending_arrival,
        },
      }),
    ]);

    const rows = shipments.map((shipment) => {
      const lineItems = shipment.shipment_line_items.map((item) => {
        const expectedQty = Number(item.qty_expected ?? 0);
        const receivedQty = item.qty_received === null ? null : Number(item.qty_received);
        return {
          id: item.id,
          shipmentItemId: item.id,
          shipment_item_id: item.id,
          productName: item.product_name ?? item.products.product_name,
          product_name: item.product_name ?? item.products.product_name,
          sku: item.products.sku,
          fnsku: item.fnsku,
          expectedQty,
          expected_qty: expectedQty,
          receivedQty,
          received_qty: receivedQty,
        };
      });
      const totalExpectedQty = lineItems.reduce((sum, item) => sum + item.expectedQty, 0);
      const totalReceivedQty = lineItems.reduce((sum, item) => sum + Number(item.receivedQty ?? 0), 0);

      return {
        id: shipment.id,
        shipmentId: shipment.id,
        shipment_id: shipment.id,
        reference: shipment.reference,
        shipmentReference: shipment.reference,
        shipment_reference: shipment.reference,
        status: shipment.status,
        clientId: shipment.client_id,
        client_id: shipment.client_id,
        clientName: shipment.clients.company_name,
        client_name: shipment.clients.company_name,
        clientEmail: shipment.clients.email,
        client_email: shipment.clients.email,
        client: {
          id: shipment.clients.id,
          companyName: shipment.clients.company_name,
          company_name: shipment.clients.company_name,
          email: shipment.clients.email,
          status: shipment.clients.status,
        },
        expectedArrivalDate: shipment.expected_arrival_date,
        expected_arrival_date: shipment.expected_arrival_date,
        actualArrivalDate: shipment.actual_arrival_date,
        actual_arrival_date: shipment.actual_arrival_date,
        submittedAt: shipment.submitted_at,
        submitted_at: shipment.submitted_at,
        assignedTo: shipment.assigned_to,
        assigned_to: shipment.assigned_to,
        assignedUser: shipment.users_shipments_assigned_toTousers,
        assigned_user: shipment.users_shipments_assigned_toTousers,
        createdAt: shipment.created_at,
        created_at: shipment.created_at,
        updatedAt: shipment.updated_at,
        updated_at: shipment.updated_at,
        lineItems,
        line_items: lineItems,
        shipmentLineItems: lineItems,
        shipment_line_items: lineItems,
        lineItemCount: lineItems.length,
        line_item_count: lineItems.length,
        totalExpectedQty,
        total_expected_qty: totalExpectedQty,
        totalReceivedQty,
        total_received_qty: totalReceivedQty,
        units: totalExpectedQty,
      };
    });

    return success({
      rows,
      shipments: rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      submittedCount,
      submitted_count: submittedCount,
      pendingArrivalCount,
      pending_arrival_count: pendingArrivalCount,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
