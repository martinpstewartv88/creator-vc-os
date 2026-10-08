// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-shopify-shop-domain, x-shopify-topic, x-shopify-webhook-id, x-shopify-hmac-sha256",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// v41: removed all writes to the RETIRED campaign_orders / campaign_order_lines /
//   customer_campaign_orders tables (these silently refilled the retired store on every
//   live order). raw_orders + customer_raw_orders is the canonical path. No other change.
//
// v40: source_platform="shopify" + onConflict "(source_platform,shopify_order_id)".
//
// TODO (security re-tighten, unchanged): restore HMAC dual-auth from v37
//   (confirm SHOPIFY_WEBHOOK_SECRET under Edge Functions → Secrets).

type ShopifyLineItem = { id: number | string; sku?: string | null; title?: string | null; name?: string | null; quantity: number; price?: string | number | null; requires_shipping?: boolean | null; product_id?: number | string | null; variant_id?: number | string | null; variant_title?: string | null; };
type ShopifyOrder = { id?: number | string; name?: string; order_number?: number; email?: string | null; contact_email?: string | null; financial_status?: string | null; fulfillment_status?: string | null; currency?: string | null; created_at?: string; processed_at?: string; total_price?: string | number | null; total_price_usd?: string | number | null; current_total_price?: string | number | null; customer?: { email?: string | null } | null; shipping_address?: { name?: string | null; address1?: string | null; address2?: string | null; city?: string | null; zip?: string | null; country?: string | null; country_code?: string | null; } | null; line_items?: Array<ShopifyLineItem>; };
type ShopifyVariant = { id?: number | string; product_id?: number | string; title?: string | null; sku?: string | null; };
type ShopifyProduct = { id?: number | string; title?: string | null; variants?: ShopifyVariant[]; };

