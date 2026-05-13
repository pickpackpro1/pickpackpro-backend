import { ApiError, handleApiError } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const columns = [
  "product_name",
  "sku",
  "default_fnsku",
  "length_cm",
  "width_cm",
  "height_cm",
  "weight_kg",
  "hazmat_flag",
  "expiry_tracked",
  "lot_tracked",
  "needs_bundling",
  "bundle_size",
  "active",
];

function csv(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function GET(req: Request) {
  try {
    await requireRole(req, ["admin"]);
    const url = new URL(req.url);
    const clientId = url.searchParams.get("clientId");
    if (!clientId) throw new ApiError("clientId is required", 400);

    const products = await prisma.products.findMany({
      where: { client_id: clientId, soft_deleted_at: null },
      orderBy: { created_at: "desc" },
    });

    const lines = [
      columns.join(","),
      ...products.map((product) =>
        [
          product.product_name,
          product.sku,
          product.default_fnsku,
          product.length_cm,
          product.width_cm,
          product.height_cm,
          product.weight_kg,
          product.hazmat_flag,
          product.expiry_tracked,
          product.lot_tracked,
          product.needs_bundling,
          product.bundle_size,
          product.active,
        ]
          .map(csv)
          .join(","),
      ),
    ];

    return new Response(lines.join("\n"), {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="products-${clientId}.csv"`,
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
