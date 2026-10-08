-- SlasherTrash (campaign 15) relaunch on Shopify, ahead of the 8pm
-- 2026-10-08 order wave. Same failure pattern as Jaws Explored
-- (20260715120000 / 20260715150000):
--
-- 1. Order-level attribution. shopify-webhook turns '#26614-SLASHER-TRASH'
--    into 'SLASHER_TRASH' and looks it up in campaigns.legacy_code.
--    Campaign 15 was imported as 'SLASHERTRASH_DOC', so every live order
--    (#26609-#26614 so far) fell through to the default campaign 1.
--    Nothing in code or DB functions references 'SLASHERTRASH_DOC'.
--
-- 2. Line-level attribution. 19 pending shopify_product_inbox rows:
--    - 6 pledge tiers: 4 products exist (143-146) but have no variants;
--      Associate Producer + Executive Producer products don't exist.
--    - 6 'Slasher Trash Logo' tees with SKUs -> product 147.
--    - 6 'Jaws Explored Poster Art' tees on the Slasher Trash T-Shirt
--      Shopify product with NULL SKUs -> new variants under product 147,
--      routed by shopify_variant_id (v_raw_order_line_attribution falls
--      back to shopify_variants_map). Shopify-side naming to be tidied
--      by Aaron; attribution doesn't depend on it.
--    - 1 stale row (The Thing Expanded / Digital Download, Aug 2026):
--      already mapped to THING-DIGITAL, inbox row just never closed.
--
-- Only raw_orders carries campaign_id for the mis-routed orders
-- (campaign_orders / manual_shipping_marks / backer_fulfillment /
-- order_entitlements have no rows for them). Inserts are guarded by
-- legacy_code, updates narrow on status='pending', so re-running is a
-- no-op.

-- Step 1 — legacy code to match the Shopify order-number suffix.
update aa_01_campaigns.campaigns
   set legacy_code = 'SLASHER_TRASH'
 where id = 15
   and legacy_code = 'SLASHERTRASH_DOC';

-- Step 2 — re-attribute live orders that fell through to campaign 1.
update aa_01_campaigns.raw_orders
   set campaign_id = 15
 where shopify_order_number ~* '-SLASHER-TRASH$'
   and campaign_id <> 15;

-- Step 3 — the two missing pledge-tier products.
insert into aa_01_campaigns.products
  (campaign_id, "Name", legacy_code, requires_address, notes)
select 15, t.name, t.code, true, null
from (values
  ('Slasher Trash - Associate Producer', 'SLASHER-TRASH-ASSOCIATE-PRODUCER'),
  ('Slasher Trash - Executive Producer', 'SLASHER-TRASH-EXECUTIVE-PRODUCER')
) as t(name, code)
where not exists (
  select 1 from aa_01_campaigns.products p where p.legacy_code = t.code
);

-- Step 4 — one variant per inbox row (18), keyed by Shopify variant id.
create temp table _st_inbox_map (
  shopify_variant_id text primary key,
  product_code       text not null,
  variant_name       text not null,
  variant_code       text not null
) on commit drop;

insert into _st_inbox_map values
  -- pledge tiers
  ('57515244945783', 'SLASHER-TRASH-DIGITAL',            'Digital Bundle',                     'SLASHER-TRASH-DIGITAL'),
  ('57515244880247', 'SLASHER-TRASH-COLLECTORS',         'Collector''s Edition Blu-ray',       'SLASHER-TRASH-COLLECTORS'),
  ('57515244913015', 'SLASHER-TRASH-DELUXE',             'Deluxe Collector''s Edition',        'SLASHER-TRASH-DELUXE'),
  ('57515245011319', 'SLASHER-TRASH-PRODUCER',           'Producer',                           'SLASHER-TRASH-PRODUCER'),
  ('57515244978551', 'SLASHER-TRASH-ASSOCIATE-PRODUCER', 'Associate Producer',                 'SLASHER-TRASH-ASSOCIATE-PRODUCER'),
  ('57515245044087', 'SLASHER-TRASH-EXECUTIVE-PRODUCER', 'Executive Producer',                 'SLASHER-TRASH-EXECUTIVE-PRODUCER'),
  -- Slasher Trash Logo tees (SKUs set in Shopify)
  ('57516512674167', 'SLASHER-TEE', 'Slasher Trash Logo | Small',     'SLASHER-TRASH-TEE-SMALL'),
  ('57516512706935', 'SLASHER-TEE', 'Slasher Trash Logo | Medium',    'SLASHER-TRASH-TEE-MEDIUM'),
  ('57516512739703', 'SLASHER-TEE', 'Slasher Trash Logo | Large',     'SLASHER-TRASH-TEE-LARGE'),
  ('57516512772471', 'SLASHER-TEE', 'Slasher Trash Logo | X-Large',   'SLASHER-TRASH-TEE-X-LARGE'),
  ('57516512805239', 'SLASHER-TEE', 'Slasher Trash Logo | XX-Large',  'SLASHER-TRASH-TEE-XX-LARGE'),
  ('57516512838007', 'SLASHER-TEE', 'Slasher Trash Logo | XXX-Large', 'SLASHER-TRASH-TEE-XXX-LARGE'),
  -- Poster Art tees (no SKU in Shopify; resolved by variant id only)
  ('57516512870775', 'SLASHER-TEE', 'Jaws Explored Poster Art | Small',     'SLASHER-TRASH-TEE-POSTER-SMALL'),
  ('57516512903543', 'SLASHER-TEE', 'Jaws Explored Poster Art | Medium',    'SLASHER-TRASH-TEE-POSTER-MEDIUM'),
  ('57516512936311', 'SLASHER-TEE', 'Jaws Explored Poster Art | Large',     'SLASHER-TRASH-TEE-POSTER-LARGE'),
  ('57516512969079', 'SLASHER-TEE', 'Jaws Explored Poster Art | X-Large',   'SLASHER-TRASH-TEE-POSTER-X-LARGE'),
  ('57516513001847', 'SLASHER-TEE', 'Jaws Explored Poster Art | XX-Large',  'SLASHER-TRASH-TEE-POSTER-XX-LARGE'),
  ('57516513034615', 'SLASHER-TEE', 'Jaws Explored Poster Art | XXX-Large', 'SLASHER-TRASH-TEE-POSTER-XXX-LARGE');

insert into aa_01_campaigns.variants
  (campaign_id, product_id, "Name", legacy_code, default_price, currency, source_type)
select 15, p.id, m.variant_name, m.variant_code, null, 'USD', 'shopify_product'
from _st_inbox_map m
join aa_01_campaigns.products p
  on p.legacy_code = m.product_code
 and p.campaign_id = 15
where not exists (
  select 1 from aa_01_campaigns.variants v where v.legacy_code = m.variant_code
);

-- Step 5 — shopify_variants_map so orders resolve by variant id
-- (the only path for the 6 NULL-SKU Poster Art tees).
insert into aa_01_campaigns.shopify_variants_map
  (campaign_id, shopify_product_id, shopify_variant_id, product_legacy_code, variant_legacy_code)
select 15, i.shopify_product_id, m.shopify_variant_id, m.product_code, m.variant_code
from _st_inbox_map m
join aa_01_campaigns.shopify_product_inbox i
  on i.shopify_variant_id = m.shopify_variant_id
where not exists (
  select 1 from aa_01_campaigns.shopify_variants_map sm
   where sm.shopify_variant_id = m.shopify_variant_id
);

-- Step 6 — resolve the 18 inbox rows against their new variants.
update aa_01_campaigns.shopify_product_inbox i
   set status              = 'created',
       resolved_variant_id = v.id,
       resolved_at         = now(),
       campaign_id         = 15,
       resolution_note     = 'Bulk resolved 2026-10-08 (SlasherTrash relaunch)',
       updated_at          = now()
  from _st_inbox_map m
  join aa_01_campaigns.variants v on v.legacy_code = m.variant_code
 where i.shopify_variant_id = m.shopify_variant_id
   and i.status = 'pending';

-- Step 7 — close the stale Thing Expanded / Digital Download row; its
-- variant id has been mapped to THING-DIGITAL since August.
update aa_01_campaigns.shopify_product_inbox i
   set status              = 'matched',
       resolved_variant_id = v.id,
       resolved_at         = now(),
       campaign_id         = 1,
       resolution_note     = 'Already mapped to THING-DIGITAL via shopify_variants_map; inbox row closed 2026-10-08',
       updated_at          = now()
  from aa_01_campaigns.variants v
 where v.legacy_code = 'THING-DIGITAL'
   and i.shopify_variant_id = '57069878772087'
   and i.status = 'pending';
