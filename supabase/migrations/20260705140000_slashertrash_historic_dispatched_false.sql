-- SlasherTrash (campaign 15) is a pre-order campaign — no shipping has
-- happened yet and the backers haven't paid their shipping fees.
-- historic_dispatched had been flipped to true earlier which surfaced
-- all 2,878 historic orders as "Dispatched" on the customer detail page.
--
-- Reset to false so every SlasherTrash line renders as
-- "Pending Shipping Payment" until support marks them individually.
--
-- Verified pre-change:
--   raw_orders (live shopify) with campaign_id=15  ...  0 rows
--   historic_orders (paid)                         ...  2,878 rows
--   historic_line_dispatch_overrides               ...  0 rows
--   manual_shipping_marks                          ...  0 rows
-- Nothing to preserve — a plain flag flip is safe.

update aa_01_campaigns.campaigns
   set historic_dispatched = false
 where id = 15
   and "Name" = 'SlasherTrash';
