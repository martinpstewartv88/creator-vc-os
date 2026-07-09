// Tickets data layer — read-only mirror of Freshdesk.
//
// As of 1 June 2026 the in-app ticket CRUD is RETIRED. Tickets are
// created + actioned in Freshdesk (creatorvc.freshdesk.com) and mirrored
// here via the freshdesk-webhook Edge Function. This module exposes the
// read RPCs only; the legacy write RPCs (ticket_create / ticket_update /
// ticket_assign / ticket_add_event) still exist on the server but must
// not be called from the app.
//
// Status + priority vocabulary now matches Freshdesk exactly:
//   Status:   Open | Pending | Resolved | Closed
//   Priority: Low  | Medium  | High     | Urgent

import type { SupabaseClient } from '@supabase/supabase-js'
import { withRetry } from './supabase'

// ============================================================
// Domain types
// ============================================================

export type TicketStatus = 'Open' | 'Pending' | 'Resolved' | 'Closed'
export type TicketPriority = 'Low' | 'Medium' | 'High' | 'Urgent'

export const STATUS_VALUES: TicketStatus[] = ['Open', 'Pending', 'Resolved', 'Closed']
export const PRIORITY_VALUES: TicketPriority[] = ['Low', 'Medium', 'High', 'Urgent']

export const STATUS_LABEL: Record<TicketStatus, string> = {
  Open: 'Open',
  Pending: 'Pending',
  Resolved: 'Resolved',
  Closed: 'Closed',
}

export const PRIORITY_LABEL: Record<TicketPriority, string> = {
  Low: 'Low',
  Medium: 'Medium',
  High: 'High',
  Urgent: 'Urgent',
}

export function statusTone(s: TicketStatus | string): {
  bg: string
  text: string
  border: string
} {
  switch (s) {
    case 'Open':
      return { bg: 'bg-sky-950', text: 'text-sky-300', border: 'border-sky-900/60' }
    case 'Pending':
      return { bg: 'bg-amber-950', text: 'text-amber-300', border: 'border-amber-900/60' }
    case 'Resolved':
      return { bg: 'bg-emerald-950', text: 'text-emerald-300', border: 'border-emerald-900/60' }
    case 'Closed':
      return { bg: 'bg-zinc-900', text: 'text-zinc-400', border: 'border-zinc-800' }
    default:
      // Unknown status (e.g. legacy ticket that hasn't been resynced) —
      // render in a neutral tone so the UI doesn't crash.
      return { bg: 'bg-zinc-900', text: 'text-zinc-400', border: 'border-zinc-800' }
  }
}

export function priorityTone(p: TicketPriority | string): {
  bg: string
  text: string
  border: string
} {
  switch (p) {
    case 'Urgent':
      return { bg: 'bg-red-950', text: 'text-red-300', border: 'border-red-900/60' }
    case 'High':
      return { bg: 'bg-orange-950', text: 'text-orange-300', border: 'border-orange-900/60' }
    case 'Medium':
      return { bg: 'bg-zinc-900', text: 'text-zinc-300', border: 'border-zinc-800' }
    case 'Low':
      return { bg: 'bg-zinc-950', text: 'text-zinc-500', border: 'border-zinc-800' }
    default:
      return { bg: 'bg-zinc-900', text: 'text-zinc-400', border: 'border-zinc-800' }
  }
}

// Returned by tickets_list. New Freshdesk-specific columns are appended
// to the end of the RPC's RETURNS TABLE; we map by name so the order
// doesn't matter on the frontend.
export type TicketListRow = {
  id: number
  ticket_number: string
  subject: string
  status: TicketStatus
  priority: TicketPriority
  // Customer match (may be null when the Freshdesk requester isn't a
  // known customer yet — fall back to requester_* fields when so).
  customer_id: number | null
  customer_name: string | null
  customer_email: string | null
  order_ref: string | null
  order_source: string | null
  // Legacy app-user actor fields — always null for Freshdesk tickets.
  assigned_to: string | null
  assigned_to_email: string | null
  assigned_to_name: string | null
  last_actioned_by_email: string | null
  last_actioned_by_name: string | null
  last_actioned_at: string | null
  created_at: string
  total_count: number
  // Freshdesk-specific.
  freshdesk_ticket_id: number | null
  freshdesk_url: string | null
  source: string | null
  agent_name: string | null
  campaign_id: number | null
}

