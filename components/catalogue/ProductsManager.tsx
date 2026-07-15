'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown, ChevronRight, Plus, Pencil, Trash2, Copy, X, Eye } from 'lucide-react'
import { createClient } from '@/lib/supabase-browser'
import { formatErrorMessage } from '@/lib/format-error'
import type { Role } from '@/lib/auth'
import type { CampaignProductRow } from '@/lib/supabase'
import type { Campaign, Product, Variant } from './types'

const SOURCE_LABEL: Record<string, string> = {
  shopify: 'Shopify',
  shopify_legacy: 'Shopify (legacy)',
  gumroad: 'Gumroad',
  wix: 'Wix',
  isod: 'ISOD',
}
// Translate a raw PostgREST error into something readable for the product
// save modal. We special-case the legacy_code unique-constraint hit —
// bare Postgres error names the constraint, not the offending row, so
// operators had no way to know which product was hoarding the code.
// Falls through to formatErrorMessage for everything else.
async function friendlyProductError(e: unknown, legacy: string): Promise<string> {
  const obj = (e && typeof e === 'object') ? (e as Record<string, unknown>) : {}
  const code = typeof obj.code === 'string' ? obj.code : null
  const msg  = typeof obj.message === 'string' ? obj.message : ''
  if (code === '23505' && (msg.includes('legacy_code') || msg.includes('products_legacy_code_key'))) {
    try {
      const supabase = createClient()
      const { data } = await supabase
        .schema('aa_01_campaigns')
        .from('products')
        .select('Name, campaign_id, campaigns:campaigns(Name)')
        .eq('legacy_code', legacy)
        .maybeSingle()
      if (data) {
        const owner = (data as { Name?: string }).Name || 'another product'
        const camp  = (data as { campaigns?: { Name?: string } | null }).campaigns?.Name
                    || `campaign #${(data as { campaign_id?: number }).campaign_id ?? '?'}`
        return `Legacy code "${legacy}" is already used by "${owner}" in ${camp}. Pick a different code.`
      }
    } catch { /* fall through to generic */ }
    return `Legacy code "${legacy}" is already in use on another product. Pick a different code.`
  }
  return formatErrorMessage(e)
}

function sourceLabel(s: string): string {
  return SOURCE_LABEL[s] ?? s.charAt(0).toUpperCase() + s.slice(1)
}
function sourceBadgeClass(s: string): string {
  switch (s) {
    case 'shopify':         return 'bg-zinc-800 text-zinc-300'
    case 'shopify_legacy':  return 'bg-amber-900/40 text-amber-200'
    case 'gumroad':         return 'bg-emerald-900/40 text-emerald-200'
    case 'wix':             return 'bg-purple-900/40 text-purple-200'
    case 'isod':            return 'bg-blue-900/40 text-blue-200'
    default:                return 'bg-zinc-800 text-zinc-400'
  }
}
const numFmt = new Intl.NumberFormat('en-US')
const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

type EditMode =
  | null
  | { type: 'new-product'; campaignId: number }
  | { type: 'edit-product'; product: Product }
  | { type: 'clone-product'; campaignId: number }
  | { type: 'new-variant'; campaignId: number; productId: number }
  | { type: 'edit-variant'; variant: Variant }

