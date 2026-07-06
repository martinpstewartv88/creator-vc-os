'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase-browser'
import Link from 'next/link'
import { useAuth } from './AuthProvider'
import { formatErrorMessage } from '@/lib/format-error'

type CampaignDetail = { campaign_name: string; campaign_id: number; legacy_code: string; source: string }

// Friendly display labels for the source badge. Anything not in the map
// falls back to a capitalised version of the raw string.
const SOURCE_LABEL: Record<string, string> = {
  shopify:        'Shopify',
  shopify_legacy: 'Shopify (legacy)',
  gumroad:        'Gumroad',
  wix:            'Wix',
  isod:           'ISOD',
  raw_order:      'Shopify',
  campaign_order: 'Campaign',
}
function sourceLabel(source: string): string {
  if (SOURCE_LABEL[source]) return SOURCE_LABEL[source]
  return source.charAt(0).toUpperCase() + source.slice(1).replace(/_/g, ' ')
}
type OrderLine = {
  product_name: string
  variant_name: string | null
  quantity: number
  price_paid: number | null
  // order_id is the internal/long ref (Shopify GID, ISOD internal id).
  // order_number is the human-readable one we render — shopify_order_number
  // for Shopify, purchase_order_number for ISOD. Falls back to order_id
  // for entitlement-path rows where no friendlier value exists.
  order_id: string
  order_number: string | null
  purchase_type: string
  financial_status: string | null
  delivery_status: 'pending_shipping' | 'shipping_paid' | 'dispatched' | 'digital' | null
  // ISO timestamp of when the backer placed the order (shopify.processed_at,
  // historic.order_created_at, entitlement.created_at). Nullable in case a
  // legacy row is missing all three.
  order_date: string | null
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

const DELIVERY_LABEL: Record<string, string> = {
  pending_shipping: 'Pending Shipping Payment',
  shipping_paid:    'Shipping Paid',
  dispatched:       'Dispatched',
  digital:          'Digital',
}

// Tailwind classes for each delivery state — kept inline rather than
// dynamic so the JIT picks them up.
const DELIVERY_CLASS: Record<string, string> = {
  pending_shipping: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  shipping_paid:    'bg-sky-500/15 text-sky-300 border-sky-500/30',
  dispatched:       'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  digital:          'bg-violet-500/15 text-violet-300 border-violet-500/30',
}

const PAYMENT_LABEL: Record<string, string> = {
  paid:               'Paid',
  refunded:           'Refunded',
  partially_refunded: 'Partial refund',
  pending:            'Pending',
  voided:             'Voided',
  authorized:         'Authorized',
}
function paymentLabel(status: string | null): string {
  if (!status) return '—'
  return PAYMENT_LABEL[status] ?? status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' ')
}

function fmt(n: number | string | null, currency = false) {
  if (n === null || n === undefined) return '—'
  const num = typeof n === 'string' ? parseFloat(n) : n
  if (isNaN(num)) return '—'
  if (currency) return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(num)
  return new Intl.NumberFormat('en-US').format(num)
}

// Prefer the human-readable order_number; fall back to order_id if
// the RPC returned no friendlier value (entitlement-path rows).
function displayOrderRef(line: OrderLine): string {
  return line.order_number?.trim() || line.order_id
}

// Group lines by Order # (falling back to order_id), preserving the
// RPC's incoming order — it ORDERs by order_number nulls last.
function groupByOrder(lines: OrderLine[]): { ref: string; lines: OrderLine[] }[] {
  const groups = new Map<string, OrderLine[]>()
  for (const line of lines) {
    const ref = displayOrderRef(line)
    const existing = groups.get(ref)
    if (existing) existing.push(line)
    else groups.set(ref, [line])
  }
  return Array.from(groups, ([ref, lines]) => ({ ref, lines }))
}

function HeaderCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wide">{label}</span>
      <div className="flex items-center">{children}</div>
    </div>
  )
}

