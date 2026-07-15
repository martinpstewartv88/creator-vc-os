-- Resolve 15 pending shopify_product_inbox rows related to the new
-- Jaws Explored (campaign 18) rollout. Post-rollout inventory:
--
--   14190/14191: Full Merch Package + Digital Bundle. Products already
--                exist (162, 163). Create matching variants, mark inbox
--                'created', populate shopify_variants_map so the next
--                products/update webhook resolves via variant_id.
--
--   14279-14290: 12 t-shirt variants (6 sizes × 2 designs) under a
--                Shopify product "T-shirt Addon Jaws". No canonical
--                product yet. Create umbrella product "T-shirt Addon
--                Jaws" under campaign 18 with legacy_code
--                JAWS-EXPLORED-TEE, then 12 variants (one per SKU).
--
--   13778:       "DIGITAL DOWNLOAD TEST" — null SKU, evident test
--                noise. Dismiss.
--
-- Every INSERT is guarded by WHERE NOT EXISTS on the canonical legacy
-- code so the migration is idempotent; every UPDATE narrows on
-- status='pending' so it can't stomp a later resolution.

-- Step 1 — new umbrella product for the t-shirt variants.
insert into aa_01_campaigns.products
  (campaign_id, "Name", legacy_code, requires_address, notes)
select 18, 'T-shirt Addon Jaws', 'JAWS-EXPLORED-TEE', true, null
where not exists (
  select 1 from aa_01_campaigns.products where legacy_code = 'JAWS-EXPLORED-TEE'
);

-- Step 2 — variants for the 2 existing Jaws products.
insert into aa_01_campaigns.variants
  (campaign_id, product_id, "Name", legacy_code, default_price, currency, source_type)
select 18, 162, 'Full Merch Package', 'JAWS-EXPLORED-FULL-MERCH-PACK', null, 'USD', 'shopify_product'
where not exists (
  select 1 from aa_01_campaigns.variants where legacy_code = 'JAWS-EXPLORED-FULL-MERCH-PACK'
);
insert into aa_01_campaigns.variants
  (campaign_id, product_id, "Name", legacy_code, default_price, currency, source_type)
select 18, 163, 'Digital Bundle', 'JAWS-EXPLORED-DIGITAL-BUNDLE', null, 'USD', 'shopify_product'
where not exists (
  select 1 from aa_01_campaigns.variants where legacy_code = 'JAWS-EXPLORED-DIGITAL-BUNDLE'
);

-- Step 3 — 12 t-shirt variants (6 sizes × 2 designs).
with tee_product as (
  select id from aa_01_campaigns.products where legacy_code = 'JAWS-EXPLORED-TEE'
)
insert into aa_01_campaigns.variants
  (campaign_id, product_id, "Name", legacy_code, default_price, currency, source_type)
select 18, (select id from tee_product), row_name, row_code, null, 'USD', 'shopify_product'
from (values
  ('Jaws Explored Logo | Small',        'JAWS-EXPLORED-TEE-LOGO-SMALL'),
  ('Jaws Explored Logo | Medium',       'JAWS-EXPLORED-TEE-LOGO-MEDIUM'),
  ('Jaws Explored Logo | Large',        'JAWS-EXPLORED-TEE-LOGO-LARGE'),
  ('Jaws Explored Logo | X-Large',      'JAWS-EXPLORED-TEE-LOGO-XLARGE'),
  ('Jaws Explored Logo | XX-Large',     'JAWS-EXPLORED-TEE-LOGO-XXLARGE'),
  ('Jaws Explored Logo | XXX-Large',    'JAWS-EXPLORED-TEE-LOGO-XXXLARGE'),
  ('Jaws Explored Poster Art | Small',     'JAWS-EXPLORED-TEE-POSTER-SMALL'),
  ('Jaws Explored Poster Art | Medium',    'JAWS-EXPLORED-TEE-POSTER-MEDIUM'),
  ('Jaws Explored Poster Art | Large',     'JAWS-EXPLORED-TEE-POSTER-LARGE'),
  ('Jaws Explored Poster Art | X-Large',   'JAWS-EXPLORED-TEE-POSTER-XLARGE'),
  ('Jaws Explored Poster Art | XX-Large',  'JAWS-EXPLORED-TEE-POSTER-XXLARGE'),
  ('Jaws Explored Poster Art | XXX-Large', 'JAWS-EXPLORED-TEE-POSTER-XXXLARGE')
) as t(row_name, row_code)
where not exists (
  select 1 from aa_01_campaigns.variants v where v.legacy_code = t.row_code
);

-- Step 4 — resolve inbox rows against the newly-created variants.
update aa_01_campaigns.shopify_product_inbox i
   set status = 'created',
       resolved_variant_id = v.id,
       resolved_at = now(),
       campaign_id = 18,
       resolution_note = 'Bulk resolved 2026-07-15 (Jaws Explored rollout)',
       updated_at = now()
  from aa_01_campaigns.variants v
 where i.status = 'pending'
   and i.shopify_sku is not null
   and v.legacy_code = i.shopify_sku;

-- Step 5 — populate shopify_variants_map so future products/update
-- webhooks resolve by variant_id (faster than SKU fallback).
insert into aa_01_campaigns.shopify_variants_map
  (campaign_id, shopify_product_id, shopify_variant_id, product_legacy_code, variant_legacy_code)
select 18, i.shopify_product_id, i.shopify_variant_id, p.legacy_code, v.legacy_code
  from aa_01_campaigns.shopify_product_inbox i
  join aa_01_campaigns.variants  v on v.legacy_code = i.shopify_sku
  join aa_01_campaigns.products  p on p.id = v.product_id
 where i.resolved_variant_id = v.id
   and i.resolution_note = 'Bulk resolved 2026-07-15 (Jaws Explored rollout)'
   and not exists (
     select 1 from aa_01_campaigns.shopify_variants_map m
      where m.shopify_variant_id = i.shopify_variant_id
   );

-- Step 6 — dismiss the null-SKU test row (13778 "DIGITAL DOWNLOAD TEST").
update aa_01_campaigns.shopify_product_inbox
   set status = 'dismissed',
       resolved_at = now(),
       resolution_note = coalesce(resolution_note,'') || ' [auto-dismissed: null SKU, test product 2026-07-15]',
       updated_at = now()
 where id = 13778
   and status = 'pending';
