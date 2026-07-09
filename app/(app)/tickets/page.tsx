import { Ticket } from 'lucide-react'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase-server'
import { getCurrentRole } from '@/lib/auth-server'
import {
  listTickets,
  getTicketStatusCounts,
  getTicketsCreatedTimeline,
  getTicketsCreatedTimelineRange,
  type TicketStatusCounts,
  type TicketTimelinePoint,
} from '@/lib/tickets'
import { canAccess } from '@/lib/auth'
import ThirtyDayChart from '@/components/ThirtyDayChart'
import DateRangeFilter from '@/components/DateRangeFilter'
import TicketsSummaryCard from '@/components/TicketsSummaryCard'
import TicketsListView from './TicketsListView'

export const dynamic = 'force-dynamic'

// Date-range semantics: created_at >= from AND < to. URL params are
// YYYY-MM-DD; we convert to ISO timestamps at the boundary (start-of-
// day local for both ends, so "from=2026-06-01&to=2026-06-08" means
// "tickets received on 1 Jun through end of 7 Jun").
function ymdToIso(ymd: string | undefined | null): string | null {
  if (!ymd) return null
  // Cheap validation — avoid passing arbitrary URL junk to the RPC.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null
  return `${ymd}T00:00:00.000Z`
}
function ymd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>
}) {
  const role = await getCurrentRole()
  if (!canAccess(role, 'tickets')) redirect('/')

  const sp = await searchParams

  // Resolve filter values. Default = last 30 days so the page lands
  // populated and the chart has data without a click.
  const now = new Date()
  const defaultFrom = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30))
  const defaultTo   = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))

  const fromYmd = sp.from ?? defaultFrom
  const toYmd   = sp.to   ?? defaultTo
  const fromIso = ymdToIso(fromYmd)
  const toIso   = ymdToIso(toYmd)
  const isAllTime = !sp.from && !sp.to ? false : !fromIso && !toIso

  const supabase = await createClient()
  // Fan out. Each failure tolerated — empty fallbacks so a partial
  // outage doesn't blank the whole screen.
  //
  // Two count RPCs:
  //   `counts` respects the active window so the tab badges match the
  //   list below (Reiner's ask — previously the badges were frozen to
  //   all-time and never moved with the filter).
  //   `countsAllTime` stays unfiltered so the header subtitle can
  //   surface the total dataset alongside the current-window count.
  const [list, counts, countsAllTime, timeline] = await Promise.all([
    listTickets(supabase, {
      page: 1,
      pageSize: 25,
      from: isAllTime ? null : fromIso,
      to:   isAllTime ? null : toIso,
    }).catch((e) => {
      console.error('[tickets] initial list failed', e)
      return { rows: [], total: 0 }
    }),
    getTicketStatusCounts(
      supabase,
      isAllTime ? null : fromIso,
      isAllTime ? null : toIso,
    ).catch((e): TicketStatusCounts => {
      console.error('[tickets] counts failed', e)
      return { all: 0, Open: 0, Pending: 0, Resolved: 0, Closed: 0, other: 0 }
    }),
    getTicketStatusCounts(supabase).catch((e): TicketStatusCounts => {
      console.error('[tickets] all-time counts failed', e)
      return { all: 0, Open: 0, Pending: 0, Resolved: 0, Closed: 0, other: 0 }
    }),
    // Chart respects the active window. Falls back to the simple
    // 30-day variant if the range RPC errors so the chart still has
    // shape.
    (isAllTime || !fromIso || !toIso
      ? getTicketsCreatedTimeline(supabase, 30)
      : getTicketsCreatedTimelineRange(supabase, fromIso, toIso)
    ).catch((e): TicketTimelinePoint[] => {
      console.error('[tickets] timeline failed', e)
      return []
    }),
  ])

  return (
    <div className="p-4 md:p-8">
      <header className="mb-6 md:mb-8 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center justify-center w-9 h-9 md:w-10 md:h-10 rounded-lg bg-[#3B9EE8]">
            <Ticket size={18} className="text-white" strokeWidth={2.25} />
          </span>
          <div>
            <h1 className="text-xl md:text-2xl font-semibold text-white">Tickets</h1>
            <p className="text-sm text-zinc-500 mt-1">
              {list.total.toLocaleString()} in window · {countsAllTime.all.toLocaleString()} all-time
            </p>
          </div>
        </div>
        <DateRangeFilter value={{ from: sp.from ?? null, to: sp.to ?? null }} />
      </header>

      {/* Chart respects the date range — same window as the table. */}
      <div className="mb-6 md:mb-8">
        <ThirtyDayChart
          data={timeline}
          idKey={`tickets-created-${fromYmd}-${toYmd}`}
          subtitle="Tickets created"
          unitNoun="ticket"
          emptyLabel="No tickets created in this window."
        />
      </div>

      {/* Summary card — shows whenever a date filter is active (which
          is always, since we default to last 30 days). Generate is
          manual to keep LLM cost predictable. */}
      {fromIso && toIso && (
        <TicketsSummaryCard
          from={fromYmd}
          to={toYmd}
          ticketCount={list.total}
        />
      )}

      <TicketsListView
        initialRows={list.rows}
        initialTotal={list.total}
        counts={counts}
        from={isAllTime ? null : fromIso}
        to={isAllTime ? null : toIso}
      />
    </div>
  )
}
