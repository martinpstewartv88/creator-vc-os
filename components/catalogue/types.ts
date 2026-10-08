export type Campaign = {
  id: number
  name: string
  legacy_code: string | null
}

export type Product = {
  id: number
  campaign_id: number
  name: string
  legacy_code: string
  requires_address: boolean
  notes: string | null
}

export type Variant = {
  id: number
  campaign_id: number
  product_id: number
  name: string
  legacy_code: string
  default_price: number | null
  currency: string | null
  source_type: string
}

export type UnroutedSuffix = {
  suffix: string
  order_count: number
  sample_order_number: string | null
  first_seen: string
  last_seen: string
  current_campaign_id: number | null
  current_campaign_name: string | null
}

export type InboxRow = {
  id: number
  created_at: string
  updated_at: string
  shop_domain: string
  campaign_id: number | null
  shopify_product_id: string
  shopify_variant_id: string
  shopify_product_title: string | null
  shopify_variant_title: string | null
  shopify_sku: string | null
  status: 'pending' | 'matched' | 'created' | 'dismissed'
  resolved_variant_id: number | null
  resolution_note: string | null
}
