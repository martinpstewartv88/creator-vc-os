// deno-lint-ignore-file no-explicit-any
//
// acutrack-send-order — POST a Shopify order to Acutrack's webhook when a
// staff user marks its shipping as paid. Called fire-and-forget from
// the "Mark shipping paid" button in components/CustomerCampaigns.tsx.
//
// Input body:
//   { shopify_order_id: string }   // the Shopify GID / long id
//
// Flow:
//   1. Verify caller has a JWT (staff-only route).
//   2. Load raw_orders row for that shopify_order_id.
//   3. Reshape the Shopify shipping_address + line_items into Acutrack's
//      order_details schema (see example provided by Acutrack).
//   4. POST to Acutrack's fixed webhook URL. No auth on their side —
//      the URL path itself is the credential.
//   5. Insert a row into aa_01_campaigns.acutrack_send_log with the
//      request body, response status/body, and any error. Log always
//      writes, even if the fetch failed.
//   6. Return { ok, status } — the caller (frontend) ignores the
//      response, so this is mostly for the function log / manual retry.
//
// shipping_type mapping:
//   country_code == 'US'  → "Domestic (US)"
//   else                  → "International"
// Acutrack may use a different label for non-US; first non-US send will
// surface it in acutrack_send_log.response_body.
//
// Non-existent order → 404. Not idempotent by design — every mark
// triggers a fresh push. Duplicate pushes end up as duplicate rows in
// Acutrack's system; support can dedupe on their side by order_id.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ACUTRACK_URL = "https://webhooks.acutrack.com/v1/10009/52/100";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const shopify_order_id = String(body?.shopify_order_id ?? "").trim();
  if (!shopify_order_id) return json({ error: "shopify_order_id required" }, 400);

  const supabase = createClient(SB_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Resolve caller uid from their JWT so the audit row records who
  // triggered the push. Errors are non-fatal; log gets a null uid.
  let triggered_by: string | null = null;
  try {
    const jwt = auth.slice("Bearer ".length);
    const { data } = await supabase.auth.getUser(jwt);
    triggered_by = data?.user?.id ?? null;
  } catch { /* non-fatal */ }

  const { data: order, error: loadErr } = await supabase
    .schema("aa_01_campaigns")
    .from("raw_orders")
    .select("shopify_order_id, shopify_order_number, email, payload")
    .eq("shopify_order_id", shopify_order_id)
    .maybeSingle();

  if (loadErr) return json({ error: `load failed: ${loadErr.message}` }, 502);
  if (!order)  return json({ error: "order not found" }, 404);

  const payload = (order.payload ?? {}) as Record<string, any>;
  const addr    = (payload.shipping_address ?? {}) as Record<string, any>;
  const items   = Array.isArray(payload.line_items) ? payload.line_items : [];

  const isUS = String(addr.country_code ?? "").toUpperCase() === "US";
  const orderNumber = String(order.shopify_order_number ?? "").replace(/^#/, "");

  const requestBody = {
    order_details: {
      order_id:            orderNumber ? `#${orderNumber}` : `#${shopify_order_id}`,
      email:               order.email ?? addr.email ?? "",
      shipping_type:       isUS ? "Domestic (US)" : "International",
      shipping_first:      addr.first_name ?? "",
      shipping_last:       addr.last_name ?? "",
      shipping_address_1:  addr.address1 ?? "",
      shipping_address_2:  addr.address2 ?? "",
      shipping_zip:        addr.zip ?? "",
      shipping_city:       addr.city ?? "",
      shipping_province:   addr.province_code ?? addr.province ?? "",
      shipping_country:    addr.country ?? "",
      skus_product_details: items.map((li: any) => ({
        sku:           li.sku ?? "",
        product_name:  li.title ?? "",
        variant_title: li.variant_title ?? "",
        quantity:      Number(li.quantity ?? 1),
      })),
    },
  };

  let response_status: number | null = null;
  let response_body:   string | null = null;
  let error_message:   string | null = null;

  try {
    const r = await fetch(ACUTRACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    response_status = r.status;
    response_body   = await r.text().catch(() => null);
  } catch (e) {
    error_message = String(e).slice(0, 500);
  }

  const { error: logErr } = await supabase
    .schema("aa_01_campaigns")
    .from("acutrack_send_log")
    .insert({
      shopify_order_id:     order.shopify_order_id,
      shopify_order_number: order.shopify_order_number,
      triggered_by,
      request_body:         requestBody,
      response_status,
      response_body,
      error_message,
    });
  if (logErr) {
    console.error("[acutrack-send-order] audit log insert failed", logErr);
  }

  const ok = !error_message && response_status !== null && response_status >= 200 && response_status < 300;
  return json({ ok, status: response_status, error: error_message });
});
