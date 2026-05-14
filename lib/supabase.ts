import { createClient } from "@supabase/supabase-js";

const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.PUBLIC_SUPABASE_URL;
const anonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) throw new Error("Missing Supabase URL");
if (!anonKey) throw new Error("Missing Supabase anon key");
if (!serviceRoleKey) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");

export const supabaseAnon = createClient(supabaseUrl, anonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export function bucketFor(fileType?: string): string {
  if (fileType === "fnsku_label" && process.env.SUPABASE_BUCKET_FNSKU_LABELS) return process.env.SUPABASE_BUCKET_FNSKU_LABELS;
  if (fileType === "fba_shipping_label" && process.env.SUPABASE_BUCKET_FBA_LABELS) return process.env.SUPABASE_BUCKET_FBA_LABELS;
  if (fileType === "invoice_pdf" || fileType === "invoice_xlsx") {
    if (process.env.SUPABASE_BUCKET_INVOICES) return process.env.SUPABASE_BUCKET_INVOICES;
  }
  if (fileType === "product_image" && process.env.SUPABASE_BUCKET_PRODUCT_IMAGES) return process.env.SUPABASE_BUCKET_PRODUCT_IMAGES;
  return (
    process.env.SUPABASE_STORAGE_BUCKET ??
    process.env.SUPABASE_BUCKET_FNSKU_LABELS ??
    "pickpackpro-files"
  );
}