// customer_tickets — narrower row, no customer columns (already scoped).
export type CustomerTicketRow = {
  id: number
  ticket_number: string
  subject: string
  status: TicketStatus
  priority: TicketPriority
  order_ref: string | null
  assigned_to_email: string | null
  assigned_to_name: string | null
  last_actioned_by_email: string | null
  last_actioned_by_name: string | null
  last_actioned_at: string | null
  created_at: string
  freshdesk_ticket_id: number | null
  freshdesk_url: string | null
  source: string | null
  agent_name: string | null
  campaign_id: number | null
}

export type TicketHeader = {
  id: number
  ticket_number: string
  subject: string
  description: string | null
  status: TicketStatus
  priority: TicketPriority
  order_ref: string | null
  order_source: string | null
  source: string | null
  group_name: string | null
  film_raw: string | null
  campaign_id: number | null
  customer_id: number | null
  requester_email: string | null
  requester_name: string | null
  agent_name: string | null
  freshdesk_ticket_id: number | null
  freshdesk_url: string | null
  // Legacy fields — always null on Freshdesk tickets.
  assigned_to: string | null
  assigned_to_email: string | null
  assigned_to_name: string | null
  created_by_email: string | null
  created_by_name: string | null
  last_actioned_by_email: string | null
  last_actioned_by_name: string | null
  created_at: string
  last_actioned_at: string | null
  closed_at: string | null
  updated_at: string | null
  ingested_at: string | null
  last_event: string | null
}

// Customer block in ticket_get can be null when the requester is not a
// known customer (their email isn't in aa_02_crm.customers).
export type TicketCustomer = {
  id: number
  email: string
  first_name: string | null
  last_name: string | null
}

export type TicketEventType =
  | 'created'
  | 'comment'
  | 'status_change'
  | 'reassigned'
  | 'edited'

export type TicketEvent = {
  id: number
  event_type: TicketEventType
  body: string | null
  old_status: string | null
  new_status: string | null
  actor_email: string | null
  actor_name: string | null
  created_at: string
}

export type TicketDetail = {
  ticket: TicketHeader
  customer: TicketCustomer | null
  events: TicketEvent[]
}

// staff_list is still useful for the admin Users screen — not used to
// power any ticket UI any more (no more app-side assignment).
export type StaffRow = {
  user_id: string
  email: string
  display_name: string | null
  display_label: string
  role: 'admin' | 'team' | 'support'
}

// ============================================================
// Helpers
// ============================================================

export function formatRpcError(message: string): string {
  return message.replace(/^ERROR:\s+[A-Z0-9]{5}:\s*/, '').trim()
}

// Pretty display label for "who's handling this" — agent_name when the
// ticket is Freshdesk-owned, otherwise the legacy assignee name/email.
export function ticketHandler(row: {
  agent_name?: string | null
  assigned_to_name?: string | null
  assigned_to_email?: string | null
}): string | null {
  return row.agent_name ?? row.assigned_to_name ?? row.assigned_to_email ?? null
}

// Pretty display label for the requester / customer side of a ticket.
// Uses the matched-customer name first (cleanest), then their email,
// then falls back to the raw Freshdesk requester fields when no match.
export function ticketRequesterLabel(row: {
  customer_name?: string | null
  customer_email?: string | null
  requester_name?: string | null
  requester_email?: string | null
}): { primary: string; secondary: string | null } {
  const primary =
    row.customer_name ??
    row.requester_name ??
    row.customer_email ??
    row.requester_email ??
    '—'
  const secondary =
    row.customer_email && row.customer_name
      ? row.customer_email
      : row.requester_email && row.requester_name && row.requester_email !== primary
        ? row.requester_email
        : null
  return { primary, secondary }
}

// Strip HTML from the description email body. Description is the raw
// inbound email — sanitising via a parser would be overkill for a
// read-only preview that deep-links to Freshdesk for the rich view.
// We preserve line breaks (<br>, </p>) and decode the common entities,
// then strip every tag. Output renders safely as plain text in a
// whitespace-pre-wrap container.
export function htmlToPlainText(html: string | null | undefined): string {
  if (!html) return ''
  const decoded = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return decoded
}

// ============================================================
// Read wrappers — every one wrapped in withRetry so transient blips
// don't bubble to the error boundary. Mutations have been removed:
// CRUD lives in Freshdesk now.
// ============================================================

export type ListTicketsOpts = {
  status?: TicketStatus | null
  search?: string | null
  page?: number
  pageSize?: number
}