function OrderHeader({
  ref,
  line,
  ownerControls,
}: {
  ref: string
  line: OrderLine
  // When a staff user is viewing a Shopify (raw_orders) row, the caller
  // passes in a busy flag + handlers so we can show a manual mark /
  // unmark action alongside the shipping badge. Non-staff sessions and
  // non-shopify rows get `undefined` and see the read-only header.
  ownerControls?: {
    busy: boolean
    onMarkPaid: () => Promise<void>
    onUnmark: () => Promise<void>
  }
}) {
  const deliveryLabel = line.delivery_status ? DELIVERY_LABEL[line.delivery_status] : '—'
  const deliveryClass = line.delivery_status ? DELIVERY_CLASS[line.delivery_status] : 'bg-zinc-800 text-zinc-400 border-zinc-700'
  const showMark   = ownerControls && line.delivery_status === 'pending_shipping'
  const showUnmark = ownerControls && line.delivery_status === 'shipping_paid'
  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto] gap-4 md:gap-6 px-6 py-3 bg-zinc-900/60 border-b border-zinc-800/60">
      <HeaderCell label="Order Number">
        <span className="font-mono text-xs text-zinc-300 truncate">{ref}</span>
      </HeaderCell>
      <HeaderCell label="Order Date">
        <span className="text-xs text-zinc-300 whitespace-nowrap">{fmtDate(line.order_date)}</span>
      </HeaderCell>
      <HeaderCell label="Payment Status">
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-zinc-800 text-zinc-300 uppercase tracking-wide">
          {paymentLabel(line.financial_status)}
        </span>
      </HeaderCell>
      <HeaderCell label="Shipping Status">
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border uppercase tracking-wide ${deliveryClass}`}>
            {deliveryLabel}
          </span>
          {showMark && (
            <button
              type="button"
              disabled={ownerControls!.busy}
              onClick={(e) => {
                e.stopPropagation()
                void ownerControls!.onMarkPaid()
              }}
              className="text-[10px] font-medium px-2 py-0.5 rounded border border-sky-500/40 text-sky-300 hover:text-white hover:bg-sky-500/20 transition-colors disabled:opacity-50"
              title="Mark this order's shipping as paid via an off-poll channel."
            >
              {ownerControls!.busy ? '…' : 'Mark shipping paid'}
            </button>
          )}
          {showUnmark && (
            <button
              type="button"
              disabled={ownerControls!.busy}
              onClick={(e) => {
                e.stopPropagation()
                void ownerControls!.onUnmark()
              }}
              className="text-[10px] font-medium px-2 py-0.5 rounded border border-zinc-700 text-zinc-400 hover:text-white hover:border-zinc-500 transition-colors disabled:opacity-50"
              title="Remove a manual shipping-paid mark (no-op if none exists)."
            >
              {ownerControls!.busy ? '…' : 'Unmark'}
            </button>
          )}
        </div>
      </HeaderCell>
    </div>
  )
}

function OrderLinesTable({ lines, isIsod }: { lines: OrderLine[]; isIsod: boolean }) {
  if (isIsod) {
    return (
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-zinc-800/50">
            <th className="text-left px-8 py-2 text-zinc-500 font-medium">SKU</th>
            <th className="text-right px-6 py-2 text-zinc-500 font-medium">Price</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, i) => (
            <tr key={i} className="border-b border-zinc-800/30 last:border-0">
              <td className="px-8 py-2.5 font-mono text-zinc-300">{line.product_name}</td>
              <td className="px-6 py-2.5 text-right text-zinc-300">
                {line.price_paid !== null ? fmt(line.price_paid, true) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b border-zinc-800/50">
          <th className="text-left px-8 py-2 text-zinc-500 font-medium">Product</th>
          <th className="text-left px-4 py-2 text-zinc-500 font-medium">Variant</th>
          <th className="text-right px-4 py-2 text-zinc-500 font-medium">Qty</th>
          <th className="text-right px-6 py-2 text-zinc-500 font-medium">Price</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line, i) => (
          <tr key={i} className="border-b border-zinc-800/30 last:border-0">
            <td className="px-8 py-2.5 text-zinc-300">{line.product_name}</td>
            <td className="px-4 py-2.5 text-zinc-500">{line.variant_name || '—'}</td>
            <td className="px-4 py-2.5 text-right text-zinc-400">{line.quantity}</td>
            <td className="px-6 py-2.5 text-right text-zinc-300">
              {line.price_paid !== null ? fmt(line.price_paid, true) : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function OrdersTable({
  lines,
  ownerHooks,
}: {
  lines: OrderLine[]
  // Only supplied when the current viewer is a staff user (admin / team
  // / support). Undefined for everyone else so the manual-mark buttons
  // never render.
  ownerHooks?: {
    busyOrderId: string | null
    onMarkPaid: (orderId: string, orderRef: string) => Promise<void>
    onUnmark:   (orderId: string, orderRef: string) => Promise<void>
  }
}) {
  if (lines.length === 0) {
    return <p className="px-8 py-4 text-xs text-zinc-500">No order details found for this campaign.</p>
  }
  const orders = groupByOrder(lines)
  return (
    <div>
      {orders.map(({ ref, lines: orderLines }) => {
        const isIsod = orderLines.every(l => l.purchase_type === 'isod')
        // Manual shipping marks only apply to Shopify (raw_orders) rows.
        // ISOD / historic branches hard-code delivery_status='dispatched'
        // in the RPC, so this check is defensive but keeps the button
        // from ever appearing on rows where it wouldn't take effect.
        const headLine = orderLines[0]
        const canMark =
          !!ownerHooks &&
          headLine.purchase_type === 'shopify' &&
          !!headLine.order_id
        return (
          <div key={ref} className="border-b border-zinc-800/40 last:border-0">
            <OrderHeader
              ref={ref}
              line={headLine}
              ownerControls={canMark
                ? {
                    busy: ownerHooks!.busyOrderId === headLine.order_id,
                    onMarkPaid: () => ownerHooks!.onMarkPaid(headLine.order_id, ref),
                    onUnmark:   () => ownerHooks!.onUnmark(headLine.order_id, ref),
                  }
                : undefined}
            />
            <OrderLinesTable lines={orderLines} isIsod={isIsod} />
          </div>
        )
      })}
    </div>
  )
}

export default function CustomerCampaigns({
  campaigns,
  email,
  initialCampaignId,
}: {
  campaigns: CampaignDetail[]
  email: string
  initialCampaignId?: number
}) {
  const [tab, setTab] = useState<'this' | 'all'>(initialCampaignId ? 'this' : 'all')
  const [expanded, setExpanded] = useState<number | null>(null)
  const [orders, setOrders] = useState<Record<number, OrderLine[]>>({})
  const [fetchErrors, setFetchErrors] = useState<Record<number, string>>({})
  const [loading, setLoading] = useState<number | null>(null)
  // Which order id is currently mid-mark/unmark, so we can disable the
  // button + show a spinner without blocking any other row.
  const [markBusyOrderId, setMarkBusyOrderId] = useState<string | null>(null)
  const supabase = createClient()
  const { role } = useAuth()
  // Mark/unmark shipping-paid is now open to any staff role. The DB
  // RPCs enforce the same gate so a role change alone can't widen
  // access without a matching migration.
  const canManageMarks = role === 'admin' || role === 'team' || role === 'support'

  const focusCampaign = initialCampaignId
    ? campaigns.find(c => c.campaign_id === initialCampaignId)
    : undefined

  async function fetchOrders(campaignId: number, opts: { force?: boolean } = {}) {
    if (!opts.force && orders[campaignId] !== undefined) return
    setLoading(campaignId)
    try {
      const { data, error } = await supabase.rpc('get_customer_campaign_orders', {
        p_email: email,
        p_campaign_id: campaignId,
      })
      if (error) {
        console.error('[fetchOrders] Supabase RPC error for campaign', campaignId, error)
        setFetchErrors(prev => ({ ...prev, [campaignId]: `${error.code ?? ''}: ${error.message}` }))
        setOrders(prev => ({ ...prev, [campaignId]: [] }))
      } else {
        setOrders(prev => ({ ...prev, [campaignId]: (data ?? []) as OrderLine[] }))
        setFetchErrors(prev => {
          if (prev[campaignId] === undefined) return prev
          const next = { ...prev }
          delete next[campaignId]
          return next
        })
      }
    } finally {
      setLoading(null)
    }
  }

  // Force-refetch a campaign's orders regardless of cached state. Used
  // after a manual mark/unmark so the just-flipped row's delivery_status
  // reconciles against the DB rather than trusting an optimistic update.
  async function refetchCampaign(campaignId: number) {
    return fetchOrders(campaignId, { force: true })
  }

  // Build a per-campaign owner-hooks bundle to hand down to OrdersTable.
  // Non-owners get undefined so buttons never render.
  function ownerHooksFor(campaignId: number) {
    if (!canManageMarks) return undefined
    return {
      busyOrderId: markBusyOrderId,
      onMarkPaid: async (orderId: string, orderRef: string) => {
        if (!window.confirm(`Mark shipping as paid for order ${orderRef}?`)) return
        const note = window.prompt(
          'Reason (optional — e.g. "PayPal, pre-poll" or "paid via Glide 2026-05-29"):',
          '',
        )
        if (note === null) return  // user cancelled the prompt
        setMarkBusyOrderId(orderId)
        try {
          const { error } = await supabase.rpc('set_shipping_paid_mark', {
            p_shopify_order_id: orderId,
            p_note: note.trim() ? note.trim() : null,
          })
          if (error) throw error
          // Fire-and-forget: notify Acutrack so they can queue the order
          // for dispatch. Failures are logged server-side in
          // aa_01_campaigns.acutrack_send_log but never block the mark.
          void supabase.functions
            .invoke('acutrack-send-order', { body: { shopify_order_id: orderId } })
            .catch((err) => console.warn('[acutrack-send-order] invoke failed', err))
          await refetchCampaign(campaignId)
        } catch (e) {
          alert(`Mark shipping paid failed: ${formatErrorMessage(e)}`)
        } finally {
          setMarkBusyOrderId(null)
        }
      },
      onUnmark: async (orderId: string, orderRef: string) => {
        if (!window.confirm(`Remove manual shipping-paid mark for order ${orderRef}? (No-op if none exists.)`)) return
        setMarkBusyOrderId(orderId)
        try {
          const { error } = await supabase.rpc('clear_shipping_paid_mark', {
            p_shopify_order_id: orderId,
          })
          if (error) throw error
          await refetchCampaign(campaignId)
        } catch (e) {
          alert(`Unmark failed: ${formatErrorMessage(e)}`)
        } finally {
          setMarkBusyOrderId(null)
        }
      },
    }
  }

  // Auto-load orders for the focus campaign when on "this" tab
  useEffect(() => {
    if (initialCampaignId && tab === 'this') {
      fetchOrders(initialCampaignId)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCampaignId, tab])

  async function toggleCampaign(campaignId: number) {
    if (expanded === campaignId) {
      setExpanded(null)
      return
    }
    setExpanded(campaignId)
    fetchOrders(campaignId)
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl">
      {/* Tab bar — only show tabs when arriving from a campaign */}
      {focusCampaign ? (
        <div className="flex items-center px-6 pt-4 border-b border-zinc-800 gap-1">
          <button
            onClick={() => setTab('this')}
            className={`px-4 py-2 text-sm font-medium rounded-t-md transition-colors ${
              tab === 'this'
                ? 'text-white border-b-2 border-white pb-[calc(0.5rem-2px)]'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {focusCampaign.campaign_name}
          </button>
          <button
            onClick={() => setTab('all')}
            className={`px-4 py-2 text-sm font-medium rounded-t-md transition-colors ${
              tab === 'all'
                ? 'text-white border-b-2 border-white pb-[calc(0.5rem-2px)]'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            All Campaigns
          </button>
        </div>
      ) : (
        <div className="px-6 py-4 border-b border-zinc-800">
          <h2 className="text-sm font-semibold text-white">Campaigns Supported</h2>
          <p className="text-xs text-zinc-500 mt-0.5">Click a campaign to see what was ordered</p>
        </div>
      )}

      {/* This Campaign tab */}
      {focusCampaign && tab === 'this' && (
        <div>
          <div className="px-6 py-3 border-b border-zinc-800/50 bg-zinc-950/40">
            <p className="text-xs text-zinc-500 uppercase tracking-wide font-medium">{focusCampaign.campaign_name}</p>
          </div>
          {loading === initialCampaignId ? (
            <p className="px-8 py-6 text-xs text-zinc-500 animate-pulse">Loading orders…</p>
          ) : fetchErrors[initialCampaignId!] ? (
            <p className="px-8 py-6 text-xs text-red-400">Error: {fetchErrors[initialCampaignId!]}</p>
          ) : orders[initialCampaignId!] !== undefined ? (
            <OrdersTable lines={orders[initialCampaignId!]} ownerHooks={ownerHooksFor(initialCampaignId!)} />
          ) : (
            <p className="px-8 py-6 text-xs text-zinc-500 animate-pulse">Loading orders…</p>
          )}
        </div>
      )}

      {/* All Campaigns tab (or default when no focus campaign) */}
      {(!focusCampaign || tab === 'all') && (
        <>
          {!focusCampaign && (
            <div></div>
          )}
          {campaigns.length > 0 ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800">
                  <th className="text-left px-6 py-3 text-xs font-medium text-zinc-500">Campaign</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-zinc-500">Code</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-zinc-500">Source</th>
                  <th className="w-8"></th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((camp) => (
                  <>
                    <tr
                      key={camp.campaign_id}
                      onClick={() => toggleCampaign(camp.campaign_id)}
                      className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors cursor-pointer"
                    >
                      <td className="px-6 py-3.5 font-medium text-white">{camp.campaign_name}</td>
                      <td className="px-6 py-3.5 text-zinc-400 font-mono text-xs">{camp.legacy_code}</td>
                      <td className="px-6 py-3.5">
                        <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-zinc-800 text-zinc-300">
                          {sourceLabel(camp.source)}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 text-zinc-500 text-xs">
                        {loading === camp.campaign_id ? (
                          <span className="animate-pulse">…</span>
                        ) : (
                          <span>{expanded === camp.campaign_id ? '▲' : '▼'}</span>
                        )}
                      </td>
                    </tr>

                    {expanded === camp.campaign_id && (
                      <tr key={`${camp.campaign_id}-orders`} className="border-b border-zinc-800/50 bg-zinc-950/60">
                        <td colSpan={4} className="px-0 py-0">
                          {loading === camp.campaign_id ? (
                            <p className="px-8 py-4 text-xs text-zinc-500 animate-pulse">Loading orders…</p>
                          ) : fetchErrors[camp.campaign_id] ? (
                            <p className="px-8 py-4 text-xs text-red-400">Error: {fetchErrors[camp.campaign_id]}</p>
                          ) : orders[camp.campaign_id] !== undefined ? (
                            <OrdersTable lines={orders[camp.campaign_id]} ownerHooks={ownerHooksFor(camp.campaign_id)} />
                          ) : (
                            <p className="px-8 py-4 text-xs text-zinc-500">No order details found.</p>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="px-6 py-8 text-center text-zinc-500 text-sm">No campaigns found</p>
          )}
        </>
      )}
    </div>
  )
}
