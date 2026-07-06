-- Extend the customer_list_snapshot search_text so operators can locate
-- a customer by any of their order numbers, not just name / email.
--
-- Reiner's Customers screen ask: "Can I search by order number?".
-- Wire it into the existing trigram-indexed search_text column rather
-- than adding a new query path — same predicate (search_text ilike
-- '%needle%'), same index, same latency. The changed-variant builder
-- gets a lateral aggregate of every shopify_order_number + historic
-- source_order_id we've attributed to that email, lowercased and
-- space-joined onto the existing email + full_name string.
--
-- After swapping the function definition we run a one-shot backfill
-- UPDATE across the whole snapshot so operators can search by
-- historical orders immediately without waiting on cron.
--
-- ISOD is not in the union — the legacy isod_orders table was retired
-- to public._archive_isod_orders. Post-retirement ISOD orders live in
-- historic_orders with source_platform in ('isod', 'shopify_legacy')
-- so they're already covered.

create or replace function aa_02_crm.refresh_customer_list_snapshot_changed(p_ids bigint[])
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'aa_01_campaigns', 'aa_02_crm'
as $function$
begin
  if p_ids is null or array_length(p_ids, 1) is null then
    return;
  end if;

  insert into aa_02_crm.customer_list_snapshot (
    id, email, full_name, total_orders, total_spend,
    shipping_city, shipping_country, is_backer,
    campaign_orders_detail, raw_orders_detail, isod_orders_detail, historic_orders_detail,
    campaign_ids, source_platforms, search_text, refreshed_at
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
  ) o on true
  where cs.id = any(p_ids)
    and (
      exists (select 1 from aa_01_campaigns.raw_orders ro
              where lower(btrim(ro.email)) = lower(cs.email)
                and ro.financial_status = 'paid')
      or exists (select 1 from aa_01_campaigns.historic_orders ho
                 where lower(btrim(ho.email)) = lower(cs.email)
                   and ho.order_status = 'paid')
    )
  on conflict (id) do update set
    email                  = excluded.email,
    full_name              = excluded.full_name,
    total_orders           = excluded.total_orders,
    total_spend            = excluded.total_spend,
    shipping_city          = excluded.shipping_city,
    shipping_country       = excluded.shipping_country,
    is_backer              = excluded.is_backer,
    campaign_orders_detail = excluded.campaign_orders_detail,
    raw_orders_detail      = excluded.raw_orders_detail,
    isod_orders_detail     = excluded.isod_orders_detail,
    historic_orders_detail = excluded.historic_orders_detail,
    campaign_ids           = excluded.campaign_ids,
    source_platforms       = excluded.source_platforms,
    search_text            = excluded.search_text,
    refreshed_at           = excluded.refreshed_at;

  delete from aa_02_crm.customer_list_snapshot s
  where s.id = any(p_ids)
    and not exists (
      select 1 from aa_02_crm.customers c
      where c.id = s.id
        and (
          exists (select 1 from aa_01_campaigns.raw_orders ro
                  where lower(btrim(ro.email)) = lower(c.email)
                    and ro.financial_status = 'paid')
          or exists (select 1 from aa_01_campaigns.historic_orders ho
                     where lower(btrim(ho.email)) = lower(c.email)
                       and ho.order_status = 'paid')
        )
    );
end;
$function$;

-- One-shot backfill: recompute search_text for every existing row so
-- operators can search by order numbers immediately. Pre-aggregates
-- order numbers by email into a temp table so the join against the
-- 113k+ snapshot is one indexed pass, not a correlated subquery per
-- row.
create temp table _search_agg (
  email_key text primary key,
  order_numbers text
) on commit drop;

insert into _search_agg (email_key, order_numbers)
select email_key, string_agg(distinct num, ' ')
from (
  select lower(btrim(email)) as email_key, lower(shopify_order_number) as num
  from aa_01_campaigns.raw_orders
  where financial_status = 'paid' and shopify_order_number is not null
  union all
  select lower(btrim(email)), lower(source_order_id)
  from aa_01_campaigns.historic_orders
  where order_status = 'paid' and source_order_id is not null
) x
where email_key is not null and email_key <> ''
group by email_key;

update aa_02_crm.customer_list_snapshot s
set search_text = coalesce(lower(s.email), '') || ' ' ||
                  coalesce(lower(s.full_name), '') || ' ' ||
                  coalesce(a.order_numbers, '')
from _search_agg a
where lower(s.email) = a.email_key;

-- Rows without any matching order numbers still get the plain email +
-- full_name form so search behaviour is stable across the fleet.
update aa_02_crm.customer_list_snapshot s
set search_text = coalesce(lower(s.email), '') || ' ' || coalesce(lower(s.full_name), '')
where not exists (
  select 1 from _search_agg a where a.email_key = lower(s.email)
);
