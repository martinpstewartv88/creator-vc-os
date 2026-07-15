-- Jaws Explored (id 18) was created with legacy_code 'jaws-explored'
-- (kebab-lowercase). Every other campaign uses UPPERCASE_UNDERSCORE
-- (TT_EXPANDED, ISOD_70S, ...) which is what the shopify-webhook
-- expects when it parses '#22093-JAWS-EXPLORED' → normalises to
-- 'JAWS_EXPLORED' and looks up campaigns.legacy_code. The mismatch
-- caused every Jaws order to fall through to the default campaign_id=1
-- (The Thing Expanded).
--
-- Two-part fix:
--   1. Rename campaign 18's legacy_code to JAWS_EXPLORED so future
--      webhook writes land correctly.
--   2. Re-attribute the 5 orders that were already mis-routed to
--      campaign 1 (ids 22092, 22093, 22094, 22095, 22096 by
--      shopify_order_number suffix). Scoped tightly by pattern so we
--      only touch genuine Jaws orders, not legit Thing Expanded rows.

update aa_01_campaigns.campaigns
   set legacy_code = 'JAWS_EXPLORED'
 where id = 18
   and "Name" = 'Jaws Explored'
   and legacy_code = 'jaws-explored';

update aa_01_campaigns.raw_orders
   set campaign_id = 18
 where shopify_order_number ~* '-JAWS-EXPLORED$'
   and campaign_id <> 18;