export default function ProductsManager({
  role,
  campaigns,
  products,
  variants,
  mappedLegacyCodes,
  observedByCampaign,
}: {
  role: Role
  campaigns: Campaign[]
  products: Product[]
  variants: Variant[]
  mappedLegacyCodes: Set<string>
  observedByCampaign: Record<number, CampaignProductRow[]>
}) {
  const showRevenue = role === 'admin'
  const router = useRouter()
  // All campaigns start collapsed. Previously we eagerly expanded every
  // campaign in the list, which made the page noisy as the campaign
  // catalogue grew — Robin's view ran several screens tall before the
  // user could orient. Empty Set → user clicks to drill in.
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [edit, setEdit] = useState<EditMode>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Delete is admin-only per the CRU-not-D rule. Team users see the
  // accordion + edit pencils but no Trash2 buttons.
  const canDelete = role === 'admin'

  function toggle(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function deleteProduct(p: Product) {
    if (!confirm(`Delete "${p.name}" and all its variants? This cannot be undone.`)) return
    setBusy(true)
    setError(null)
    try {
      const supabase = createClient()
      // Delete child variants first (no ON DELETE CASCADE on this FK in production).
      const { error: vErr } = await supabase
        .schema('aa_01_campaigns')
        .from('variants')
        .delete()
        .eq('product_id', p.id)
      if (vErr) throw vErr
      const { error: pErr } = await supabase
        .schema('aa_01_campaigns')
        .from('products')
        .delete()
        .eq('id', p.id)
      if (pErr) throw pErr
      router.refresh()
    } catch (e) {
      setError(formatErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  async function deleteVariant(v: Variant) {
    if (!confirm(`Delete variant "${v.name}"?`)) return
    setBusy(true)
    setError(null)
    try {
      const supabase = createClient()
      const { error: dErr } = await supabase
        .schema('aa_01_campaigns')
        .from('variants')
        .delete()
        .eq('id', v.id)
      if (dErr) throw dErr
      router.refresh()
    } catch (e) {
      setError(formatErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="bg-red-950/40 border border-red-900/60 rounded-xl px-4 py-3">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      {campaigns.map((campaign) => {
        const camPgProducts = products.filter((p) => p.campaign_id === campaign.id)
        const isOpen = expanded.has(campaign.id)
        return (
          <div key={campaign.id} className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <button
              onClick={() => toggle(campaign.id)}
              className="w-full flex items-center justify-between px-5 py-4 hover:bg-zinc-800/40 transition-colors"
            >
              <div className="flex items-center gap-3">
                {isOpen ? <ChevronDown size={16} className="text-zinc-500" /> : <ChevronRight size={16} className="text-zinc-500" />}
                <div className="text-left">
                  <p className="text-sm font-semibold text-white">{campaign.name}</p>
                  <p className="text-xs text-zinc-500 mt-0.5 font-mono">
                    {campaign.legacy_code} · {camPgProducts.length} product{camPgProducts.length === 1 ? '' : 's'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                {/* Clone an existing product (from any campaign) into
                    this one. Useful for reusing merch SKUs that ship
                    across multiple campaigns. Variants must be added
                    separately after cloning. */}
                <span
                  onClick={(e) => {
                    e.stopPropagation()
                    setEdit({ type: 'clone-product', campaignId: campaign.id })
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-zinc-800 text-zinc-200 hover:bg-zinc-700 transition-colors cursor-pointer"
                  title="Clone an existing product into this campaign"
                >
                  <Copy size={13} />
                  Clone
                </span>
                <span
                  onClick={(e) => {
                    e.stopPropagation()
                    setEdit({ type: 'new-product', campaignId: campaign.id })
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-md bg-[#3B9EE8] text-white hover:bg-[#2d8ed8] transition-colors cursor-pointer"
                >
                  <Plus size={14} />
                  Product
                </span>
              </div>
            </button>

            {isOpen && (
              <div className="border-t border-zinc-800">
                {camPgProducts.length === 0 ? (
                  <p className="px-6 py-8 text-center text-sm text-zinc-500">No products yet.</p>
                ) : (
                  camPgProducts.map((p) => (
                    <ProductBlock
                      key={p.id}
                      product={p}
                      variants={variants.filter((v) => v.product_id === p.id)}
                      mappedLegacyCodes={mappedLegacyCodes}
                      busy={busy}
                      canDelete={canDelete}
                      onEditProduct={() => setEdit({ type: 'edit-product', product: p })}
                      onDeleteProduct={() => deleteProduct(p)}
                      onAddVariant={() => setEdit({ type: 'new-variant', campaignId: p.campaign_id, productId: p.id })}
                      onEditVariant={(v) => setEdit({ type: 'edit-variant', variant: v })}
                      onDeleteVariant={(v) => deleteVariant(v)}
                    />
                  ))
                )}
                <ObservedPanel
                  rows={observedByCampaign[campaign.id] ?? []}
                  showRevenue={showRevenue}
                />
              </div>
            )}
          </div>
        )
      })}

      {edit && (
        <EditDrawer
          mode={edit}
          campaigns={campaigns}
          products={products}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null)
            router.refresh()
          }}
        />
      )}
    </div>
  )
}

function ProductBlock({
  product,
  variants,
  mappedLegacyCodes,
  busy,
  canDelete,
  onEditProduct,
  onDeleteProduct,
  onAddVariant,
  onEditVariant,
  onDeleteVariant,
}: {
  product: Product
  variants: Variant[]
  mappedLegacyCodes: Set<string>
  busy: boolean
  canDelete: boolean
  onEditProduct: () => void
  onDeleteProduct: () => void
  onAddVariant: () => void
  onEditVariant: (v: Variant) => void
  onDeleteVariant: (v: Variant) => void
}) {
  return (
    <div className="border-b border-zinc-800/60 last:border-0">
      <div className="flex items-start justify-between gap-4 px-6 py-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white">{product.name}</p>
          <p className="text-xs text-zinc-500 mt-0.5 font-mono">{product.legacy_code}</p>
          <div className="flex flex-wrap gap-2 mt-2">
            {product.requires_address && (
              <span className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">Ships</span>
            )}
          </div>
          {product.notes && <p className="text-xs text-zinc-500 mt-2 italic">{product.notes}</p>}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={onAddVariant}
            disabled={busy}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition-colors disabled:opacity-50"
            title="Add variant"
          >
            <Plus size={12} />
            Variant
          </button>
          <button
            onClick={onEditProduct}
            disabled={busy}
            className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors disabled:opacity-50"
            title="Edit product"
          >
            <Pencil size={14} />
          </button>
          {canDelete && (
            <button
              onClick={onDeleteProduct}
              disabled={busy}
              className="p-1.5 rounded-md text-zinc-500 hover:text-red-400 hover:bg-red-950/40 transition-colors disabled:opacity-50"
              title="Delete product"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
      {variants.length > 0 && (
        <table className="w-full text-xs">
          <tbody>
            {variants.map((v) => {
              const mapped = mappedLegacyCodes.has(v.legacy_code)
              return (
                <tr key={v.id} className="border-t border-zinc-800/40 hover:bg-zinc-800/20 transition-colors">
                  <td className="pl-12 pr-4 py-2.5 w-2">
                    <span
                      className={`inline-block w-2 h-2 rounded-full ${
                        mapped ? 'bg-emerald-500' : 'bg-amber-500'
                      }`}
                      title={mapped ? 'Mapped to a Shopify variant' : 'No Shopify mapping yet'}
                    />
                  </td>
                  <td className="px-2 py-2.5 text-zinc-300">{v.name}</td>
                  <td className="px-2 py-2.5 text-zinc-500 font-mono">{v.legacy_code}</td>
                  <td className="px-2 py-2.5 text-zinc-500 tabular-nums">
                    {v.default_price !== null ? `${v.default_price} ${v.currency ?? ''}`.trim() : '—'}
                  </td>
                  <td className="px-2 py-2.5 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        onClick={() => onEditVariant(v)}
                        disabled={busy}
                        className="p-1 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors disabled:opacity-50"
                      >
                        <Pencil size={12} />
                      </button>
                      {canDelete && (
                        <button
                          onClick={() => onDeleteVariant(v)}
                          disabled={busy}
                          className="p-1 rounded-md text-zinc-500 hover:text-red-400 hover:bg-red-950/40 transition-colors disabled:opacity-50"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ── Edit drawer ─────────────────────────────────────────────────────────────
function EditDrawer({
  mode,
  campaigns,
  products,
  onClose,
  onSaved,
}: {
  mode: NonNullable<EditMode>
  campaigns: Campaign[]
  products: Product[]
  onClose: () => void
  onSaved: () => void
}) {
  const isProduct = mode.type === 'new-product' || mode.type === 'edit-product'
  const isClone = mode.type === 'clone-product'
  const isVariant = mode.type === 'new-variant' || mode.type === 'edit-variant'

  const title =
    mode.type === 'new-product'
      ? 'New product'
      : mode.type === 'edit-product'
      ? 'Edit product'
      : mode.type === 'clone-product'
      ? 'Clone existing product'
      : mode.type === 'new-variant'
      ? 'New variant'
      : 'Edit variant'

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <aside className="relative w-full max-w-md h-full bg-zinc-950 border-l border-zinc-800 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-zinc-950/95 backdrop-blur border-b border-zinc-800 px-5 py-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          <button onClick={onClose} className="text-zinc-400 hover:text-white p-1">
            <X size={16} />
          </button>
        </div>
        <div className="p-5">
          {isProduct && (
            <ProductForm
              campaigns={campaigns}
              initial={
                mode.type === 'edit-product'
                  ? mode.product
                  : { campaign_id: (mode as { campaignId: number }).campaignId }
              }
              onSaved={onSaved}
            />
          )}
          {isClone && (
            <CloneProductForm
              campaigns={campaigns}
              products={products}
              targetCampaignId={(mode as { campaignId: number }).campaignId}
              onSaved={onSaved}
            />
          )}
          {isVariant && (
            <VariantForm
              products={products}
              initial={
                mode.type === 'edit-variant'
                  ? mode.variant
                  : {
                      campaign_id: (mode as { campaignId: number }).campaignId,
                      product_id: (mode as { productId: number }).productId,
                    }
              }
              onSaved={onSaved}
            />
          )}
        </div>
      </aside>
    </div>
  )
}

function ProductForm({
  campaigns,
  initial,
  onSaved,
}: {
  campaigns: Campaign[]
  initial: Partial<Product> & { campaign_id: number }
  onSaved: () => void
}) {
  const [name, setName] = useState(initial.name ?? '')
  const [legacy, setLegacy] = useState(initial.legacy_code ?? '')
  const [campaignId, setCampaignId] = useState(initial.campaign_id)
  const [requiresAddress, setRequiresAddress] = useState(initial.requires_address ?? true)
  const [notes, setNotes] = useState(initial.notes ?? '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setErr(null)
    try {
      const supabase = createClient()
      const payload = {
        campaign_id: campaignId,
        Name: name.trim(),
        legacy_code: legacy.trim(),
        requires_address: requiresAddress,
        notes: notes.trim() || null,
      }
      if (initial.id) {
        const { error } = await supabase.schema('aa_01_campaigns').from('products').update(payload).eq('id', initial.id)
        if (error) throw error
      } else {
        const { error } = await supabase.schema('aa_01_campaigns').from('products').insert(payload)
        if (error) throw error
      }
      onSaved()
    } catch (e) {
      setErr(await friendlyProductError(e, legacy.trim()))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <Field label="Campaign">
        <select
          value={campaignId}
          onChange={(e) => setCampaignId(Number(e.target.value))}
          className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-sm text-white"
        >
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </Field>
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
      </Field>
      <Field label="Legacy code (uppercase, dash-separated)">
        <input value={legacy} onChange={(e) => setLegacy(e.target.value)} className={`${inputCls} font-mono`} placeholder="ALIENS-EXPANDED" />
      </Field>
      <div className="flex items-center gap-4">
        <Toggle label="Requires shipping address" checked={requiresAddress} onChange={setRequiresAddress} />
      </div>
      <Field label="Notes (optional)">
        <textarea value={notes ?? ''} onChange={(e) => setNotes(e.target.value)} rows={2} className={inputCls} />
      </Field>
      {err && <p className="text-xs text-red-400">{err}</p>}
      <button
        onClick={save}
        disabled={saving || !name.trim() || !legacy.trim()}
        className="w-full px-4 py-2.5 text-sm font-bold rounded-md bg-[#3B9EE8] text-white hover:bg-[#2d8ed8] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {saving ? 'Saving…' : 'Save product'}
      </button>
    </div>
  )
}

function VariantForm({
  products,
  initial,
  onSaved,
}: {
  products: Product[]
  initial: Partial<Variant> & { campaign_id: number; product_id: number }
  onSaved: () => void
}) {
  const [productId, setProductId] = useState(initial.product_id)
  const [name, setName] = useState(initial.name ?? '')
  const [legacy, setLegacy] = useState(initial.legacy_code ?? '')
  const [price, setPrice] = useState(initial.default_price?.toString() ?? '')
  const [currency, setCurrency] = useState(initial.currency ?? 'USD')
  const [sourceType, setSourceType] = useState(initial.source_type ?? 'shopify_product')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Restrict product picker to products in the same campaign — keeps the
  // FK relationship consistent.
  const productsForCampaign = products.filter((p) => p.campaign_id === initial.campaign_id)

  async function save() {
    setSaving(true)
    setErr(null)
    try {
      const supabase = createClient()
      const payload = {
        campaign_id: initial.campaign_id,
        product_id: productId,
        Name: name.trim(),
        legacy_code: legacy.trim(),
        default_price: price.trim() ? Number(price) : null,
        currency: currency.trim() || null,
        source_type: sourceType,
      }
      if (initial.id) {
        const { error } = await supabase.schema('aa_01_campaigns').from('variants').update(payload).eq('id', initial.id)
        if (error) throw error
      } else {
        const { error } = await supabase.schema('aa_01_campaigns').from('variants').insert(payload)
        if (error) throw error
      }
      onSaved()
    } catch (e) {
      setErr(formatErrorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <Field label="Product">
        <select value={productId} onChange={(e) => setProductId(Number(e.target.value))} className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-sm text-white">
          {productsForCampaign.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </Field>
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="Blu-ray Package" />
      </Field>
      <Field label="Legacy code (matches Shopify SKU)">
        <input value={legacy} onChange={(e) => setLegacy(e.target.value)} className={`${inputCls} font-mono`} placeholder="ALIENS-BLU-RAY" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Price">
          <input value={price} onChange={(e) => setPrice(e.target.value)} className={`${inputCls} tabular-nums`} inputMode="decimal" />
        </Field>
        <Field label="Currency">
          <input value={currency} onChange={(e) => setCurrency(e.target.value)} className={inputCls} maxLength={4} />
        </Field>
      </div>
      <Field label="Source type">
        <select value={sourceType} onChange={(e) => setSourceType(e.target.value)} className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-sm text-white">
          <option value="shopify_product">shopify_product</option>
          <option value="post_purchase_upsell">post_purchase_upsell</option>
        </select>
      </Field>
      {err && <p className="text-xs text-red-400">{err}</p>}
      <button
        onClick={save}
        disabled={saving || !name.trim() || !legacy.trim()}
        className="w-full px-4 py-2.5 text-sm font-bold rounded-md bg-[#3B9EE8] text-white hover:bg-[#2d8ed8] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {saving ? 'Saving…' : 'Save variant'}
      </button>
    </div>
  )
}

const inputCls =
  'w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-600'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-medium uppercase tracking-wide text-zinc-500 mb-1.5">{label}</label>
      {children}
    </div>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="rounded border-zinc-700 bg-zinc-900" />
      {label}
    </label>
  )
}

// Read-only mirror of the per-campaign get_campaign_products_v2 RPC.
// Unifies live Shopify lines + historic CSV imports + ISOD lines so the
// catalogue page tells the same product story as the campaign detail
// Products tab — without polluting the editable products table above.
function ObservedPanel({
  rows,
  showRevenue,
}: {
  rows: CampaignProductRow[]
  showRevenue: boolean
}) {
  if (rows.length === 0) return null

  const totalUnits = rows.reduce((s, r) => s + Number(r.units || 0), 0)
  const totalRevenue = rows.reduce((s, r) => s + Number(r.revenue || 0), 0)

  return (
    <div className="border-t border-zinc-800 bg-zinc-950/40">
      <div className="px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Eye size={13} className="text-zinc-500" />
          <p className="text-[11px] uppercase tracking-wide font-semibold text-zinc-400">
            Observed in source data
          </p>
        </div>
        <p className="text-[10px] text-zinc-600">
          Read-only · top {rows.length} by units · live Shopify + historic + ISOD
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-t border-zinc-800/60">
              <th className="text-left px-6 py-2 text-[10px] font-medium text-zinc-500 uppercase tracking-wide">Product / SKU</th>
              <th className="text-left px-2 py-2 text-[10px] font-medium text-zinc-500 uppercase tracking-wide">Variant</th>
              <th className="text-left px-2 py-2 text-[10px] font-medium text-zinc-500 uppercase tracking-wide">Source</th>
              <th className="text-right px-2 py-2 text-[10px] font-medium text-zinc-500 uppercase tracking-wide">Units</th>
              {showRevenue && (
                <th className="text-right px-6 py-2 text-[10px] font-medium text-zinc-500 uppercase tracking-wide">Revenue</th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-zinc-800/40">
                <td className="px-6 py-2 text-zinc-200 font-mono text-[11px]">{r.product_name}</td>
                <td className="px-2 py-2 text-zinc-500">{r.variant_name || '—'}</td>
                <td className="px-2 py-2">
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide ${sourceBadgeClass(r.source_platform)}`}>
                    {sourceLabel(r.source_platform)}
                  </span>
                </td>
                <td className="px-2 py-2 text-right text-zinc-300 tabular-nums">{numFmt.format(Number(r.units || 0))}</td>
                {showRevenue && (
                  <td className="px-6 py-2 text-right text-zinc-300 tabular-nums">{usdFmt.format(Number(r.revenue || 0))}</td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-zinc-800">
              <td className="px-6 py-2 text-[10px] uppercase tracking-wide font-medium text-zinc-500" colSpan={3}>
                Total
              </td>
              <td className="px-2 py-2 text-right text-white font-semibold tabular-nums">{numFmt.format(totalUnits)}</td>
              {showRevenue && (
                <td className="px-6 py-2 text-right text-white font-semibold tabular-nums">{usdFmt.format(totalRevenue)}</td>
              )}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}

// Clone an existing product (from any campaign) into the destination
// campaign. UI flow: pick a source product → see its details read-only
// → type a new globally-unique SKU → submit. Variants are NOT cloned
// in this v1; user adds them separately via the existing "Add Variant"
// affordance on the new product row.
function CloneProductForm({
  campaigns,
  products,
  targetCampaignId,
  onSaved,
}: {
  campaigns: Campaign[]
  products: Product[]
  targetCampaignId: number
  onSaved: () => void
}) {
  // Source candidates: every existing product EXCEPT the ones already
  // in the destination campaign (cloning into the same campaign would
  // be confusing — and the UNIQUE (campaign_id, legacy_code) constraint
  // would refuse most attempts anyway).
  const candidates = products.filter((p) => p.campaign_id !== targetCampaignId)
  const campaignName = (id: number) => campaigns.find((c) => c.id === id)?.name ?? '—'

  const [sourceId, setSourceId] = useState<number | null>(candidates[0]?.id ?? null)
  const [newSku, setNewSku] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const source = sourceId == null ? null : candidates.find((p) => p.id === sourceId) ?? null

  async function save() {
    setSaving(true)
    setErr(null)
    if (!source) {
      setErr('Pick a source product to clone.')
      setSaving(false)
      return
    }
    const supabase = createClient()
    const { error } = await supabase.rpc('clone_product_into_campaign', {
      p_source_product_id: source.id,
      p_target_campaign_id: targetCampaignId,
      p_new_legacy_code: newSku.trim(),
    })
    setSaving(false)
    if (error) {
      // The RPC raises specific codes — 22023 (missing/invalid input),
      // 23505 (legacy_code already exists), 42501 (forbidden). The raw
      // message is human-readable in each case.
      setErr(error.message)
      return
    }
    onSaved()
  }

  if (candidates.length === 0) {
    return (
      <p className="text-xs text-zinc-500">
        No other products exist yet — create one from scratch, then clone from there next time.
      </p>
    )
  }

  return (
    <div className="space-y-5">
      <p className="text-[11px] text-zinc-500">
        Cloning into <span className="text-zinc-300 font-medium">{campaignName(targetCampaignId)}</span>. Variants
        aren&rsquo;t carried over — add them after cloning via the &ldquo;Variant&rdquo; button on the new product.
      </p>

      <Field label="Source product">
        <select
          value={sourceId ?? ''}
          onChange={(e) => setSourceId(e.target.value ? Number(e.target.value) : null)}
          className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-sm text-white"
        >
          {candidates.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.legacy_code} — {campaignName(p.campaign_id)}
            </option>
          ))}
        </select>
      </Field>

      {source && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-md px-3 py-3 space-y-1">
          <p className="text-[10px] uppercase tracking-wide text-zinc-500 font-medium">Will copy:</p>
          <p className="text-xs text-zinc-300"><span className="text-zinc-500">Name:</span> {source.name}</p>
          <p className="text-xs text-zinc-300"><span className="text-zinc-500">Requires address:</span> {source.requires_address ? 'Yes' : 'No'}</p>
          {source.notes && (
            <p className="text-xs text-zinc-300 italic"><span className="text-zinc-500 not-italic">Notes:</span> {source.notes}</p>
          )}
        </div>
      )}

      <Field label="New SKU (legacy code)">
        <input
          type="text"
          value={newSku}
          onChange={(e) => setNewSku(e.target.value)}
          placeholder="e.g. ALIENS-MUG"
          required
          className={inputCls}
        />
        <p className="text-[10px] text-zinc-600 mt-1">
          Must be globally unique. The source&rsquo;s SKU{' '}
          {source && <span className="font-mono text-zinc-400">{source.legacy_code}</span>} can&rsquo;t be reused.
        </p>
      </Field>

      {err && <p className="text-xs text-red-400">{err}</p>}

      <button
        onClick={save}
        disabled={saving || !source || !newSku.trim()}
        className="w-full px-4 py-2.5 text-sm font-bold rounded-md bg-[#3B9EE8] text-white hover:bg-[#2d8ed8] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {saving ? 'Cloning…' : 'Clone product'}
      </button>
    </div>
  )
}
