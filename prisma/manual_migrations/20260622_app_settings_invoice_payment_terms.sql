alter table public.app_settings
add column if not exists invoice_payment_terms_days integer not null default 14;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'app_settings_invoice_payment_terms_days_check'
      and conrelid = 'public.app_settings'::regclass
  ) then
    alter table public.app_settings
    add constraint app_settings_invoice_payment_terms_days_check
    check (invoice_payment_terms_days >= 1);
  end if;
end $$;
