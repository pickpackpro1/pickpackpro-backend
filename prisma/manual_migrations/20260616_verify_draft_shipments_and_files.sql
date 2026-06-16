do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'shipments'
      and column_name = 'draft_payload'
      and data_type = 'jsonb'
  ) then
    raise exception 'Missing public.shipments.draft_payload jsonb';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'shipments'
      and column_name = 'draft_saved_at'
      and data_type = 'timestamp with time zone'
  ) then
    raise exception 'Missing public.shipments.draft_saved_at timestamptz';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'uploaded_files'
      and column_name = 'metadata'
      and data_type = 'jsonb'
  ) then
    raise exception 'Missing public.uploaded_files.metadata jsonb';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'uploaded_files'
      and indexname = 'idx_uploaded_files_linked_entity'
  ) then
    raise exception 'Missing idx_uploaded_files_linked_entity';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'shipments'
      and indexname = 'idx_shipments_draft_saved_at'
  ) then
    raise exception 'Missing idx_shipments_draft_saved_at';
  end if;
end $$;
