-- Jaws Explored (id 18) totals were still $0 across dashboards after
-- the legacy_code re-attribution migration. Root cause: line-level
-- attribution (mv_raw_order_line_attribution → campaigns_list_snapshot,
-- campaign_orders_snapshot, dashboard) resolves via SKU → variant →
-- product → campaign. Aaron created products for Jaws but no variant
-- for JAWS-EXPLORED-BLU-RAY-BOOK (the SKU on every Jaws order), so the
-- matview couldn't attribute any line revenue to campaign 18.
--
-- Also uncovered the same sequence-out-of-sync pattern as campaigns.id:
--   variants: max(id)=123, seq.last_value=122 → nextval collided.
--
-- Fix:
--   1. setval variants sequence to max(id) so future inserts don't
--      collide.
--   2. Insert the missing variant so line-level attribution resolves.
--   3. (Fired at apply time, not persisted here) refresh matview +
--      snapshots so the totals surface immediately without waiting on
--      cron.
--
-- Follow-up worth flagging: variant id 121 has Name='Associate Producer'
-- but is linked to product 166 ('Producer'). That's a name mismatch
-- Aaron should tidy via the Catalogue UI; harmless in itself but
-- confusing.

select setval(
  pg_get_serial_sequence('aa_01_campaigns.variants','id'),
  (select max(id) from aa_01_campaigns.variants)
);

insert into aa_01_campaigns.variants
  (campaign_id, product_id, "Name", legacy_code, default_price, currency, source_type)
select 18, 161, 'Blu-ray + Book', 'JAWS-EXPLORED-BLU-RAY-BOOK', null, 'USD', 'shopify_product'
where not exists (
  select 1 from aa_01_campaigns.variants where legacy_code = 'JAWS-EXPLORED-BLU-RAY-BOOK'
);
