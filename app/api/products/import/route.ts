import { z } from "zod";
import { ApiError, handleApiError, success } from "@/lib/apiResponse";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const clientSchema = z.string().uuid();

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

function bool(value: string | undefined) {
  return ["true", "1", "yes", "y"].includes((value ?? "").trim().toLowerCase());
}

function number(value: string | undefined, field: string) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${field} must be a nonnegative number`);
  return parsed;
}

function intOrNull(value: string | undefined, field: string) {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${field} must be a positive integer`);
  return parsed;
}

export async function POST(req: Request) {
  try {
    await requireRole(req, ["admin"]);
    const form = await req.formData();
    const file = form.get("file");
    const clientId = clientSchema.parse(form.get("clientId"));
    if (!(file instanceof File)) throw new ApiError("CSV file is required", 400);

    const rows = parseCsv(await file.text());
    const headers = rows.shift()?.map((header) => header.trim().toLowerCase()) ?? [];
    const index = (name: string) => headers.indexOf(name);
    const value = (row: string[], name: string) => {
      const position = index(name);
      return position >= 0 ? row[position]?.trim() : undefined;
    };

    let imported = 0;
    let updated = 0;
    const errors: Array<{ row: number; message: string }> = [];

    for (const [offset, row] of rows.entries()) {
      const rowNumber = offset + 2;
      try {
        const productName = value(row, "product_name");
        const sku = value(row, "sku");
        if (!productName || !sku) {
          errors.push({ row: rowNumber, message: "product_name and sku are required" });
          continue;
        }

        const existing = await prisma.products.findUnique({
          where: { client_id_sku: { client_id: clientId, sku } },
          select: { id: true },
        });
        const needsBundling = bool(value(row, "needs_bundling"));
        const bundleSize = intOrNull(value(row, "bundle_size"), "bundle_size");
        if (needsBundling && !bundleSize) throw new Error("bundle_size is required when needs_bundling is true");

        await prisma.products.upsert({
          where: { client_id_sku: { client_id: clientId, sku } },
          update: {
            product_name: productName,
            default_fnsku: value(row, "default_fnsku") || null,
            length_cm: number(value(row, "length_cm"), "length_cm"),
            width_cm: number(value(row, "width_cm"), "width_cm"),
            height_cm: number(value(row, "height_cm"), "height_cm"),
            weight_kg: number(value(row, "weight_kg"), "weight_kg"),
            hazmat_flag: bool(value(row, "hazmat_flag")),
            expiry_tracked: bool(value(row, "expiry_tracked")),
            lot_tracked: bool(value(row, "lot_tracked")),
            needs_bundling: needsBundling,
            bundle_size: bundleSize,
            active: true,
            soft_deleted_at: null,
          },
          create: {
            client_id: clientId,
            product_name: productName,
            sku,
            default_fnsku: value(row, "default_fnsku") || null,
            length_cm: number(value(row, "length_cm"), "length_cm"),
            width_cm: number(value(row, "width_cm"), "width_cm"),
            height_cm: number(value(row, "height_cm"), "height_cm"),
            weight_kg: number(value(row, "weight_kg"), "weight_kg"),
            hazmat_flag: bool(value(row, "hazmat_flag")),
            expiry_tracked: bool(value(row, "expiry_tracked")),
            lot_tracked: bool(value(row, "lot_tracked")),
            needs_bundling: needsBundling,
            bundle_size: bundleSize,
          },
        });

        if (existing) updated += 1;
        else imported += 1;
      } catch (err) {
        errors.push({ row: rowNumber, message: err instanceof Error ? err.message : "Invalid row" });
      }
    }

    return success({ imported, updated, errors });
  } catch (err) {
    return handleApiError(err);
  }
}
