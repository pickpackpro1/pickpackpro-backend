import { Prisma, ShipmentStatus } from "@prisma/client";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const shipmentStatuses = new Set<string>(Object.values(ShipmentStatus));

function positiveInt(value: string | null, fallback: number) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function mapById<T extends Record<string, unknown>>(rows: T[], key: keyof T) {
  return new Map(rows.map((row) => [String(row[key]), row]));
}

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const url = new URL(req.url);
    const page = positiveInt(url.searchParams.get("page"), 1);
    const limit = Math.min(positiveInt(url.searchParams.get("limit"), 20), 100);
    const rawStatus = url.searchParams.get("status")?.toLowerCase();
    const clientId = url.searchParams.get("clientId") ?? undefined;
    const search = url.searchParams.get("search")?.trim() || undefined;

    if (user.role === "client" && !user.clientId) {
      throw new ApiError("Client user has no clientId", 403);
    }

    if (rawStatus && !shipmentStatuses.has(rawStatus)) {
      throw new ApiError("Invalid shipment status", 400);
    }

    const where: Prisma.shipmentsWhereInput = {
      soft_deleted_at: null,
      status: rawStatus as ShipmentStatus | undefined,
      client_id: user.role === "client" ? user.clientId! : clientId,
      shipment_line_items: search
        ? {
            some: {
              OR: [
                { product_name: { contains: search, mode: "insensitive" } },
                { products: { sku: { contains: search, mode: "insensitive" } } },
                { products: { product_name: { contains: search, mode: "insensitive" } } },
              ],
            },
          }
        : undefined,
    };

    const [rows, total] = await Promise.all([
      prisma.shipments.findMany({
        where,
        select: {
          id: true,
          reference: true,
          status: true,
          client_id: true,
          expected_arrival_date: true,
          actual_arrival_date: true,
          estimated_dispatch_date: true,
          dispatched_date: true,
          completed_date: true,
          client_notes: true,
          assigned_to: true,
          submitted_at: true,
          draft_saved_at: true,
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
            select: {
              id: true,
              full_name: true,
              email: true,
              role: true,
            },
          },
        },
        orderBy: { created_at: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.shipments.count({ where }),
    ]);

    const shipmentIds = rows.map((row) => row.id);

    const [
      itemTotals,
      discrepancyTotals,
      boxTotals,
      missingLabelTotals,
      subShipmentTotals,
      activeCheckInTotals,
    ] = shipmentIds.length
      ? await Promise.all([
          prisma.shipment_line_items.groupBy({
            by: ["shipment_id"],
            where: { shipment_id: { in: shipmentIds } },
            _count: { _all: true },
            _sum: {
              qty_expected: true,
              qty_received: true,
              dispatch_qty: true,
            },
          }),
          prisma.shipment_line_items.groupBy({
            by: ["shipment_id"],
            where: { shipment_id: { in: shipmentIds }, qty_discrepancy_flag: true },
            _count: { _all: true },
          }),
          prisma.outbound_boxes.groupBy({
            by: ["shipment_id"],
            where: { shipment_id: { in: shipmentIds } },
            _count: { _all: true },
          }),
          prisma.outbound_boxes.groupBy({
            by: ["shipment_id"],
            where: {
              shipment_id: { in: shipmentIds },
              pallet_id: null,
              fba_shipping_label_file_id: null,
            },
            _count: { _all: true },
          }),
          prisma.sub_shipments.groupBy({
            by: ["parent_shipment_id"],
            where: { parent_shipment_id: { in: shipmentIds } },
            _count: { _all: true },
          }),
          prisma.staff_check_ins.groupBy({
            by: ["shipment_id"],
            where: { shipment_id: { in: shipmentIds }, checked_out_at: null },
            _count: { _all: true },
          }),
        ])
      : [[], [], [], [], [], []];

    const itemTotalsByShipment = mapById(itemTotals, "shipment_id");
    const discrepancyTotalsByShipment = mapById(discrepancyTotals, "shipment_id");
    const boxTotalsByShipment = mapById(boxTotals, "shipment_id");
    const missingLabelTotalsByShipment = mapById(missingLabelTotals, "shipment_id");
    const subShipmentTotalsByShipment = mapById(subShipmentTotals, "parent_shipment_id");
    const activeCheckInTotalsByShipment = mapById(activeCheckInTotals, "shipment_id");

    const summaries = rows.map((shipment) => {
      const itemStats = itemTotalsByShipment.get(shipment.id);
      const totalExpectedQty = Number(itemStats?._sum?.qty_expected ?? 0);
      const totalReceivedQty = Number(itemStats?._sum?.qty_received ?? 0);
      const totalDispatchQty = Number(itemStats?._sum?.dispatch_qty ?? 0);
      const lineItemCount = Number(itemStats?._count?._all ?? 0);
      const discrepancyCount = Number(discrepancyTotalsByShipment.get(shipment.id)?._count?._all ?? 0);
      const boxCount = Number(boxTotalsByShipment.get(shipment.id)?._count?._all ?? 0);
      const fbaLabelMissingCount = Number(missingLabelTotalsByShipment.get(shipment.id)?._count?._all ?? 0);
      const subShipmentCount = Number(subShipmentTotalsByShipment.get(shipment.id)?._count?._all ?? 0);
      const activeCheckInCount = Number(activeCheckInTotalsByShipment.get(shipment.id)?._count?._all ?? 0);
      const assignedUser = shipment.users_shipments_assigned_toTousers;
      const client = shipment.clients;

      return {
        id: shipment.id,
        reference: shipment.reference,
        status: shipment.status,
        clientId: shipment.client_id,
        client_id: shipment.client_id,
        clientName: client?.company_name ?? "",
        client_name: client?.company_name ?? "",
        client: client
          ? {
              id: client.id,
              companyName: client.company_name,
              company_name: client.company_name,
              email: client.email,
              status: client.status,
            }
          : null,
        clients: client,
        assignedTo: shipment.assigned_to,
        assigned_to: shipment.assigned_to,
        assignedUser,
        assigned_user: assignedUser,
        expectedArrivalDate: shipment.expected_arrival_date,
        expected_arrival_date: shipment.expected_arrival_date,
        actualArrivalDate: shipment.actual_arrival_date,
        actual_arrival_date: shipment.actual_arrival_date,
        estimatedDispatchDate: shipment.estimated_dispatch_date,
        estimated_dispatch_date: shipment.estimated_dispatch_date,
        dispatchedDate: shipment.dispatched_date,
        dispatched_date: shipment.dispatched_date,
        completedDate: shipment.completed_date,
        completed_date: shipment.completed_date,
        notes: shipment.client_notes,
        clientNotes: shipment.client_notes,
        client_notes: shipment.client_notes,
        submittedAt: shipment.submitted_at,
        submitted_at: shipment.submitted_at,
        draftSavedAt: shipment.draft_saved_at,
        draft_saved_at: shipment.draft_saved_at,
        createdAt: shipment.created_at,
        created_at: shipment.created_at,
        updatedAt: shipment.updated_at,
        updated_at: shipment.updated_at,
        lineItemCount,
        line_item_count: lineItemCount,
        totalExpectedQty,
        total_expected_qty: totalExpectedQty,
        totalReceivedQty,
        total_received_qty: totalReceivedQty,
        totalDispatchQty,
        total_dispatch_qty: totalDispatchQty,
        discrepancyCount,
        discrepancy_count: discrepancyCount,
        boxCount,
        box_count: boxCount,
        fbaLabelMissingCount,
        fba_label_missing_count: fbaLabelMissingCount,
        subShipmentCount,
        sub_shipment_count: subShipmentCount,
        activeCheckInCount,
        active_check_in_count: activeCheckInCount,
        units: totalExpectedQty,
      };
    });

    return success({ rows: summaries, total, page, limit, totalPages: Math.ceil(total / limit), view: "summary" });
  } catch (err) {
    return handleApiError(err);
  }
}
