import { createClient } from '@/lib/supabase-server'
import { getCurrentRole } from '@/lib/auth-server'
import { getCampaignProducts, type CampaignProductRow } from '@/lib/supabase'
import CatalogueClient from '@/components/catalogue/CatalogueClient'
import type { Campaign, Product, Variant, UnroutedSuffix } from '@/components/catalogue/types'

export const dynamic = 'force-dynamic'

// The "Name" column has a capital N (quoted identifier). PostgREST is
// case-sensitive on identifiers, so we alias to lowercase `name` for the
// JS side — keeps the client component clean.
const CAMPAIGN_COLS = 'id, name:"Name", legacy_code'
const PRODUCT_COLS = 'id, campaign_id, name:"Name", legacy_code, requires_address, notes'
const VARIANT_COLS = 'id, campaign_id, product_id, name:"Name", legacy_code, default_price, currency, source_type'

export default async function CataloguePage() {
  const supabase = await createClient()
  // Role decides delete-button visibility — admin sees Trash2 buttons,
  // team gets read + create + update only (CRU not D). Enforced in the
  // UI per the role rule; underlying products/variants tables remain
  // server-writable for any authenticated user, so this is a UX
  // boundary not a security one. DB-level enforcement (RLS or a
  // SECURITY DEFINER delete RPC gated on admin) would be a follow-up.
  const role = await getCurrentRole()

  const [campaignsRes, productsRes, variantsRes, inboxCountRes, mapRes, unroutedRes] = await Promise.all([
    supabase.schema('aa_01_campaigns').from('campaigns').select(CAMPAIGN_COLS).order('id'),
    supabase.schema('aa_01_campaigns').from('products').select(PRODUCT_COLS).order('id'),
    supabase.schema('aa_01_campaigns').from('variants').select(VARIANT_COLS).order('id'),
    supabase
      .schema('aa_01_campaigns')
      .from('shopify_product_inbox')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending'),
    supabase
      .schema('aa_01_campaigns')
      .from('shopify_variants_map')
      .select('variant_legacy_code'),
    supabase.rpc('list_unrouted_order_suffixes'),
  ])
  if (unroutedRes.error) console.error('[catalogue] list_unrouted_order_suffixes failed', unroutedRes.error)

  // Build a set of variant legacy_codes that have at least one Shopify mapping.
  const mappedLegacyCodes = new Set<string>(
    ((mapRes.data ?? []) as { variant_legacy_code: string | null }[])
      .map((r) => r.variant_legacy_code)
      .filter((c): c is string => !!c),
  )

  // "Observed in source data" — the same per-campaign products RPC the
  // campaign detail page uses (live Shopify lines + historic CSV imports
  // + ISOD lines). Surfaced read-only inside each accordion so curated
  // catalogue + observed reality sit side-by-side without polluting
  // each other. ~100 rows max per campaign (RPC caps at top-100 by units),
  // and the wrapper is cached 60s per campaign — fanning out across all
  // campaigns in parallel stays under 100ms total.
  const campaignsList = (campaignsRes.data ?? []) as Campaign[]
  const observedByCampaign: Record<number, CampaignProductRow[]> = {}
  await Promise.all(
    campaignsList.map(async (c) => {
      try {
        observedByCampaign[c.id] = await getCampaignProducts(c.id)
      } catch (e) {
        console.error(`[catalogue] getCampaignProducts(${c.id}) failed`, e)
        observedByCampaign[c.id] = []
      }
    }),
  )

  return (
    <CatalogueClient
      role={role}
      campaigns={campaignsList}
      products={(productsRes.data ?? []) as Product[]}
      variants={(variantsRes.data ?? []) as Variant[]}
      mappedLegacyCodes={Array.from(mappedLegacyCodes)}
      observedByCampaign={observedByCampaign}
      pendingInboxCount={inboxCountRes.count ?? 0}
      unroutedSuffixes={(unroutedRes.data ?? []) as UnroutedSuffix[]}
      unroutedError={unroutedRes.error ? `Couldn't check for unrouted orders: ${unroutedRes.error.message}` : null}
      errors={{
        campaigns: campaignsRes.error?.message ?? null,
        products: productsRes.error?.message ?? null,
        variants: variantsRes.error?.message ?? null,
      }}
    />
  )
}
