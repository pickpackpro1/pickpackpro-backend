import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const MAX_SHIPMENT_LOOKUPS = 100;

const batchShipmentDiscrepanciesSchema = z.object({
  shipmentIds: z.array(z.string().uuid()).max(MAX_SHIPMENT_LOOKUPS).default([]),
});

function uniqueValues(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function parseGetRequest(req: Request) {
  const url = new URL(req.url);
  const shipmentIds = uniqueValues([
    ...url.searchParams.getAll("shipmentId"),
    ...url.searchParams.getAll("shipmentIds").flatMap((value) => value.split(",")),
  ]);

  return batchShipmentDiscrepanciesSchema.parse({ shipmentIds });
}

async function getBatchShipmentDiscrepancies(
  req: Request,
  input: z.infer<typeof batchShipmentDiscrepanciesSchema>,
) {
  const user = await requireUser(req);
  if (user.role === "client" && !user.clientId) {
    throw new ApiError("Client user has no clientId", 403);
  }

  const shipmentIds = uniqueValues(input.shipmentIds);
  if (!shipmentIds.length) {
    return success({
      shipments: [],
      discrepancies: [],
      discrepanciesByShipmentId: {},
      totalShipments: 0,
      totalDiscrepancies: 0,
    });
  }

  const shipments = await prisma.shipments.findMany({
    where: {
      id: { in: shipmentIds },
      ...(user.role === "client" ? { client_id: user.clientId! } : {}),
      soft_deleted_at: null,
    },
    select: {
      id: true,
      reference: true,
      client_id: true,
      shipment_line_items: {
        where: { qty_discrepancy_flag: true },
        select: {
          id: true,
          shipment_id: true,
          product_id: true,
          product_name: true,
          fnsku: true,
          qty_expected: true,
          qty_received: true,
          dispatch_qty: true,
          needs_bundling: true,
          bundle_size: true,
          display_order: true,
          qty_discrepancy_flag: true,
          discrepancy_notes: true,
          expiry_date: true,
          lot_number: true,
          created_at: true,
          updated_at: true,
          products: {
            select: {
              id: true,
              sku: true,
              product_name: true,
              default_fnsku: true,
              needs_bundling: true,
              bundle_size: true,
            },
          },
        },
        orderBy: { created_at: "asc" },
      },
    },
  });

  if (shipments.length !== shipmentIds.length) {
    throw new ApiError("One or more shipments were not found", 404);
  }

  const requestedOrder = new Map(shipmentIds.map((shipmentId, index) => [shipmentId, index]));
  const shipmentRows = [...shipments]
    .sort((left, right) => (requestedOrder.get(left.id) ?? 0) - (requestedOrder.get(right.id) ?? 0))
    .map((shipment) => {
      const discrepancies = shipment.shipment_line_items.map((item) => {
        const expectedQty = Number(item.qty_expected ?? 0);
        const receivedQty = Number(item.qty_received ?? 0);
        const differenceQty = receivedQty - expectedQty;
        const productName = item.product_name ?? item.products.product_name;

        return {
          ...item,
          shipmentId: shipment.id,
          shipment_id: shipment.id,
          shipmentReference: shipment.reference,
          shipment_reference: shipment.reference,
          lineItemId: item.id,
          line_item_id: item.id,
          shipmentItemId: item.id,
          shipment_item_id: item.id,
          product: item.products,
          products: item.products,
          sku: item.products.sku,
          productSku: item.products.sku,
          product_sku: item.products.sku,
          productName,
          product_name: productName,
          fnskuLabel: item.fnsku,
          fnsku_label: item.fnsku,
          expectedQty,
          expected_qty: expectedQty,
          qtyExpected: expectedQty,
          qty_expected: item.qty_expected,
          receivedQty,
          received_qty: receivedQty,
          qtyReceived: receivedQty,
          qty_received: item.qty_received,
          dispatchQty: item.dispatch_qty,
          dispatch_qty: item.dispatch_qty,
          discrepancyFlag: item.qty_discrepancy_flag,
          discrepancy_flag: item.qty_discrepancy_flag,
          qtyDiscrepancyFlag: item.qty_discrepancy_flag,
          qty_discrepancy_flag: item.qty_discrepancy_flag,
          discrepancyNotes: item.discrepancy_notes,
          discrepancy_notes: item.discrepancy_notes,
          differenceQty,
          difference_qty: differenceQty,
          quantityDifference: differenceQty,
          quantity_difference: differenceQty,
          status: "OPEN",
        };
      });

      return {
        shipmentId: shipment.id,
        shipment_id: shipment.id,
        reference: shipment.reference,
        discrepancies,
        discrepancyCount: discrepancies.length,
        discrepancy_count: discrepancies.length,
      };
    });

  const discrepanciesByShipmentId = Object.fromEntries(
    shipmentRows.map((shipment) => [shipment.shipmentId, shipment.discrepancies]),
  );
  const discrepancies = shipmentRows.flatMap((shipment) => shipment.discrepancies);

  return success({
    shipments: shipmentRows,
    discrepancies,
    discrepanciesByShipmentId,
    totalShipments: shipmentRows.length,
    totalDiscrepancies: discrepancies.length,
  });
}

export async function GET(req: Request) {
  try {
    return await getBatchShipmentDiscrepancies(req, parseGetRequest(req));
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    return await getBatchShipmentDiscrepancies(req, await json(req, batchShipmentDiscrepanciesSchema));
  } catch (err) {
    return handleApiError(err);
  }
}
