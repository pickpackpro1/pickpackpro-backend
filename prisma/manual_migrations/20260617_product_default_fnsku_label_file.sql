alter table products
add column if not exists default_fnsku_label_file_id uuid null;

create index if not exists idx_products_default_fnsku_label_file
on products(default_fnsku_label_file_id);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'products_default_fnsku_label_file_fkey'
  ) then
    alter table products
    add constraint products_default_fnsku_label_file_fkey
    foreign key (default_fnsku_label_file_id)
    references uploaded_files(id)
    on delete set null
    on update no action;
  end if;
end $$;

with latest_product_labels as (
  select distinct on (linked_entity_id)
    linked_entity_id as product_id,
    id as file_id
  from uploaded_files
  where file_type = 'fnsku_label'
    and linked_entity_type = 'product'
    and linked_entity_id is not null
  order by linked_entity_id, uploaded_at desc
)
update products
set default_fnsku_label_file_id = latest_product_labels.file_id
from latest_product_labels
where products.id = latest_product_labels.product_id
  and products.default_fnsku_label_file_id is null;
