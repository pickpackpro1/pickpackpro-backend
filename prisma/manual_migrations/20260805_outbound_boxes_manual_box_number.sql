alter table public.outbound_boxes
add column if not exists manual_box_number text null;

create unique index if not exists outbound_boxes_manual_box_number_scope_key
on public.outbound_boxes (
  shipment_id,
  coalesce(sub_shipment_id, '00000000-0000-0000-0000-000000000000'::uuid),
  lower(btrim(manual_box_number))
)
where box_type = 'box'
  and manual_box_number is not null
  and btrim(manual_box_number) <> '';
