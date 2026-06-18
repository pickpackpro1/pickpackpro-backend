-- Add a saved display label for pallet rows.
-- This does not replace numeric box_number; it is only a stable manual label such as "Pallet A".

alter table public.outbound_boxes
add column if not exists pallet_number text null;

-- Manual pallet labels should be unique within the same parent shipment/sub-shipment scope,
-- but not globally. Parent-shipment pallets use a sentinel UUID for the null sub_shipment_id
-- so duplicate parent labels are also rejected.
create unique index if not exists outbound_boxes_pallet_number_scope_key
on public.outbound_boxes (
  shipment_id,
  coalesce(sub_shipment_id, '00000000-0000-0000-0000-000000000000'::uuid),
  lower(btrim(pallet_number))
)
where box_type = 'pallet'
  and pallet_number is not null
  and btrim(pallet_number) <> '';
