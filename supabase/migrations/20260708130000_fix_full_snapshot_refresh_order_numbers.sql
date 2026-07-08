-- The 2026-07-03 migration extended search_text to include order
-- numbers in refresh_customer_list_snapshot_changed (the incremental
-- variant), but the FULL refresh — refresh_customer_list_snapshot —
-- was left with the old email+full_name-only form.
--
-- The full refresh TRUNCATEs the whole snapshot before rebuilding, so
-- every time it fires the enriched search_text I backfilled gets
-- wiped and rebuilt without order numbers. Result: order-number
-- search stops working within the next full-refresh cadence. Reiner
-- hit this searching '#20223-ISOD-70s' — the raw order exists, the
-- backer is in the snapshot, but his search_text was reduced to
-- "email full_name".
--
-- Fix: mirror the same lateral aggregate the _changed variant uses.
-- Rebuild inline via a bulk UPDATE using the same pre-agg temp table
-- pattern from the 2026-07-03 backfill so the fix takes effect
-- immediately without waiting for cron.

create or replace function aa_02_crm.refresh_customer_list_snapshot()
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'aa_01_campaigns', 'aa_02_crm'
as $function$
begin
  truncate aa_02_crm.customer_list_snapshot;
  insert into aa_02_crm.customer_list_snapshot (
    id, email, full_name, total_orders, total_spend,
    shipping_city, shipping_country, is_backer,
    campaign_orders_detail, raw_orders_detail, isod_orders_detail, historic_orders_detail,
    campaign_ids, source_platforms, search_text, refreshed_at
  )
  with paying as (
    select email from aa_02_crm.v_paying_customer_emails
  )
  select
    cs.id, cs.email, cs.full_name, cs.total_orders,
    coalesce(cs.total_spend, 0) as total_spend,
    cs.shipping_city, cs.shipping_country, cs.is_backer,
    cs.campaign_orders_detail, cs.raw_orders_detail,
    cs.isod_orders_detail, cs.historic_orders_detail,
    (
      select array_agg(distinct (d->>'campaign_id')::int)
      from (
        select jsonb_array_elements(coalesce(cs.campaign_orders_detail, '[]'::jsonb)) as d
        union all
        select jsonb_array_elements(coalesce(cs.raw_orders_detail, '[]'::jsonb))
        union all
        select jsonb_array_elements(coalesce(cs.isod_orders_detail, '[]'::jsonb))
        union all
        select jsonb_array_elements(coalesce(cs.historic_orders_detail, '[]'::jsonb))
      ) flat
      where d ? 'campaign_id'
    ) as campaign_ids,
    (
      select array_agg(distinct plat)
      from (
        select case when jsonb_array_length(coalesce(cs.raw_orders_detail, '[]'::jsonb)) > 0
                    then 'shopify' end as plat
        union all
        select case when jsonb_array_length(coalesce(cs.isod_orders_detail, '[]'::jsonb)) > 0
                    then 'isod' end
        union all
        select distinct d->>'source'
        from jsonb_array_elements(coalesce(cs.historic_orders_detail, '[]'::jsonb)) d
        where d ? 'source'
      ) flat
      where plat is not null
    ) as source_platforms,
    coalesce(lower(cs.email), '') || ' ' ||
    coalesce(lower(cs.full_name), '') || ' ' ||
    coalesce(o.order_numbers, '') as search_text,
    now() as refreshed_at
  from aa_02_crm.customer_summary cs
  inner join paying p on p.email = lower(cs.email)
  left join lateral (
    select string_agg(distinct lower(x.n), ' ') as order_numbers
    from (
      select ro.shopify_order_number as n
      from aa_01_campaigns.raw_orders ro
      where lower(btrim(ro.email)) = lower(cs.email)
        and ro.financial_status = 'paid'
        and ro.shopify_order_number is not null
      union all
      select ho.source_order_id
      from aa_01_campaigns.historic_orders ho
      where lower(btrim(ho.email)) = lower(cs.email)
        and ho.order_status = 'paid'
        and ho.source_order_id is not null
    ) x
  ) o on true;
end;
$function$;
