alter table public.shipment_line_items
add column if not exists product_name text null;
