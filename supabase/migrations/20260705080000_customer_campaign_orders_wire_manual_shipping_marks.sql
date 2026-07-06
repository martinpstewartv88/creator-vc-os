-- Wire manual_shipping_marks back into the Shopify branch of
-- get_customer_campaign_orders.
--
-- Regression source: 20260703120000_historic_line_dispatch_override_and_
-- fix_gcco.sql re-issued this RPC to add the historic per-line override,
-- but the Shopify branch was rewritten without the manual_shipping_marks
-- join. Result: staff can click "Mark shipping paid" and a row lands in
-- manual_shipping_marks, but the badge never flips — the reader only
-- looked at acutrack_received.
--
-- Precedence in the Shopify branch (highest first):
--   1. digital-only order (no fulfilment path) → 'digital'
--   2. Acutrack.order_status = 'shipped'       → 'dispatched'   (ground truth from fulfilment)
--   3. Manual mark present OR Acutrack='new'   → 'shipping_paid'
--   4. Nothing else                            → 'pending_shipping'
--
-- DO NOT drop the manual_shipping_marks join or the historic override
-- join again — see the header on 20260703120000. This migration is
-- canonical for both.

create or replace function public.get_customer_campaign_orders(p_email text, p_campaign_id integer)
 returns table(product_name text, variant_name text, quantity integer, price_paid numeric, order_id text, order_number text, purchase_type text, financial_status text, delivery_status text)
 language sql
 security definer
 set search_path to 'pg_catalog', 'public', 'aa_01_campaigns', 'aa_02_crm'
as $function$
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
      when cos.has_digital_lines and not coalesce(cos.has_physical_lines, true)
        then 'digital'
      when (
        select lower(coalesce(a.order_status, '')) = 'shipped'
        from aa_01_campaigns.acutrack_received a
        where btrim(a.ponumber) = btrim(ro.shopify_order_number)
        limit 1
      )
        then 'dispatched'
      when msm.shopify_order_id is not null
        or exists (
          select 1 from aa_01_campaigns.acutrack_received a
          where btrim(a.ponumber) = btrim(ro.shopify_order_number)
            and lower(coalesce(a.order_status, '')) in ('new','')
        )
        then 'shipping_paid'
      else 'pending_shipping'
    end                                               as delivery_status
  from aa_01_campaigns.raw_orders ro
  left join aa_02_crm.campaign_orders_snapshot cos
    on cos.campaign_id = p_campaign_id
   and cos.order_key   = 'shopify:' || ro.shopify_order_id
  left join aa_01_campaigns.manual_shipping_marks msm
    on msm.shopify_order_id = ro.shopify_order_id,
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
    hol.product_name_raw                              as product_name,
    null::text                                        as variant_name,
    coalesce(hol.quantity, 1)                         as quantity,
    coalesce(hol.line_revenue, 0)::numeric            as price_paid,
    ho.source_order_id                                as order_id,
    ho.source_order_id                                as order_number,
    ho.source_platform                                as purchase_type,
    'paid'::text                                      as financial_status,
    coalesce(
      ovr.delivery_status,
      case when cos.has_digital_lines and not coalesce(cos.has_physical_lines, true) then 'digital'
           when (select c.historic_dispatched from aa_01_campaigns.campaigns c where c.id = p_campaign_id)
             then 'dispatched' else 'pending_shipping' end
    )                                                 as delivery_status
  from aa_01_campaigns.historic_orders ho
  join aa_01_campaigns.historic_order_lines hol on hol.historic_order_id = ho.id
  left join aa_02_crm.campaign_orders_snapshot cos
    on cos.campaign_id = p_campaign_id
   and cos.order_key   = 'historic:' || ho.id::text
  left join aa_01_campaigns.historic_line_dispatch_overrides ovr
    on ovr.historic_order_line_id = hol.id
  where hol.campaign_id = p_campaign_id
    and ho.order_status = 'paid'
    and lower(trim(ho.email)) = lower(trim(p_email))

  order by order_number nulls last, product_name
$function$;

grant execute on function public.get_customer_campaign_orders(text, integer) to anon, authenticated;
