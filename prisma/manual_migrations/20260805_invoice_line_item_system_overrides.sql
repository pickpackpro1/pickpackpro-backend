alter table public.invoice_line_items
add column if not exists source_key text,
add column if not exists metadata jsonb not null default '{}'::jsonb,
add column if not exists is_overridden boolean not null default false,
add column if not exists is_suppressed boolean not null default false;

create index if not exists idx_invoice_line_items_invoice_source_key
on public.invoice_line_items(invoice_id, source_key);

create index if not exists idx_invoice_line_items_overrides
on public.invoice_line_items(invoice_id, is_overridden, is_suppressed);