export async function listTickets(
  supabase: SupabaseClient,
  {
    status = null,
    search = null,
    page = 1,
    pageSize = 25,
    from = null,
    to   = null,
  }: ListTicketsOpts & { from?: string | null; to?: string | null } = {},
): Promise<{ rows: TicketListRow[]; total: number }> {
  // NOTE: p_assignee is intentionally omitted — Freshdesk tickets have
  // no app-user assignment, so filtering on it returns zero rows.
  return withRetry(async () => {
    const { data, error } = await supabase.rpc('tickets_list', {
      p_status: status,
      p_search: search,
      p_assignee: null,
      p_page: page,
      p_page_size: pageSize,
      p_from: from,
      p_to:   to,
    })
    if (error) throw new Error(formatRpcError(error.message))
    const rows = (data ?? []) as TicketListRow[]
    const total = rows.length > 0 ? Number(rows[0].total_count) : 0
    return { rows, total }
  }, 'listTickets')
}

// Range-based variant of getTicketsCreatedTimeline — same row shape
// but the SQL fills one row per day in [p_from, p_to). Used by the
// /tickets page when a date filter is active so the chart respects
// the same window the table does.
export async function getTicketsCreatedTimelineRange(
  supabase: SupabaseClient,
  from: string,
  to: string,
): Promise<TicketTimelinePoint[]> {
  return withRetry(async () => {
    const { data, error } = await supabase.rpc('tickets_created_timeline_range', {
      p_from: from,
      p_to:   to,
    })
    if (error) throw new Error(formatRpcError(error.message))
    return (data ?? []).map((r: { date: string; count: number | string }) => ({
      date: String(r.date),
      count: Number(r.count),
    }))
  }, 'getTicketsCreatedTimelineRange')
}

export async function getTicket(
  supabase: SupabaseClient,
  ticketId: number,
): Promise<TicketDetail> {
  return withRetry(async () => {
    const { data, error } = await supabase.rpc('ticket_get', { p_ticket_id: ticketId })
    if (error) throw new Error(formatRpcError(error.message))
    if (!data) throw new Error('Ticket not found')
    return data as TicketDetail
  }, 'getTicket')
}

export async function listCustomerTickets(
  supabase: SupabaseClient,
  customerId: number,
): Promise<CustomerTicketRow[]> {
  return withRetry(async () => {
    const { data, error } = await supabase.rpc('customer_tickets', {
      p_customer_id: customerId,
    })
    if (error) throw new Error(formatRpcError(error.message))
    return (data ?? []) as CustomerTicketRow[]
  }, 'listCustomerTickets')
}

// Per-status counts for the badge row on top of the Tickets screen.
// When from/to are supplied, counts are scoped to that window so the
// tab badges match the list below. Both null = all-time (the original
// behaviour).
export type TicketStatusCounts = {
  all: number
  Open: number
  Pending: number
  Resolved: number
  Closed: number
  other: number
}

export async function getTicketStatusCounts(
  supabase: SupabaseClient,
  from?: string | null,
  to?: string | null,
): Promise<TicketStatusCounts> {
  return withRetry(async () => {
    const { data, error } = await supabase.rpc('tickets_status_counts', {
      p_from: from ?? null,
      p_to:   to ?? null,
    })
    if (error) throw new Error(formatRpcError(error.message))
    const r = (data ?? {}) as Partial<Record<keyof TicketStatusCounts, number>>
    return {
      all: Number(r.all ?? 0),
      Open: Number(r.Open ?? 0),
      Pending: Number(r.Pending ?? 0),
      Resolved: Number(r.Resolved ?? 0),
      Closed: Number(r.Closed ?? 0),
      other: Number(r.other ?? 0),
    }
  }, 'getTicketStatusCounts')
}

// 30-day created-tickets timeline for the chart at the top of the list.
// One row per day in the window, count = 0 on quiet days so the chart
// has no gaps.
export type TicketTimelinePoint = { date: string; count: number }

export async function getTicketsCreatedTimeline(
  supabase: SupabaseClient,
  days = 30,
): Promise<TicketTimelinePoint[]> {
  return withRetry(async () => {
    const { data, error } = await supabase.rpc('tickets_created_timeline', { p_days: days })
    if (error) throw new Error(formatRpcError(error.message))
    return (data ?? []).map((r: { date: string; count: number | string }) => ({
      date: String(r.date),
      count: Number(r.count),
    }))
  }, 'getTicketsCreatedTimeline')
}

export async function listStaff(supabase: SupabaseClient): Promise<StaffRow[]> {
  return withRetry(async () => {
    const { data, error } = await supabase.rpc('staff_list')
    if (error) throw new Error(formatRpcError(error.message))
    return (data ?? []) as StaffRow[]
  }, 'listStaff')
}

// ============================================================
// Relative time helper (re-used across the ticket UIs).
// ============================================================

export function relTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(mo / 12)}y ago`
}
