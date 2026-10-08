'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle } from 'lucide-react'
import { createClient } from '@/lib/supabase-browser'
import { formatErrorMessage } from '@/lib/format-error'
import type { Campaign, UnroutedSuffix } from './types'

// Orders whose Shopify order-number suffix (#26614-SLASHER-TRASH) matches no
// campaign legacy code or route. They're already saved (on the fallback
// campaign); routing moves them and every future order with that suffix.

const shopifySuffix = (suffix: string) => `-${suffix.replace(/_/g, '-')}`
const squash = (s: string | null) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')

function suggestCampaign(suffix: string, campaigns: Campaign[]): Campaign | null {
  const target = squash(suffix)
  if (target.length < 4) return null
  return (
    campaigns.find((c) => {
      const name = squash(c.name)
      const code = squash(c.legacy_code)
      return [name, code].some(
        (v) => v.length >= 4 && (v === target || v.startsWith(target) || target.startsWith(v)),
      )
    }) ?? null
  )
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export default function UnroutedOrdersPanel({
  initialRows,
  loadError,
  campaigns,
  onCountChange,
}: {
  initialRows: UnroutedSuffix[]
  loadError: string | null
  campaigns: Campaign[]
  onCountChange: (n: number) => void
}) {
  const router = useRouter()
  const [rows, setRows] = useState(initialRows)
  const [choice, setChoice] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      initialRows
        .map((r) => [r.suffix, suggestCampaign(r.suffix, campaigns)?.id] as const)
        .filter((e): e is readonly [string, number] => e[1] != null),
    ),
  )
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(loadError)
  const [notice, setNotice] = useState<string | null>(null)

  if (rows.length === 0 && !error && !notice) return null

  const sortedCampaigns = [...campaigns].sort((a, b) => a.name.localeCompare(b.name))

  function removeRow(suffix: string) {
    const next = rows.filter((r) => r.suffix !== suffix)
    setRows(next)
    onCountChange(next.length)
  }

  async function route(row: UnroutedSuffix) {
    const campaign = campaigns.find((c) => c.id === choice[row.suffix])
    if (!campaign) return
    const label = shopifySuffix(row.suffix)
    if (
      !confirm(
        `Route orders ending ${label} to ${campaign.name}?\n\n` +
          `${row.order_count} existing order${row.order_count === 1 ? '' : 's'} will move, ` +
          `and every future ${label} order will land there automatically.`,
      )
    )
      return
    setBusy(row.suffix)
    setError(null)
    setNotice(null)
    try {
      const supabase = createClient()
      const { data, error: e } = await supabase.rpc('route_order_suffix', {
        p_suffix: row.suffix,
        p_campaign_id: campaign.id,
      })
      if (e) throw e
      await fetch('/api/customer/revalidate', { method: 'POST' }).catch(() => {})
      removeRow(row.suffix)
      setNotice(
        `Moved ${data ?? 0} order${data === 1 ? '' : 's'} ending ${label} to ${campaign.name}. ` +
          'Campaign totals catch up within the hour.',
      )
      router.refresh()
    } catch (e) {
      setError(formatErrorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  async function ignore(row: UnroutedSuffix) {
    const label = shopifySuffix(row.suffix)
    if (
      !confirm(
        `Ignore orders ending ${label}?\n\n` +
          `They stay on ${row.current_campaign_name ?? 'their current campaign'} and won't be flagged again. ` +
          'Use this for test orders.',
      )
    )
      return
    setBusy(row.suffix)
    setError(null)
    setNotice(null)
    try {
      const supabase = createClient()
      const { error: e } = await supabase.rpc('ignore_order_suffix', { p_suffix: row.suffix })
      if (e) throw e
      removeRow(row.suffix)
      setNotice(`Orders ending ${label} will no longer be flagged.`)
    } catch (e) {
      setError(formatErrorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="space-y-3 mb-8">
      <div className="flex items-center gap-2">
        <AlertTriangle size={15} className="text-amber-400" />
        <h2 className="text-sm font-semibold text-white">Unrouted orders</h2>
      </div>
      <p className="text-xs text-zinc-500">
        These orders are saved, but their order number doesn&apos;t match any campaign, so they&apos;re
        sitting on the default campaign. Usually a new Shopify campaign whose suffix differs from the
        campaign&apos;s legacy code.
      </p>

      {error && (
        <div className="bg-red-950/40 border border-red-900/60 rounded-xl px-4 py-3">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}
      {notice && (
        <div className="bg-emerald-950/40 border border-emerald-900/60 rounded-xl px-4 py-3">
          <p className="text-sm text-emerald-300">{notice}</p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="bg-zinc-900 border border-amber-900/50 rounded-xl divide-y divide-zinc-800/60">
          {rows.map((r) => {
            const suggested = suggestCampaign(r.suffix, campaigns)
            return (
              <div key={r.suffix} className="px-5 py-4 flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-white">
                    {r.order_count} order{r.order_count === 1 ? '' : 's'} ending{' '}
                    <span className="font-mono text-amber-300">{shopifySuffix(r.suffix)}</span>
                  </p>
                  <p className="text-xs text-zinc-500 mt-1 flex items-center gap-x-3 gap-y-1 flex-wrap">
                    {r.sample_order_number && <span className="font-mono">latest {r.sample_order_number}</span>}
                    <span>first seen {fmtDate(r.first_seen)}</span>
                    <span>currently on {r.current_campaign_name ?? '—'}</span>
                  </p>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap w-full sm:w-auto">
                  <select
                    value={choice[r.suffix] ?? ''}
                    onChange={(e) =>
                      setChoice((prev) => ({ ...prev, [r.suffix]: Number(e.target.value) }))
                    }
                    disabled={busy === r.suffix}
                    aria-label={`Campaign for orders ending ${shopifySuffix(r.suffix)}`}
                    className="flex-1 sm:flex-none sm:w-56 bg-zinc-800 border border-zinc-700 rounded-md px-2 py-1.5 text-xs text-white focus:outline-none focus:border-zinc-500 disabled:opacity-50"
                  >
                    <option value="" disabled>
                      Choose campaign…
                    </option>
                    {sortedCampaigns.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {suggested?.id === c.id ? ' (suggested)' : ''}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => route(r)}
                    disabled={busy === r.suffix || !choice[r.suffix]}
                    className="px-3 py-1.5 text-xs font-bold rounded-md bg-[#3B9EE8] hover:bg-[#2d8ed8] text-white transition-colors disabled:opacity-50"
                  >
                    {busy === r.suffix ? 'Routing…' : 'Route'}
                  </button>
                  <button
                    onClick={() => ignore(r)}
                    disabled={busy === r.suffix}
                    className="px-3 py-1.5 text-xs rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors disabled:opacity-50"
                  >
                    Ignore
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