function safeText(v: unknown): string | null { if (v === null || v === undefined) return null; const s = String(v).trim(); return s.length ? s : null; }
function safeInt(v: unknown): number | null { if (v === null || v === undefined) return null; const n = parseFloat(String(v)); if (isNaN(n)) return null; return Math.round(n * 100); }
function safeJsonParse(text: string): { ok: true; value: unknown } | { ok: false; error: string } { try { return { ok: true, value: JSON.parse(text) }; } catch (e) { return { ok: false, error: String((e as Error)?.message ?? e) }; } }
function response200(body: unknown) { return new Response(JSON.stringify(body), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
function legacyCodeFromOrderNumber(orderNumber: string | null): string | null { if (!orderNumber) return null; const match = orderNumber.match(/^#?\d+-(.+)$/); if (!match) return null; return match[1].replace(/-/g, "_").toUpperCase(); }

async function handleProductWebhook(supabase: any, payload: ShopifyProduct, shopDomain: string | null, requestId: string | null) {
  let campaign_id: number | null = null;
  if (shopDomain) { try { const { data } = await supabase.schema("aa_01_campaigns").from("shop_domains").select("campaign_id").eq("shop_domain", shopDomain).maybeSingle(); if (data?.campaign_id) campaign_id = data.campaign_id; } catch (e) { console.error("[products] shop_domains threw", String(e)); } }
  const productId = safeText(payload?.id); const productTitle = safeText(payload?.title); const variants = Array.isArray(payload?.variants) ? payload.variants : []; const errors: unknown[] = []; let matched = 0; let pending = 0;
  for (const v of variants) {
    const variantId = safeText(v?.id); if (!variantId) continue;
    const sku = safeText(v?.sku); const variantTitle = safeText(v?.title);
    let matchedVariant: { id: number; legacy_code: string; products: { legacy_code: string } | { legacy_code: string }[] | null; } | null = null;
    if (sku) { try { const { data } = await supabase.schema("aa_01_campaigns").from("variants").select("id, legacy_code, products(legacy_code)").eq("legacy_code", sku).maybeSingle(); if (data) matchedVariant = data; } catch (e) { errors.push({ variantId, step: "match", error: String(e) }); } }
    let existingStatus: string | null = null; let existingResolvedVariantId: number | null = null;
    try { const { data } = await supabase.schema("aa_01_campaigns").from("shopify_product_inbox").select("status, resolved_variant_id").eq("shopify_variant_id", variantId).maybeSingle(); if (data) { existingStatus = data.status; existingResolvedVariantId = data.resolved_variant_id; } } catch (e) { errors.push({ variantId, step: "inbox_read", error: String(e) }); }
    let newStatus: "pending" | "matched"; let resolvedVariantId: number | null; let resolvedAt: string | null | undefined;
    if (existingStatus === "matched" || existingStatus === "created" || existingStatus === "dismissed") { newStatus = existingStatus as "matched"; resolvedVariantId = existingResolvedVariantId; resolvedAt = undefined; }
    else if (matchedVariant) { newStatus = "matched"; resolvedVariantId = matchedVariant.id; resolvedAt = new Date().toISOString(); }
    else { newStatus = "pending"; resolvedVariantId = null; resolvedAt = null; }
    const inboxRow: Record<string, unknown> = { shop_domain: shopDomain ?? "(unknown)", campaign_id, shopify_product_id: productId, shopify_variant_id: variantId, shopify_product_title: productTitle, shopify_variant_title: variantTitle, shopify_sku: sku, shopify_payload: payload, status: newStatus, resolved_variant_id: resolvedVariantId };
    if (resolvedAt !== undefined) inboxRow.resolved_at = resolvedAt;
    try { const { error } = await supabase.schema("aa_01_campaigns").from("shopify_product_inbox").upsert(inboxRow, { onConflict: "shopify_variant_id" }); if (error) { errors.push({ variantId, step: "inbox_upsert", error }); continue; } } catch (e) { errors.push({ variantId, step: "inbox_upsert", error: String(e) }); continue; }
    if (matchedVariant) { const productLegacyCode = Array.isArray(matchedVariant.products) ? matchedVariant.products[0]?.legacy_code ?? null : matchedVariant.products?.legacy_code ?? null; try { await supabase.schema("aa_01_campaigns").from("shopify_variants_map").upsert({ campaign_id, shopify_product_id: productId, shopify_variant_id: variantId, product_legacy_code: productLegacyCode, variant_legacy_code: matchedVariant.legacy_code }, { onConflict: "shopify_variant_id" }); } catch (e) { errors.push({ variantId, step: "map_upsert", error: String(e) }); } }
    if (newStatus === "matched") matched++; else pending++;
  }
  return { ok: errors.length === 0, product_id: productId, variants_processed: variants.length, variants_matched: matched, variants_pending: pending, campaign_id, errors };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return response200({ ok: true, ignored: true, reason: "method_not_allowed" });

  const requestId = req.headers.get("x-sb-request-id") ?? req.headers.get("x-request-id") ?? null;
  const rawBodyText = await req.text();

  const topicHeader = req.headers.get("x-shopify-topic") ?? req.headers.get("X-Shopify-Topic");
  if (!topicHeader) {
    return response200({ ok: true, ignored: true, reason: "no shopify topic" });
  }

  const parsed = safeJsonParse(rawBodyText);
  const payload = parsed.ok ? (parsed.value as Record<string, unknown>) : { _invalid_json: true, _parse_error: (parsed as { ok: false; error: string }).error, _raw: rawBodyText };
  const shopDomain = req.headers.get("x-shopify-shop-domain") ?? req.headers.get("X-Shopify-Shop-Domain") ?? safeText((payload as Record<string, unknown>)?.shop_domain) ?? safeText((payload as Record<string, unknown>)?.shopDomain) ?? null;
  const topic = topicHeader;
  const webhookId = req.headers.get("x-shopify-webhook-id") ?? req.headers.get("X-Shopify-Webhook-Id") ?? null;

  const supabaseUrl = Deno.env.get("SUPABASE_URL"); const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) { console.error("Missing Supabase env vars", { requestId }); return response200({ ok: false, error: "Missing env vars", requestId }); }
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  if (topic === "products/create" || topic === "products/update") { const result = await handleProductWebhook(supabase, payload as ShopifyProduct, shopDomain, requestId); return response200({ topic, shop_domain: shopDomain, webhook_id: webhookId, requestId, ...result }); }
  if (topic.startsWith("products/")) { console.log("[shopify-webhook] product topic ignored", { topic, requestId }); return response200({ ok: true, ignored: true, topic, requestId }); }

  const order = parsed.ok ? (payload as ShopifyOrder) : ({} as ShopifyOrder);
  const shopify_order_id = safeText(order?.id) ?? safeText((payload as Record<string, unknown>)?.id) ?? `missing_id:${webhookId ?? "no_webhook"}:${Date.now()}`;
  const shopify_order_number = safeText(order?.name) ?? (order?.order_number ? String(order.order_number) : null) ?? safeText((payload as Record<string, unknown>)?.name) ?? null;

  let campaign_id = 1; let campaignSource = "default";
  try { if (shopDomain) { const { data } = await supabase.schema("aa_01_campaigns").from("shop_domains").select("campaign_id").eq("shop_domain", shopDomain).maybeSingle(); if (data?.campaign_id) { campaign_id = data.campaign_id; campaignSource = "shop_domain"; } } } catch (e) { console.error("shop_domains threw", { requestId, error: String(e) }); }
  const legacyCode = legacyCodeFromOrderNumber(shopify_order_number);
  if (legacyCode) { try { const { data } = await supabase.schema("aa_01_campaigns").from("campaigns").select("id").eq("legacy_code", legacyCode).maybeSingle(); if (data?.id) { campaign_id = data.id; campaignSource = "order_number"; } } catch (e) { console.error("campaigns legacy_code threw", { requestId, error: String(e) }); } }

  const email = safeText(order?.email) ?? safeText(order?.contact_email) ?? safeText(order?.customer?.email) ?? safeText((payload as Record<string, unknown>)?.email) ?? null;
  const lineItems = Array.isArray(order?.line_items) ? order!.line_items! : [];
  const hasLines = lineItems.length > 0;
  const is_digital_only = hasLines && lineItems.every((li) => li?.requires_shipping === false);
  const has_digital = hasLines && lineItems.some((li) => li?.requires_shipping === false);

  const rawRow = { campaign_id, source_platform: "shopify", shopify_order_id, shopify_order_number, email, financial_status: safeText(order?.financial_status) ?? safeText((payload as Record<string, unknown>)?.financial_status), fulfillment_status: safeText(order?.fulfillment_status) ?? safeText((payload as Record<string, unknown>)?.fulfillment_status), processed_at: null, payload: payload ?? { _missing_payload: true }, shop_domain: shopDomain, source_topic: topic, webhook_id: webhookId, is_digital_only, has_digital };
  let rawSaved = false; let rawError: unknown = null; let rawOrderDbId: number | null = null;
  try { const { data, error } = await supabase.schema("aa_01_campaigns").from("raw_orders").upsert(rawRow, { onConflict: "source_platform,shopify_order_id" }).select("id").maybeSingle(); if (error) { rawError = error; console.error("raw_orders upsert error", { requestId, error }); } else { rawSaved = true; rawOrderDbId = (data as { id: number } | null)?.id ?? null; } } catch (e) { rawError = String(e); console.error("raw_orders threw", { requestId, error: String(e) }); }

  // REMOVED (v41): campaign_orders / campaign_order_lines writes — those tables are retired.

  let customerSaved = false; let customerError: unknown = null; let resolvedCustomerId: number | null = null;
  if (email && rawOrderDbId) {
    try {
      const { error: customerErr } = await supabase.schema("aa_02_crm").from("customers").upsert({ email, first_name: safeText(order?.shipping_address?.name)?.split(" ")[0] ?? null, last_name: safeText(order?.shipping_address?.name)?.split(" ").slice(1).join(" ") || null, shipping_address_1: safeText(order?.shipping_address?.address1), shipping_address_2: safeText(order?.shipping_address?.address2), shipping_city: safeText(order?.shipping_address?.city), shipping_zip: safeText(order?.shipping_address?.zip), shipping_country: safeText(order?.shipping_address?.country), shipping_country_code: safeText(order?.shipping_address?.country_code), updated_at: new Date().toISOString() }, { onConflict: "email", ignoreDuplicates: false });
      if (customerErr) { customerError = customerErr; console.error("customers upsert error", { requestId, error: customerErr, email }); }
      const normalisedEmail = email.toLowerCase().trim();
      const { data: customerRow, error: selectErr } = await supabase.schema("aa_02_crm").from("customers").select("id").eq("email", normalisedEmail).maybeSingle();
      if (selectErr) { customerError = customerError ?? selectErr; console.error("customers select error", { requestId, error: selectErr, email }); }
      resolvedCustomerId = (customerRow as { id: number } | null)?.id ?? null;
      if (resolvedCustomerId) {
        const { error: junctionErr } = await supabase.schema("aa_02_crm").from("customer_raw_orders").upsert({ customer_id: resolvedCustomerId, raw_order_id: rawOrderDbId }, { onConflict: "customer_id,raw_order_id", ignoreDuplicates: true });
        if (junctionErr) { customerError = customerError ?? junctionErr; console.error("customer_raw_orders error", { requestId, error: junctionErr }); }
        // REMOVED (v41): customer_campaign_orders upsert — retired table.
        await supabase.rpc("refresh_customer_aggregates", { p_customer_id: resolvedCustomerId });
        customerSaved = true;
      }
    } catch (e) { customerError = String(e); console.error("customer pipeline threw", { requestId, error: String(e), email }); }
  }

  return response200({ ok: rawSaved, saved_raw_order: rawSaved, customer_saved: customerSaved, shopify_order_id, campaign_id, campaign_source: campaignSource, is_digital_only, has_digital, shop_domain: shopDomain, topic, webhook_id: webhookId, requestId, raw_error: rawSaved ? null : rawError, customer_error: customerSaved ? null : customerError, parse_ok: parsed.ok, parse_error: parsed.ok ? null : (parsed as { ok: false; error: string }).error });
});
