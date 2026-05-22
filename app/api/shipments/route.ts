import { ShipmentStatus } from "@prisma/client";
import { z } from "zod";
import { handleApiError, success } from "@/lib/apiResponse";
import { requireClientAccess, requireUser } from "@/lib/auth";
import { calculateDispatchQty } from "@/lib/businessLogic";
import { sendEmail } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { generateShipmentRef } from "@/lib/referenceGen";
import { json } from "@/lib/validation";

const itemSchema = z.object({
  sku: z.string().min(1),
  productName: z.string().min(1),
  expectedQty: z.number().int().positive(),
  bundleSize: z.number().int().positive().default(1),
  fnskuLabel: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  services: z.array(z.string()).default(["FNSKU_LABEL", "POLY_BAG", "BUBBLE_WRAP", "BUNDLING"]),
});

const createSchema = z.object({
  clientId: z.string().uuid(),
  notes: z.string().optional().nullable(),
  expectedArrivalDate: z.coerce.date().optional(),
  isDraft: z.boolean().default(false),
  items: z.array(itemSchema).min(1),
});

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const url = new URL(req.url);
    const page = Number(url.searchParams.get("page") ?? 1);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 100);
    const status = url.searchParams.get("status")?.toLowerCase() as ShipmentStatus | undefined;
    const clientId = url.searchParams.get("clientId") ?? undefined;
    const search = url.searchParams.get("search") ?? undefined;
    const where = {
      soft_deleted_at: null,
      status,
      client_id: user.role === "client" ? user.clientId! : clientId,
      shipment_line_items: search
        ? { some: { products: { sku: { contains: search, mode: "insensitive" as const } } } }
        : undefined,
    };
    const [rows, total] = await Promise.all([
      prisma.shipments.findMany({
        where,
        select: {
          id: true,
          reference: true,
          status: true,
          expected_arrival_date: true,
          actual_arrival_date: true,
          dispatched_date: true,
          completed_date: true,
          client_notes: true,
          assigned_to: true,
          submitted_at: true,
          created_at: true,
          updated_at: true,
          clients: {
            select: { id: true, company_name: true, email: true },
          },
          shipment_line_items: {
            select: {
              id: true,
              qty_expected: true,
              qty_received: true,
              service_status: true,
              services_selected: true,
              fnsku: true,
              qty_discrepancy_flag: true,
              products: {
                select: { id: true, sku: true, product_name: true },
              },
            },
          },
          outbound_boxes: {
            select: { id: true, box_type: true, box_size: true, dispatched_at: true },
          },
        },
        orderBy: { created_at: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.shipments.count({ where }),
    ]);
    return success({ rows, total, page, limit });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    const body = await json(req, createSchema);
    const user = await requireClientAccess(req, body.clientId);
    const shipment = await prisma.$transaction(async (tx) => {
      const reference = await generateShipmentRef(tx as typeof prisma);
      return tx.shipments.create({
        data: {
          client_id: body.clientId,
          reference,
          status: body.isDraft ? "draft" : "pending_arrival",
          expected_arrival_date: body.expectedArrivalDate ?? new Date(),
          client_notes: body.notes ?? null,
          submitted_at: body.isDraft ? null : new Date(),
          submitted_by: body.isDraft ? null : user.userId,
          shipment_line_items: {
            create: body.items.map((item) => ({
              fnsku: item.fnskuLabel ?? item.sku,
              qty_expected: item.expectedQty,
              dispatch_qty: null,
              services_selected: item.services,
              service_status: Object.fromEntries(item.services.map((service) => [service, "PENDING"])),
              discrepancy_notes: item.notes ?? null,
              products: {
                connectOrCreate: {
                  where: { client_id_sku: { client_id: body.clientId, sku: item.sku } },
                  create: {
                    client_id: body.clientId,
                    sku: item.sku,
                    product_name: item.productName,
                    default_fnsku: item.fnskuLabel ?? null,
                    length_cm: 0,
                    width_cm: 0,
                    height_cm: 0,
                    weight_kg: 0,
                    needs_bundling: item.bundleSize > 1,
                    bundle_size: item.bundleSize,
                  },
                },
              },
            })),
          },
        },
        include: { shipment_line_items: { include: { products: true } } },
      });
    });
    await prisma.audit_logs.create({
      data: {
        user_id: user.userId,
        user_email: user.email,
        user_role: user.role,
        action: "shipment.created",
        entity_type: "shipment",
        entity_id: shipment.id,
        after_value: JSON.parse(JSON.stringify(shipment)),
      },
    });
    const admins = await prisma.users.findMany({ where: { role: "admin", active: true } });
    await prisma.notifications.createMany({
      data: admins.map((admin) => ({
        user_id: admin.id,
        type: "shipment_submitted",
        title: "New Shipment Submitted",
        body: `New shipment ${shipment.reference} submitted by client.`,
        link_url: `/shipments/${shipment.id}`,
      })),
    });
    try {
      const adminEmails = admins.map((admin) => admin.email);
      await sendEmail({
        to: adminEmails,
        subject: `New Shipment Submitted — ${shipment.reference}`,
        html: `<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6f9;padding:40px 0;font-family:Arial,sans-serif;">
  <tr>
    <td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr>
          <td style="background-color:#132347;padding:28px 40px;">
            <div style="color:#ffffff;font-size:20px;font-weight:bold;">📦 PickPackPro</div>
            <div style="color:#8899bb;font-size:12px;margin-top:4px;">Warehouse Management System</div>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 40px 4px 40px;">
            <div style="background-color:#FF6B2C;height:4px;border-radius:2px;"></div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px;">
            <h2 style="color:#132347;font-size:20px;font-weight:bold;margin:0 0 8px 0;">New Shipment Submitted</h2>
            <p style="color:#FF6B2C;font-size:14px;font-weight:bold;margin:0 0 24px 0;">Action Required</p>
            <p style="color:#555555;font-size:15px;line-height:1.6;margin:0 0 16px 0;">
              A new shipment has been submitted and is awaiting warehouse processing.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border-radius:6px;border:1px solid #e8ecf0;margin:0 0 28px 0;">
              <tr>
                <td style="padding:16px 20px;">
                  <div style="color:#888888;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Shipment Reference</div>
                  <div style="color:#132347;font-size:18px;font-weight:bold;">${shipment.reference}</div>
                </td>
              </tr>
            </table>
            <table cellpadding="0" cellspacing="0">
              <tr>
                <td style="background-color:#FF6B2C;border-radius:6px;padding:12px 24px;">
                  <a href="${process.env.FRONTEND_URL}/shipments" style="color:#ffffff;font-size:14px;font-weight:bold;text-decoration:none;">View Shipment →</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="background-color:#f4f6f9;padding:20px 40px;border-top:1px solid #e8ecf0;text-align:center;">
            <p style="color:#aaaaaa;font-size:12px;margin:0;">© 2026 Pick Pack Pro · pickpackpro.co.uk</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`,
      });
    } catch (emailErr) {
      console.error("[email] Failed to send shipment submitted email:", emailErr);
    }
    return success(shipment, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
