-- Draft shipment persistence and staged draft FNSKU label files.
-- Safe to run multiple times.

alter table public.shipments
  add column if not exists draft_payload jsonb,
  add column if not exists draft_saved_at timestamptz;

alter table public.uploaded_files
  add column if not exists metadata jsonb;

create index if not exists idx_uploaded_files_linked_entity
  on public.uploaded_files (linked_entity_type, linked_entity_id);

create index if not exists idx_shipments_draft_saved_at
  on public.shipments (draft_saved_at)
  where draft_saved_at is not null;
