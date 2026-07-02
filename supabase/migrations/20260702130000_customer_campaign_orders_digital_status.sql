-- Add a fifth delivery state — 'digital' — to get_customer_campaign_orders.
--
-- When every line in an order is digital (no physical fulfilment), we
-- want to label the shipping-status pill as "Digital" and hide the
-- owner's Mark/Unmark buttons. Nothing to ship = nothing to mark.
--
-- Source of truth for digital-only:
--   aa_02_crm.campaign_orders_snapshot.has_digital_lines = true
--   AND                              has_physical_lines = false
--
-- The snapshot builder (migration 20260626130000) already runs the
-- DIGITAL/DOWNLOAD/gumroad detection over both live (raw_orders +
-- mv_raw_order_line_attribution) and historic sources. Joining here
-- keeps that logic in one place.
--
-- Branch behaviour:
--   * Shopify (raw_orders):     look up cos, may become 'digital'
--   * Historic (historic_*):    look up cos, may become 'digital'
--   * ISOD (isod_orders):       always physical, no change
--   * v_crm_customer_purchases: legacy fallback, stays 'dispatched'
--
-- No persisted per-order state — the RPC re-derives on every call —
-- so "backfill" is a no-op semantically. We do refresh the snapshot
-- at the end so any freshly-imported orders classify immediately
-- without waiting for cron.

drop function if exists public.get_customer_campaign_orders(text, integer);

create or replace function public.get_customer_campaign_orders(
  p_email       text,
  p_campaign_id integer
)
returns table (
  product_name     text,
  variant_name     text,
  quantity         integer,
  price_paid       numeric,
  order_id         text,
  order_number     text,
  purchase_type    text,
  financial_status text,
  delivery_status  text
)
language sql
security definer
set search_path = pg_catalog, public, aa_01_campaigns, aa_02_crm
as $$
  select
    (li->>'title')::text                              as product_name,
    nullif(trim(li->>'variant_title'), '')            as variant_name,
    (li->>'quantity')::integer                        as quantity,
    (li->>'price')::numeric                           as price_paid,
    ro.shopify_order_id                               as order_id,
    ro.shopify_order_number                           as order_number,
    'shopify'::text                                   as purchase_type,
    ro.financial_status                               as financial_status,
    case
      when cos.has_digital_lines
       and not coalesce(cos.has_physical_lines, true)
        then 'digital'
      else coalesce(
        (
          select case lower(coalesce(a.order_status, ''))
            when 'shipped' then 'dispatched'
            when 'new'     then 'shipping_paid'
            else                'shipping_paid'
          end
          from aa_01_campaigns.acutrack_received a
          where btrim(a.ponumber) = btrim(ro.shopify_order_number)
          limit 1
        ),
        'pending_shipping'
      )
    end                                               as delivery_status
  from aa_01_campaigns.raw_orders ro
  left join aa_02_crm.campaign_orders_snapshot cos
    on cos.campaign_id = p_campaign_id
   and cos.order_key   = 'shopify:' || ro.shopify_order_id,
   jsonb_array_elements(ro.payload->'line_items') as li
  where ro.campaign_id = p_campaign_id
    and lower(trim(ro.email)) = lower(trim(p_email))
    and ro.financial_status = 'paid'

  union all

  select
    p.title_at_purchase                               as product_name,
    nullif(trim(p.variant_title_at_purchase), '')     as variant_name,
    p.quantity,
    p.price_paid,
    p.shopify_order_id                                as order_id,
    p.shopify_order_id                                as order_number,
    p.purchase_type,
    'paid'::text                                      as financial_status,
    'dispatched'::text                                as delivery_status
  from aa_01_campaigns.v_crm_customer_purchases p
  where p.campaign_id = p_campaign_id
    and lower(trim(p.email)) = lower(trim(p_email))
    and not exists (
      select 1 from aa_01_campaigns.raw_orders
      where campaign_id = p_campaign_id limit 1
    )

  union all

  select
    iol.sku_after_correction                          as product_name,
    null::text                                        as variant_name,
    1::integer                                        as quantity,
    iol.price_paid                                    as price_paid,
    io.order_id                                       as order_id,
    io.purchase_order_number                          as order_number,
    'isod'::text                                      as purchase_type,
    'paid'::text                                      as financial_status,
    'dispatched'::text                                as delivery_status
  from aa_01_campaigns.isod_orders io
  join aa_01_campaigns.isod_order_lines iol on iol.isod_order_id = io.id
  where io.campaign_id = p_campaign_id
    and lower(trim(io.customer_email)) = lower(trim(p_email))
    and not exists (
      select 1 from aa_01_campaigns.raw_orders
      where campaign_id = p_campaign_id limit 1
    )
    and not exists (
      select 1 from aa_01_campaigns.order_entitlements
      where campaign_id = p_campaign_id limit 1
    )

  union all

  select
    hol.product_name_raw                              as product_name,
    null::text                                        as variant_name,
    coalesce(hol.quantity, 1)                         as quantity,
    coalesce(hol.line_revenue, 0)::numeric            as price_paid,
    ho.source_order_id                                as order_id,
    ho.source_order_id                                as order_number,
    ho.source_platform                                as purchase_type,
    'paid'::text                                      as financial_status,
    case
      when cos.has_digital_lines
       and not coalesce(cos.has_physical_lines, true)
        then 'digital'
      else 'dispatched'
    end                                               as delivery_status
  from aa_01_campaigns.historic_orders ho
  join aa_01_campaigns.historic_order_lines hol on hol.historic_order_id = ho.id
  left join aa_02_crm.campaign_orders_snapshot cos
    on cos.campaign_id = p_campaign_id
   and cos.order_key   = 'historic:' || ho.id::text
  where hol.campaign_id = p_campaign_id
    and ho.order_status = 'paid'
    and lower(trim(ho.email)) = lower(trim(p_email))

  order by order_number nulls last, product_name
$$;

grant execute on function public.get_customer_campaign_orders(text, integer) to authenticated, anon, service_role;

-- Refresh the snapshot so any orders whose digital/physical
-- classification changed pick up immediately, rather than waiting
-- for the next scheduled refresh.
select aa_02_crm.refresh_campaign_orders_snapshot();
