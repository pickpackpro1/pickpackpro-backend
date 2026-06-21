import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

function normalizeHeader(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const headerAliases: Record<string, string[]> = {
  product_name: ["product_name", "product", "productname", "product_title", "name"],
  sku: ["sku", "seller_sku", "product_sku"],
  default_fnsku: ["default_fnsku", "fnsku", "default_fnsku", "fnsku_label", "fnsku_code"],
  length_cm: ["length_cm", "length", "l", "length_cms"],
  width_cm: ["width_cm", "width", "w", "width_cms"],
  height_cm: ["height_cm", "height", "h", "height_cms"],
  weight_kg: ["weight_kg", "weight", "kg", "weight_kgs"],
  hazmat_flag: ["hazmat_flag", "hazmat", "is_hazmat"],
  expiry_tracked: ["expiry_tracked", "expiry", "expiry_tracking"],
  lot_tracked: ["lot_tracked", "lot", "lot_tracking"],
  needs_bundling: ["needs_bundling", "bundling", "needs_bundle", "bundle_required"],
  bundle_size: ["bundle_size", "bundle_qty", "bundle_quantity"],
  active: ["active", "is_active"],
  status: ["status"],
};

function buildHeaderIndex(headers: string[]) {
  const normalizedHeaders = headers.map(normalizeHeader);
  const byCanonical = new Map<string, number>();

  for (const [canonical, aliases] of Object.entries(headerAliases)) {
    const aliasSet = new Set(aliases.map(normalizeHeader));
    const index = normalizedHeaders.findIndex((header) => aliasSet.has(header));
    if (index >= 0) byCanonical.set(canonical, index);
  }

  return (row: string[], name: string) => {
    const position = byCanonical.get(name);
    return position === undefined ? undefined : row[position]?.trim();
  };
}

function bool(value: string | undefined, fallback = false) {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["true", "1", "yes", "y", "active"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "inactive", "disabled"].includes(normalized)) return false;
  throw new Error(`${value} is not a valid boolean value`);
}

function number(value: string | undefined, field: string) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${field} must be a nonnegative number`);
  return parsed;
}

function activeValue(active: string | undefined, status: string | undefined) {
  if (status?.trim()) return bool(status, true);
  return bool(active, true);
}

function intOrNull(value: string | undefined, field: string) {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${field} must be a positive integer`);
  return parsed;
}

export async function POST(req: Request) {
  try {
    const user = await requireRole(req, ["admin", "client"]);
    const form = await req.formData();
    const file = form.get("file");
    const rawClientId = form.get("clientId");
    const clientId = user.role === "client" ? user.clientId : typeof rawClientId === "string" ? rawClientId : null;
    if (!clientId) throw new ApiError("clientId is required", 400);
    if (!(file instanceof File)) throw new ApiError("CSV file is required", 400);

    const client = await prisma.clients.findFirst({
      where: { id: clientId, soft_deleted_at: null },
      select: { id: true },
    });
    if (!client) throw new ApiError("Client not found", 404);

    const rows = parseCsv(await file.text());
    const headers = rows.shift()?.map((header) => header.trim().toLowerCase()) ?? [];
    if (headers.length === 0) throw new ApiError("CSV header row is required", 400);
    const value = buildHeaderIndex(headers);

    let imported = 0;
    let updated = 0;
    const errors: Array<{ row: number; message: string }> = [];
    const candidates: Array<{
      rowNumber: number;
      productName: string;
      sku: string;
      defaultFnsku: string | null;
      lengthCm: number;
      widthCm: number;
      heightCm: number;
      weightKg: number;
      hazmatFlag: boolean;
      expiryTracked: boolean;
      lotTracked: boolean;
      needsBundling: boolean;
      bundleSize: number | null;
      active: boolean;
    }> = [];

    for (const [offset, row] of rows.entries()) {
      const rowNumber = offset + 2;
      try {
        const productName = value(row, "product_name");
        const sku = value(row, "sku");
        if (!productName || !sku) {
          errors.push({ row: rowNumber, message: "product_name and sku are required" });
          continue;
        }

        const needsBundling = bool(value(row, "needs_bundling"));
        const bundleSize = intOrNull(value(row, "bundle_size"), "bundle_size");
        if (needsBundling && !bundleSize) throw new Error("bundle_size is required when needs_bundling is true");

        candidates.push({
          rowNumber,
          productName,
          sku,
          defaultFnsku: value(row, "default_fnsku") || null,
          lengthCm: number(value(row, "length_cm"), "length_cm"),
          widthCm: number(value(row, "width_cm"), "width_cm"),
          heightCm: number(value(row, "height_cm"), "height_cm"),
          weightKg: number(value(row, "weight_kg"), "weight_kg"),
          hazmatFlag: bool(value(row, "hazmat_flag")),
          expiryTracked: bool(value(row, "expiry_tracked")),
          lotTracked: bool(value(row, "lot_tracked")),
          needsBundling,
          bundleSize,
          active: activeValue(value(row, "active"), value(row, "status")),
        });
      } catch (err) {
        errors.push({ row: rowNumber, message: err instanceof Error ? err.message : "Invalid row" });
      }
    }

    const candidateSkus = [...new Set(candidates.map((row) => row.sku))];
    const existingSkus = new Set(
      candidateSkus.length
        ? (
            await prisma.products.findMany({
              where: { client_id: clientId, sku: { in: candidateSkus } },
              select: { sku: true },
            })
          ).map((product) => product.sku)
        : [],
    );

    for (const row of candidates) {
      try {
        const existing = existingSkus.has(row.sku);
        await prisma.products.upsert({
          where: { client_id_sku: { client_id: clientId, sku: row.sku } },
          update: {
            product_name: row.productName,
            default_fnsku: row.defaultFnsku,
            length_cm: row.lengthCm,
            width_cm: row.widthCm,
            height_cm: row.heightCm,
            weight_kg: row.weightKg,
            hazmat_flag: row.hazmatFlag,
            expiry_tracked: row.expiryTracked,
            lot_tracked: row.lotTracked,
            needs_bundling: row.needsBundling,
            bundle_size: row.bundleSize,
            active: row.active,
            soft_deleted_at: null,
          },
          create: {
            client_id: clientId,
            product_name: row.productName,
            sku: row.sku,
            default_fnsku: row.defaultFnsku,
            length_cm: row.lengthCm,
            width_cm: row.widthCm,
            height_cm: row.heightCm,
            weight_kg: row.weightKg,
            hazmat_flag: row.hazmatFlag,
            expiry_tracked: row.expiryTracked,
            lot_tracked: row.lotTracked,
            needs_bundling: row.needsBundling,
            bundle_size: row.bundleSize,
            active: row.active,
          },
        });

        if (existing) updated += 1;
        else {
          imported += 1;
          existingSkus.add(row.sku);
        }
      } catch (err) {
        errors.push({ row: row.rowNumber, message: err instanceof Error ? err.message : "Invalid row" });
      }
    }

    await prisma.audit_logs.create({
      data: {
        user_id: user.userId,
        user_role: user.role,
        user_email: user.email,
        action: "product.import",
        entity_type: "client",
        entity_id: clientId,
        after_value: { imported, updated, errors: errors.length },
      },
    });

    return success({
      message: "Product import completed",
      imported,
      updated,
      created: imported,
      errors,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
