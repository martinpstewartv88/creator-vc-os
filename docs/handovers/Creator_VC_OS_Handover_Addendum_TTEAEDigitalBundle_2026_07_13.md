# Handover Addendum — TTE & AE Digital Bundle (Gumroad `qfylf`)

**Date:** 2026-07-13
**Author:** C Chat (Claude.ai / Supabase MCP)
**Trigger:** Aaron & Robin released a new Gumroad product — *The Thing Expanded & Aliens Expanded — Digital Bundle* — without a DB mapping. Orders landed with an empty campaign.

**Outcome:** Fixed with **one map row**. A fan-out mechanism was built, deployed, found to be double-counting, and **fully reverted**. Net DB change is 1 `gumroad_products_map` row + 1 variant. Read §2 and §5 before touching Gumroad bundles again.

---

## 1. The actual fault

The webhook behaved **correctly**. v10's null-fallback (July 01) captured the unmapped product *unattributed* rather than dumping it on campaign 1, and `aa_01_campaigns.v_gumroad_unmapped` lit up. The monitor did its job.

Consequences of the missing map row:
- `raw_orders.campaign_id` = NULL on 12 orders.
- Synthetic line `sku` = NULL → **unresolved** in `mv_raw_order_line_attribution`.
- **$370.88 attributed to no campaign.**
- Customers + `customer_raw_orders` landed fine (12/12).

**That was the whole fault.** Nothing else was broken.

### 1.1 It was ONE Gumroad product, not two

Two product names appear in the payloads, but they share `short_product_id = qfylf`, `product_id = sGvcU9sjTlCX36n8KaKvFA==`, `permalink = expanded`. Aaron **renamed the product and raised the price mid-flight**:

| Name in payload | Window | Orders | Price | Gross |
|---|---|---|---|---|
| The Expanded Universe | 5–8 Jul | 7 | $27.99 | $195.93 |
| The Thing Expanded & Aliens Expanded - Digital Bundle | 9–12 Jul | 5 | $34.99 | $174.95 |
| **Total** | | **12** | | **$370.88** |

**Lesson: triage `v_gumroad_unmapped` by `short_product_id`, never by `product_name`.**

---

## 2. THE BIG ONE — Gumroad fans out bundles natively

**A Gumroad bundle purchase fires one webhook ping PER CONSTITUENT PRODUCT, each with its own `sale_id`, each at `price = 0`.** The bundle header arrives priced; every film inside it arrives as its own separate $0.00 sale.

Worked example — `tadhgmac@hotmail.co.uk`, 12 Jul 08:50:

| raw_order | short_id | product | campaign | total |
|---|---|---|---|---|
| 22176 | `qfylf` | TTE & AE Digital Bundle | 17 | **$34.99** |
| 22174 | `azmru` | THE THING EXPANDED (2026) | 1 | **$0.00** |
| 22175 | `pqfhzb` | ALIENS EXPANDED | 4 | **$0.00** |

Same pattern on the CreatorVC Filmography bundle (`energtv@gmail.com`, 13 Jul: 6 pings — 1 priced header + 5 free components). **Verified across all 12 `qfylf` buyers: every single one already had native $0.00 TTE and AE orders in `raw_orders`, correctly mapped to c1 and c4, from purchase time.**

So the films were **already being credited correctly**. The only thing missing was the header's campaign.

> **A new cross-film Gumroad bundle needs ONLY a `gumroad_products_map` row for the bundle header. Nothing else. No component variants, no synthetic lines, no code change.**

---

## 3. Final DB state (net change)

**`create_tte_ae_bundle_variants`** — variant **123** `TTE-AE-DIGITAL-BUNDLE-PKG`, product 152 (`DIGITAL-PACKAGE`), campaign 17, `source_type='gumroad_product'`. (Variants 121/122 also created here, later deleted — §4.) `variants.id` has **no default**; ids are explicit.

**`create_gumroad_bundle_components_and_map_tte_ae`** — `gumroad_products_map` row **16**: `qfylf` → `TTE-AE-DIGITAL-BUNDLE` / `TTE-AE-DIGITAL-BUNDLE-PKG` / **c17**. (Also created the `gumroad_bundle_components` table, later dropped — §4.)

