import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { json } from "@/lib/validation";

const MAX_SHIPMENT_LOOKUPS = 100;

const batchShipmentServicesSchema = z.object({
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

  return batchShipmentServicesSchema.parse({ shipmentIds });
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function asObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function getBatchShipmentServices(req: Request, input: z.infer<typeof batchShipmentServicesSchema>) {
  const user = await requireUser(req);
  if (user.role === "client" && !user.clientId) {
    throw new ApiError("Client user has no clientId", 403);
  }

  const shipmentIds = uniqueValues(input.shipmentIds);
  if (!shipmentIds.length) {
    return success({
      shipments: [],
      tasks: [],
      tasksByShipmentId: {},
      groupedByShipmentId: {},
      totalShipments: 0,
      totalTasks: 0,
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
        select: {
          id: true,
          services_selected: true,
          service_status: true,
          products: {
            select: {
              id: true,
              sku: true,
              product_name: true,
              default_fnsku: true,
            },
          },
        },
      },
    },
  });

  if (shipments.length !== shipmentIds.length) {
    throw new ApiError("One or more shipments were not found", 404);
  }

  const requestedOrder = new Map(shipmentIds.map((shipmentId, index) => [shipmentId, index]));
  const orderedShipments = [...shipments].sort(
    (left, right) => (requestedOrder.get(left.id) ?? 0) - (requestedOrder.get(right.id) ?? 0),
  );

  const shipmentRows = orderedShipments.map((shipment) => {
    const tasks = shipment.shipment_line_items.flatMap((item) => {
      const selected = asStringArray(item.services_selected);
      const statuses = asObject(item.service_status);

      return selected.map((service) => {
        const status = String(statuses[service] ?? "PENDING");
        const unitsDone = Number(statuses[`${service}:unitsDone`] ?? 0);

        return {
          id: `${item.id}:${service}`,
          taskId: `${item.id}:${service}`,
          task_id: `${item.id}:${service}`,
          shipmentId: shipment.id,
          shipment_id: shipment.id,
          shipmentReference: shipment.reference,
          shipment_reference: shipment.reference,
          shipmentItemId: item.id,
          shipment_item_id: item.id,
          lineItemId: item.id,
          line_item_id: item.id,
          serviceType: service,
          service_type: service,
          status,
          unitsDone,
          units_done: unitsDone,
          product: item.products,
          products: item.products,
          productSku: item.products.sku,
          product_sku: item.products.sku,
          productName: item.products.product_name,
          product_name: item.products.product_name,
        };
      });
    });

    const grouped = tasks.reduce<Record<string, typeof tasks>>((acc, task) => {
      acc[task.serviceType] ??= [];
      acc[task.serviceType].push(task);
      return acc;
    }, {});

    return {
      shipmentId: shipment.id,
      shipment_id: shipment.id,
      reference: shipment.reference,
      tasks,
      serviceTasks: tasks,
      service_tasks: tasks,
      grouped,
    };
  });

  const tasksByShipmentId = Object.fromEntries(
    shipmentRows.map((shipment) => [shipment.shipmentId, shipment.tasks]),
  );
  const groupedByShipmentId = Object.fromEntries(
    shipmentRows.map((shipment) => [shipment.shipmentId, shipment.grouped]),
  );
  const tasks = shipmentRows.flatMap((shipment) => shipment.tasks);

  return success({
    shipments: shipmentRows,
    tasks,
    serviceTasks: tasks,
    service_tasks: tasks,
    tasksByShipmentId,
    groupedByShipmentId,
    totalShipments: shipmentRows.length,
    totalTasks: tasks.length,
  });
}

export async function GET(req: Request) {
  try {
    return await getBatchShipmentServices(req, parseGetRequest(req));
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    return await getBatchShipmentServices(req, await json(req, batchShipmentServicesSchema));
  } catch (err) {
    return handleApiError(err);
  }
}
