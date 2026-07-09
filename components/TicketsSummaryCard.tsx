'use client'

// Tickets summary card — appears above the table when a date filter
// is active. Click "Generate" to call the tickets-summary edge function
// (Claude Sonnet narrative + exact theme counts from SQL). Result is
// cached in a Map keyed on (from, to) for the lifetime of the page,
// so flipping between filters and back doesn't re-bill the API.

import { useMemo, useState } from 'react'
import { Sparkles, RefreshCw } from 'lucide-react'
import { createClient } from '@/lib/supabase-browser'
import { formatErrorMessage } from '@/lib/format-error'

type ThemeMap = Record<string, number>
type Subject  = { subject: string; n: number }
type Summary  = {
  total_tickets: number
  from: string
  to: string
  themes: ThemeMap
  top_subjects: Subject[]
  paragraph: string
}

// Friendly labels for the theme keys returned by the RPC. Anything
// not in the map renders as the snake_case key with underscores
// replaced — graceful fallback if we add new themes server-side
// without updating the UI.
const THEME_LABEL: Record<string, string> = {
  shipping_payment_confusion: 'Shipping payment confusion',
  address_change:             'Address change requests',
  where_is_order:             'Where-is-my-order',
  digital_access:             'Digital access / downloads',
  upgrade_upsell:             'Upgrade / upsell',
  damaged:                    'Damaged items',
  never_arrived:              "Never arrived / lost",
  double_charge:              'Double-charge / duplicate',
  refund:                     'Refund requests',
  cancellation:               'Cancellations',
  wrong_item:                 'Wrong item received',
}

function labelFor(key: string): string {
  return THEME_LABEL[key] ?? key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

function fmtRange(from: string, to: string): string {
  // YYYY-MM-DD → "8 Jun 2026". `to` is exclusive in SQL so we display
  // (to - 1 day) to match human expectations.
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }
  const f = new Date(from + 'T00:00:00')
  const t = new Date(to + 'T00:00:00')
  t.setDate(t.getDate() - 1)
  return `${f.toLocaleDateString('en-GB', opts)} → ${t.toLocaleDateString('en-GB', opts)}`
}

export default function TicketsSummaryCard({
  from,
  to,
  ticketCount,
}: {
  from: string
  to:   string
  ticketCount: number  // visible to Robin so he sees the scale before clicking
}) {
  const [cache, setCache] = useState<Map<string, Summary>>(new Map())
  const cacheKey = `${from}|${to}`
  const summary = cache.get(cacheKey)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function generate() {
    setLoading(true)
    setErr(null)
    try {
      const supabase = createClient()
      const { data, error } = await supabase.functions.invoke<Summary>('tickets-summary', {
        body: { from, to },
      })
      if (error) throw error
      if (!data) throw new Error('No data returned')
      setCache((prev) => new Map(prev).set(cacheKey, data))
    } catch (e) {
      setErr(formatErrorMessage(e))
    } finally {
      setLoading(false)
    }
  }

  // Theme rows: filter zeros + sort desc + cap at 8.
  const themeRows = useMemo(() => {
    if (!summary) return []
    return Object.entries(summary.themes)
      .map(([k, n]) => ({ key: k, label: labelFor(k), n: Number(n) }))
      .filter((t) => t.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, 8)
  }, [summary])

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl mb-6">
      <div className="px-5 py-4 border-b border-zinc-800 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-[#3B9EE8]/15">
            <Sparkles size={14} className="text-[#3B9EE8]" strokeWidth={2} />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white">Window summary</p>
            <p className="text-[11px] text-zinc-500 mt-0.5 truncate">
              {fmtRange(from, to)} · {ticketCount.toLocaleString()} tickets
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={generate}
          disabled={loading || ticketCount === 0}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#3B9EE8] hover:bg-[#3691d4] disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium transition-colors"
        >
          {loading ? (
            <>
              <RefreshCw size={13} className="animate-spin" />
              Summarising…
            </>
          ) : summary ? (
            <>
              <RefreshCw size={13} />
              Regenerate
            </>
          ) : (
            <>
              <Sparkles size={13} />
              Generate summary
            </>
          )}
        </button>
      </div>

      {err && (
        <div className="px-5 py-3 border-b border-zinc-800 text-xs text-red-300 bg-red-950/30">
          {err}
        </div>
      )}

      {!summary && !loading && !err && (
        <div className="px-5 py-4 text-xs text-zinc-500">
          {ticketCount === 0
            ? 'No tickets in this window — nothing to summarise.'
            : 'Click "Generate summary" to ask Claude to write a paragraph about what came in during this window.'}
        </div>
      )}

      {summary && (
        <div className="px-5 py-4 space-y-5">
          {/* Paragraph */}
          <p className="text-sm text-zinc-200 leading-relaxed whitespace-pre-wrap">
            {summary.paragraph}
          </p>

          {/* Themes — exact counts from SQL, not the LLM */}
          {themeRows.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-zinc-500 font-medium mb-2">
                Themes
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
                {themeRows.map((t) => (
                  <div key={t.key} className="flex justify-between gap-3 border-b border-zinc-800/40 py-1">
                    <span className="text-zinc-300">{t.label}</span>
                    <span className="text-zinc-500 tabular-nums">
                      {t.n} · {summary.total_tickets > 0 ? Math.round((t.n / summary.total_tickets) * 100) : 0}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Sample subjects — no PII, just the literal subject lines
              the customer typed. Capped at 6 for scannability. */}
          {summary.top_subjects.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-zinc-500 font-medium mb-2">
                Recurring subjects
              </p>
              <ul className="space-y-1 text-xs">
                {summary.top_subjects.slice(0, 6).map((s, i) => (
                  <li key={i} className="flex justify-between gap-3 text-zinc-400">
                    <span className="truncate">&ldquo;{s.subject}&rdquo;</span>
                    <span className="text-zinc-600 tabular-nums shrink-0">×{s.n}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
