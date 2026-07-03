-- Widen manual shipping-paid mark RPCs: owner-only → any staff role.
--
-- set_shipping_paid_mark + clear_shipping_paid_mark were gated to
-- Martin (public.is_owner()) when they were first added — a deliberate
-- "belt and braces" while the flow was new. Now that support / team
-- staff are the ones chasing shipping edge cases day-to-day, widening
-- to any staff role. manual_shipping_marks.marked_by still records
-- auth.uid() so accountability is preserved.
--
-- Belt: the frontend gate in components/CustomerCampaigns.tsx is
-- updated to the same three roles. Braces: this migration enforces
-- the same guard at the DB, so a UI regression alone can't widen
-- access.

create or replace function public.set_shipping_paid_mark(
  p_shopify_order_id text,
  p_note             text default null
)
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'aa_01_campaigns'
as $$
begin
  if auth.uid() is null then
    raise exception 'forbidden: not signed in' using errcode = '42501';
  end if;
  if public.current_app_role() not in ('admin','team','support') then
    raise exception 'forbidden: staff only' using errcode = '42501';
  end if;

  insert into aa_01_campaigns.manual_shipping_marks
    (shopify_order_id, order_number, email, campaign_id, note, marked_by, marked_at)
  values (
    p_shopify_order_id,
    (select ro.shopify_order_number from aa_01_campaigns.raw_orders ro where ro.shopify_order_id = p_shopify_order_id limit 1),
    (select lower(ro.email)          from aa_01_campaigns.raw_orders ro where ro.shopify_order_id = p_shopify_order_id limit 1),
    (select ro.campaign_id           from aa_01_campaigns.raw_orders ro where ro.shopify_order_id = p_shopify_order_id limit 1),
    p_note, auth.uid(), now()
  )
  on conflict (shopify_order_id) do update
    set note         = excluded.note,
        marked_by    = excluded.marked_by,
        marked_at    = excluded.marked_at,
        order_number = excluded.order_number,
        email        = excluded.email,
        campaign_id  = excluded.campaign_id;
end;
$$;

create or replace function public.clear_shipping_paid_mark(
  p_shopify_order_id text
)
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'aa_01_campaigns'
as $$
begin
  if auth.uid() is null then
    raise exception 'forbidden: not signed in' using errcode = '42501';
  end if;
  if public.current_app_role() not in ('admin','team','support') then
    raise exception 'forbidden: staff only' using errcode = '42501';
  end if;
  delete from aa_01_campaigns.manual_shipping_marks where shopify_order_id = p_shopify_order_id;
end;
$$;