**`backfill_tte_ae_digital_bundle_orders`** — 12 rows, `campaign_id` NULL → **17**, header line stamped with the package SKU. `gumroad_raw` preserved. Guard is idempotent.

**`refresh_raw_attribution_mv_*`** — MV refreshed. `public.refresh_dashboard_snapshot()` run.

**Still outstanding:** `refresh_campaigns_list_snapshot()` — not callable via MCP role (`forbidden: revenue access denied` inside `get_campaign_stats_v3()`). Dashboard SQL editor under service role, or leave to pg_cron.

### Verified end state

| Campaign | Lines | Units | Revenue |
|---|---|---|---|
| c1 The Thing Expanded | 19,087 | 19,293 | $1,693,449.36 — **unchanged from baseline** |
| c4 Aliens Expanded | 4,320 | 4,479 | $269,312.44 — **unchanged from baseline** |
| c17 CreatorVC Digital Package | 169 | 169 | **$3,370.99** (+$370.88) |
| Unresolved | 1 | 1 | $0.00 |

`v_gumroad_unmapped` = **0**. Platform gross unchanged in aggregate — the $370.88 moved from unattributed to c17. c1 and c4 are untouched, because Gumroad had already credited them.

**Remaining unresolved line is unrelated and pre-existing:** `raw_orders.id = 16279`, a **Shopify** c4 order from 23 April, junk line title `TTE-DL-LLLLLL`, `sku` NULL, $0.00. Zero revenue impact.

---

## 4. The mistake — built, deployed, reverted

**What was built (and is now gone):** a "cross-film fan-out" — dedicated `*-COMPONENT` variants on c1/c4, a `gumroad_bundle_components` driver table, synthetic $0 component lines in the backfilled payloads, and `gumroad-webhook` **v11** emitting header + N component lines.

**Why it was wrong:** it duplicated what Gumroad already does natively (§2). Every bundle order ended up with **2 units on c1 and 2 units on c4** instead of 1 — the native $0 ping *plus* the synthetic component line.

**Root cause of the error:** the historic **Star Wars Day Special** fan-out in `historic_order_lines` (`resolver_method='bundle_component_synth'`) was taken as a precedent for the live path. **It is not.** Historic CSV imports have no per-product rows, so components had to be synthesised. Live Gumroad emits them. Same-looking problem, different data source. The pattern was ported without first checking whether the live platform already solved it.

**How it was caught:** post-deploy log review showed six near-simultaneous Gumroad POSTs, which surfaced the multi-ping behaviour. It should have been caught pre-write, by the one query in §5.

**Revert — `revert_tte_ae_bundle_fanout_gumroad_native`, `drop_gumroad_bundle_fanout_artifacts`:**
- Deleted the 2 `gumroad_bundle_components` rows.
- Collapsed the 12 payloads back to a single header line (`campaign_id=17` and header SKU retained — those were correct).
- Refreshed the MV; c1/c4 confirmed back to **exact** baseline.
- `DROP TABLE aa_01_campaigns.gumroad_bundle_components`; deleted variants 121/122. Zero references verified first (raw_orders payload SKUs, MV lines, `shopify_variants_map`, `gumroad_products_map` — all 0).
- **Reverted `gumroad-webhook` to v10** (redeployed as **v12**). This was *required*, not cosmetic: v11 queries a table that no longer exists. The lookup was wrapped in a non-fatal try/catch so orders would still have saved, but every mapped sale would have logged an error and burned a wasted round-trip.

Variant 122's legacy code (`AE-DIGITAL-COMPONENT`) collided by name with `historic_order_lines.product_legacy_code` from the Star Wars synth. Historic lines carry `campaign_id` directly and never resolve through `variants`, so nothing broke — but deleting the variant removes any chance of a future SKU resolver latching onto it.

---

## 5. Key learnings

- **CHECK FOR NATIVE FAN-OUT BEFORE SYNTHESISING ANYTHING.** Before adding component lines to any live bundle, run:

