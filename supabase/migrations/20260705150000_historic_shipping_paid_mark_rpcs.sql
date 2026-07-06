-- Historic-order "Mark shipping paid" RPCs.
--
-- The manual mark existed only for live Shopify orders (raw_orders +
-- manual_shipping_marks). Historic orders (shopify_legacy / kickstarter
-- / indiegogo / wix / historic-gumroad / etc.) had no equivalent — the
-- button was hidden and the write path errored. This blocked SlasherTrash
-- (all historic) from being marked once we flipped the campaign-level
-- historic_dispatched flag off.
--
-- The reader side already supports it: get_customer_campaign_orders'
-- historic branch consults historic_line_dispatch_overrides FIRST and
-- overrides the campaign-level flag. So all we need is a per-order
-- write path that inserts an override for each line of the order.
--
-- Both RPCs take (source_order_id, campaign_id). The tuple resolves to
-- a single historic_orders row via its source_platform-scoped join +
-- the campaign_id anchoring on the lines table. Idempotent via
-- ON CONFLICT DO UPDATE — re-marking with a fresh note just refreshes
-- the audit stamp.
--
-- Same staff gate as the Shopify variant: admin / team / support.

create or replace function public.set_historic_shipping_paid_mark(
  p_source_order_id text,
  p_campaign_id     integer,
  p_note            text default null
)
returns integer
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'aa_01_campaigns'
as $$
declare
  v_uid uuid := auth.uid();
  v_n   integer;
begin
  if v_uid is null then
    raise exception 'forbidden: not signed in' using errcode = '42501';
  end if;
  if public.current_app_role() not in ('admin','team','support') then
    raise exception 'forbidden: staff only' using errcode = '42501';
  end if;

  insert into aa_01_campaigns.historic_line_dispatch_overrides
    (historic_order_line_id, delivery_status, note, marked_by, marked_at)
  select hol.id, 'shipping_paid', p_note, v_uid, now()
    from aa_01_campaigns.historic_orders ho
    join aa_01_campaigns.historic_order_lines hol on hol.historic_order_id = ho.id
   where ho.source_order_id = p_source_order_id
     and hol.campaign_id    = p_campaign_id
  on conflict (historic_order_line_id) do update
    set delivery_status = excluded.delivery_status,
        note            = excluded.note,
        marked_by       = excluded.marked_by,
        marked_at       = excluded.marked_at;
  get diagnostics v_n = row_count;

  if v_n = 0 then
    raise exception 'no historic lines matched (source_order_id=%, campaign_id=%)',
      p_source_order_id, p_campaign_id
      using errcode = '22023';
  end if;

  return v_n;
end;
$$;

create or replace function public.clear_historic_shipping_paid_mark(
  p_source_order_id text,
  p_campaign_id     integer
)
returns integer
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'aa_01_campaigns'
as $$
declare
  v_n integer;
begin
  if auth.uid() is null then
    raise exception 'forbidden: not signed in' using errcode = '42501';
  end if;
  if public.current_app_role() not in ('admin','team','support') then
    raise exception 'forbidden: staff only' using errcode = '42501';
  end if;

  delete from aa_01_campaigns.historic_line_dispatch_overrides ovr
   where ovr.historic_order_line_id in (
     select hol.id
       from aa_01_campaigns.historic_orders ho
       join aa_01_campaigns.historic_order_lines hol on hol.historic_order_id = ho.id
      where ho.source_order_id = p_source_order_id
        and hol.campaign_id    = p_campaign_id
   );
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

grant execute on function public.set_historic_shipping_paid_mark(text, integer, text) to authenticated;
grant execute on function public.clear_historic_shipping_paid_mark(text, integer)     to authenticated;
