-- Migration: add_historic_line_dispatch_override_and_fix_gcco
-- Date: 2026-07-03
-- Author: Mart (via Claude / Creator VC OS MCP)
--
-- Purpose:
--   1. Add a per-line dispatch override for HISTORIC order lines, so a single
--      historic line can be forced to a specific delivery_status (e.g. a bundle
--      component that is out of stock) without flipping the campaign-wide
--      historic_dispatched flag. Mirrors the manual_shipping_marks pattern.
--   2. RE-COMMIT the full corrected body of public.get_customer_campaign_orders.
--      The historic branch derives delivery_status from campaigns.historic_dispatched;
--      this fix has regressed once before because it lived only in the DB and not in
--      canonical source. This migration is the canonical definition. Do not overwrite
--      the historic branch without preserving BOTH the historic_dispatched logic AND
--      the historic_line_dispatch_overrides join below.
--   3. GRANT EXECUTE in the SAME migration (SECURITY DEFINER RPC — omitting the grant
--      blanks the PWA screens for anon/authenticated).
--
-- Idempotent: safe to re-run (CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE /
--             INSERT ... ON CONFLICT DO NOTHING).

CREATE TABLE IF NOT EXISTS aa_01_campaigns.historic_line_dispatch_overrides (
  id bigint generated always as identity primary key,
  historic_order_line_id bigint not null unique
    references aa_01_campaigns.historic_order_lines(id) on delete cascade,
  delivery_status text not null,
  note text,
  marked_by uuid,
  marked_at timestamptz not null default now()
);

CREATE OR REPLACE FUNCTION public.get_customer_campaign_orders(p_email text, p_campaign_id integer)
 RETURNS TABLE(product_name text, variant_name text, quantity integer, price_paid numeric, order_id text, order_number text, purchase_type text, financial_status text, delivery_status text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'aa_01_campaigns', 'aa_02_crm'
AS $function$
  select
    (li->>'title')::text as product_name,
    nullif(trim(li->>'variant_title'), '') as variant_name,
    (li->>'quantity')::integer as quantity,
    (li->>'price')::numeric as price_paid,
    ro.shopify_order_id as order_id,
    ro.shopify_order_number as order_number,
    'shopify'::text as purchase_type,
    ro.financial_status as financial_status,
    case
      when cos.has_digital_lines and not coalesce(cos.has_physical_lines, true) then 'digital'
      else coalesce(
        (select case lower(coalesce(a.order_status, ''))
            when 'shipped' then 'dispatched'
            when 'new' then 'shipping_paid'
            else 'shipping_paid' end
          from aa_01_campaigns.acutrack_received a
          where btrim(a.ponumber) = btrim(ro.shopify_order_number) limit 1),
        'pending_shipping')
    end as delivery_status
  from aa_01_campaigns.raw_orders ro
  left join aa_02_crm.campaign_orders_snapshot cos
    on cos.campaign_id = p_campaign_id and cos.order_key = 'shopify:' || ro.shopify_order_id,
   jsonb_array_elements(ro.payload->'line_items') as li
  where ro.campaign_id = p_campaign_id
    and lower(trim(ro.email)) = lower(trim(p_email))
    and ro.financial_status = 'paid'

  union all

  select
    p.title_at_purchase as product_name,
    nullif(trim(p.variant_title_at_purchase), '') as variant_name,
    p.quantity, p.price_paid,
    p.shopify_order_id as order_id, p.shopify_order_id as order_number,
    p.purchase_type, 'paid'::text as financial_status,
    case when (select c.historic_dispatched from aa_01_campaigns.campaigns c where c.id = p_campaign_id)
         then 'dispatched' else 'pending_shipping' end as delivery_status
  from aa_01_campaigns.v_crm_customer_purchases p
  where p.campaign_id = p_campaign_id
    and lower(trim(p.email)) = lower(trim(p_email))
    and not exists (select 1 from aa_01_campaigns.raw_orders where campaign_id = p_campaign_id limit 1)

  union all

  -- HISTORIC BRANCH:
  --   delivery_status precedence:
  --     1. historic_line_dispatch_overrides.delivery_status (per-line override) if present
  --     2. 'digital' if the order is digital-only per campaign_orders_snapshot
  --     3. campaigns.historic_dispatched ? 'dispatched' : 'pending_shipping'
  select
    hol.product_name_raw as product_name,
    null::text as variant_name,
    coalesce(hol.quantity, 1) as quantity,
    coalesce(hol.line_revenue, 0)::numeric as price_paid,
    ho.source_order_id as order_id, ho.source_order_id as order_number,
    ho.source_platform as purchase_type, 'paid'::text as financial_status,
    coalesce(
      ovr.delivery_status,
      case when cos.has_digital_lines and not coalesce(cos.has_physical_lines, true) then 'digital'
           when (select c.historic_dispatched from aa_01_campaigns.campaigns c where c.id = p_campaign_id)
           then 'dispatched' else 'pending_shipping' end
    ) as delivery_status
  from aa_01_campaigns.historic_orders ho
  join aa_01_campaigns.historic_order_lines hol on hol.historic_order_id = ho.id
  left join aa_02_crm.campaign_orders_snapshot cos
    on cos.campaign_id = p_campaign_id and cos.order_key = 'historic:' || ho.id::text
  left join aa_01_campaigns.historic_line_dispatch_overrides ovr
    on ovr.historic_order_line_id = hol.id
  where hol.campaign_id = p_campaign_id
    and ho.order_status = 'paid'
    and lower(trim(ho.email)) = lower(trim(p_email))

  order by order_number nulls last, product_name
$function$;

GRANT EXECUTE ON FUNCTION public.get_customer_campaign_orders(text, integer) TO anon, authenticated;

-- Operational override applied 2026-07-03: ISOD 80s Trilogy (FNG16097) bundle component
-- on historic order #74131 (line 165211, campaign 8) — out of stock, force pending_shipping.
INSERT INTO aa_01_campaigns.historic_line_dispatch_overrides
  (historic_order_line_id, delivery_status, note)
VALUES (165211, 'pending_shipping', 'ISOD 80s Trilogy out of stock - #74131, support 2026-07-03')
ON CONFLICT (historic_order_line_id) DO NOTHING;