```sql
-- do this bundle's buyers already have adjacent $0.00 orders?
SELECT o.id,
       o.campaign_id,
       o.payload->'gumroad_raw'->>'product_name' AS product,
       o.payload->>'total_price'                 AS total
FROM aa_01_campaigns.raw_orders b
JOIN aa_01_campaigns.raw_orders o
  ON lower(o.email) = lower(b.email)
 AND o.id <> b.id
 AND o.processed_at BETWEEN b.processed_at - interval '10 min'
                        AND b.processed_at + interval '10 min'
WHERE b.payload->'gumroad_raw'->>'short_product_id' = '<bundle_short_id>';
```

  If $0.00 component orders come back: **the platform is already doing it. Add the map row and stop.**

- **Historic bundle-synth is NOT a live precedent.** `historic_order_lines` stores `campaign_id` directly and comes from CSVs with no per-product rows. Live orders resolve through the variant graph and arrive pre-fanned-out. Do not port the pattern.
- **A Gumroad product's *name* is not its identity.** Renamed and repriced mid-campaign here. `short_product_id` is the key.
- **The null-fallback design paid for itself again.** Second unmapped product since it shipped; captured, loud, fixable with one row. Do not reintroduce a default campaign.
- `variants.id` / `products.id` have **no default** — explicit ids required. `gumroad_products_map.id` *is* a serial.
- `line_revenue = quantity × unit_price` in `v_raw_order_line_attribution`. (Same expression carries the known latent discount-allocation bug — still open, untouched.)
- **Process note.** The read-only investigation found the missing map row and stopped there. It never asked *"is the thing I'm about to build already being done for me?"* The dry-run locked row counts correctly — but locking counts only proves the migration does what was **intended**. It cannot catch a wrong intention. **Cross-check the design against live platform behaviour, not just against the DB.**

---

## 6. Still open

- **Gumroad `contact_sources` never written — 0 rows out of 797 gumroad orders, ever.** Found during this investigation; **not caused by this bundle**. Leading theory: v10 writes `marketing_consent_source: "gumroad_checkout"`, but the `aa_03_marketing.consent_source` enum only permits `microsite_explicit / shopify_checkout / csv_import / manual / legacy_customer_backfill` — the contacts upsert throws, `contactId` stays null, `contact_sources` is never reached. **The theory is incomplete:** the 4 orders with `can_contact=false` should have taken the null-source branch and succeeded, and they *also* have no source row. **Prove it before patching** — capture a live error log or fire a test ping and read the actual `contacts upsert error` payload. (`contact_sources.source_type` already has a valid `gumroad_checkout_optin` value, so any enum gap is on `consent_source` only.) Agreed with Mart as the next piece of work.
- `refresh_campaigns_list_snapshot()` under service role.
- Clean up unresolved `raw_orders.id = 16279` (`TTE-DL-LLLLLL`, $0.00).
- Unchanged: ISOD consolidation; drop retired table shells; Shopify HMAC re-tighten; `get_campaign_stats_v2/v3` non-isod historic undercount; `line_revenue` discount allocation bug.

---

## 7. NEXT.md updates to make on commit

- Add: "TTE & AE Digital Bundle (2026-07-13) — `gumroad_products_map` row 16 (`qfylf` → c17) + variant 123 `TTE-AE-DIGITAL-BUNDLE-PKG`. 12 orders backfilled, $370.88 moved from unattributed → c17. c1/c4 unchanged."
- Add, prominently: "**Gumroad fans out bundles natively** — one $0.00 ping per constituent film, own `sale_id`. A new cross-film bundle needs ONLY a `gumroad_products_map` row for the header. NEVER synthesise component lines on the live path; that double-counts. The Star Wars `bundle_component_synth` in `historic_order_lines` is historic-CSV-only and is NOT a precedent. See addendum §2 and §5."
- Add: "gumroad-webhook v11 (bundle fan-out) was deployed and fully reverted same-day. Live version is **v12 = v10 restored**."
- Add to open items: gumroad `contact_sources` never written (0/797) — investigate before patching.
