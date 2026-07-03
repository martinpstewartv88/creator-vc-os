'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AtSign } from 'lucide-react'
import { createClient } from '@/lib/supabase-browser'
import { useAuth } from './AuthProvider'
import { isOwner } from '@/lib/auth'
import { formatErrorMessage } from '@/lib/format-error'

// Owner-only "Change email" action for a customer.
//
// Wire is two-step:
//   1. Operator types the new email and hits Preview → we call the read-only
//      preview_customer_email_change RPC. It returns per-table row counts and
//      a collision flag ("email already belongs to customer #123").
//   2. Operator sees the counts, retypes the new email in a confirm input,
//      and hits Change → we call admin_change_customer_email which does the
//      atomic swap across 8 tables + refreshes snapshots.
//
// Gated by owner+admin at the DB layer too — the button just won't render for
// anyone else. The DB RPCs will refuse even if a non-owner somehow calls them.
//
// Freshdesk decision (v1): DB-only. tickets.customer_id linkage stays intact;
// tickets.requester_email is left as whatever Freshdesk knows. The audit log
// records the count that were untouched.

type Counts = {
  raw_orders?: number
  historic_orders?: number
  order_entitlements?: number
  payhere_payments?: number
  manual_shipping_marks?: number
  acutrack_received?: number
  backer_fulfillment?: number
  tickets_linked_by_customer_id?: number
  tickets_by_requester_email_untouched?: number
}

type PreviewResult = {
  customer_id: number
  old_email: string
  new_email: string
  collision: boolean
  collision_customer_id: number | null
  counts: Counts
}

export default function ChangeEmailButton({
  customer,
}: {
  customer: { id: number; email: string }
}) {
  const { user, role } = useAuth()
  const [open, setOpen] = useState(false)

  // Owner + admin only. Belt: this hides the button. Braces: the DB RPC
  // refuses non-owner + non-admin regardless.
  if (!isOwner(user?.email) || role !== 'admin') return null

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-sm font-medium transition-colors"
        title="Owner-only: change this customer's email and cascade across all linked tables."
      >
        <AtSign size={14} strokeWidth={1.75} />
        Change email
      </button>
    )
  }

  return <ChangeEmailModal customer={customer} onClose={() => setOpen(false)} />
}

function ChangeEmailModal({
  customer,
  onClose,
}: {
  customer: { id: number; email: string }
  onClose: () => void
}) {
  const router = useRouter()
  const supabase = createClient()

  const [step, setStep] = useState<'input' | 'confirm'>('input')
  const [newEmail, setNewEmail]     = useState('')
  const [confirmEmail, setConfirm]  = useState('')
  const [note, setNote]             = useState('')
  const [preview, setPreview]       = useState<PreviewResult | null>(null)
  const [busy, setBusy]             = useState(false)
  const [error, setError]           = useState<string | null>(null)

  const doPreview = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const { data, error } = await supabase.rpc('preview_customer_email_change', {
        p_customer_id: customer.id,
        p_new_email: newEmail.trim(),
      })
      if (error) throw error
      const result = data as PreviewResult
      setPreview(result)
      if (result.collision) {
        setError(
          `That email already belongs to customer #${result.collision_customer_id}. ` +
          `Merging customers is a separate operation — please resolve manually first.`,
        )
      } else {
        setStep('confirm')
      }
    } catch (err) {
      setError(formatErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const doChange = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!preview) return
    if (confirmEmail.trim().toLowerCase() !== preview.new_email) {
      setError('Confirmation email doesn\'t match. Type the new email again exactly.')
      return
    }
    setBusy(true)
    try {
      const { data, error } = await supabase.rpc('admin_change_customer_email', {
        p_customer_id: customer.id,
        p_new_email: preview.new_email,
        p_note: note.trim() ? note.trim() : null,
      })
      if (error) throw error
      const result = data as { new_email: string }
      // Redirect to the customer detail page under the new email so the
      // route param, the header, and every RPC re-fetch is consistent.
      router.push(`/customers/${encodeURIComponent(result.new_email)}`)
      router.refresh()
    } catch (err) {
      setError(formatErrorMessage(err))
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={step === 'input' ? doPreview : doChange}
        className="w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-xl p-5 md:p-6 space-y-4 max-h-[90vh] overflow-y-auto"
      >
        <div>
          <p className="text-xs uppercase tracking-wide text-zinc-500 font-medium">Change customer email</p>
          <p className="text-sm text-zinc-300 mt-1 break-all">{customer.email}</p>
          <p className="text-[11px] text-zinc-600 mt-0.5">
            Cascades across orders, entitlements, payhere, fulfilment and shipping marks.
            Freshdesk ticket <code className="text-[10px]">requester_email</code> stays as-is (customer_id linkage handles the join).
          </p>
        </div>

        {step === 'input' && (
          <fieldset className="space-y-3">
            <label className="block">
              <span className="block text-xs font-medium text-zinc-400 mb-1.5">New email address</span>
              <input
                type="email"
                required
                autoFocus
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                disabled={busy}
                placeholder="new@example.com"
                className={inputCls}
              />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-zinc-400 mb-1.5">Reason / note (optional)</span>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={busy}
                placeholder='e.g. "Customer typo on original Shopify order"'
                className={inputCls}
              />
            </label>
          </fieldset>
        )}

        {step === 'confirm' && preview && (
          <div className="space-y-4">
            <div className="rounded-lg bg-zinc-800/60 border border-zinc-800 p-3">
              <p className="text-[10px] uppercase tracking-wide text-zinc-500 font-medium mb-2">
                What will move
              </p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <CountRow label="Raw orders (Shopify/Gumroad live)" n={preview.counts.raw_orders} />
                <CountRow label="Historic orders"                   n={preview.counts.historic_orders} />
                <CountRow label="Order entitlements"                n={preview.counts.order_entitlements} />
                <CountRow label="Payhere payments"                  n={preview.counts.payhere_payments} />
                <CountRow label="Acutrack fulfilment"               n={preview.counts.acutrack_received} />
                <CountRow label="Backer fulfilment queue"           n={preview.counts.backer_fulfillment} />
                <CountRow label="Manual shipping marks"             n={preview.counts.manual_shipping_marks} />
                <CountRow label="Tickets (linked by ID, not moved)" n={preview.counts.tickets_by_requester_email_untouched} muted />
              </dl>
              <p className="mt-3 text-[11px] text-zinc-500">
                <span className="text-zinc-400 font-mono">{preview.old_email}</span>
                {' → '}
                <span className="text-white font-mono">{preview.new_email}</span>
              </p>
            </div>

            <label className="block">
              <span className="block text-xs font-medium text-zinc-400 mb-1.5">
                Retype the new email to confirm
              </span>
              <input
                type="email"
                required
                autoFocus
                value={confirmEmail}
                onChange={(e) => setConfirm(e.target.value)}
                disabled={busy}
                placeholder={preview.new_email}
                className={inputCls}
              />
            </label>
          </div>
        )}

        {error && (
          <p className="text-xs text-red-400 bg-red-950 border border-red-900/60 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        <div className="flex gap-2 justify-end pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          {step === 'confirm' && (
            <button
              type="button"
              onClick={() => { setStep('input'); setError(null) }}
              disabled={busy}
              className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium transition-colors disabled:opacity-50"
            >
              Back
            </button>
          )}
          <button
            type="submit"
            disabled={busy}
            className="px-4 py-2 rounded-lg bg-[#3B9EE8] hover:bg-[#3691d4] disabled:opacity-50 text-white text-sm font-medium transition-colors"
          >
            {busy
              ? (step === 'input' ? 'Checking…' : 'Changing…')
              : (step === 'input' ? 'Preview change' : 'Change email')}
          </button>
        </div>
      </form>
    </div>
  )
}

function CountRow({ label, n, muted = false }: { label: string; n: number | undefined; muted?: boolean }) {
  return (
    <>
      <dt className={muted ? 'text-zinc-600' : 'text-zinc-400'}>{label}</dt>
      <dd className={`text-right tabular-nums ${muted ? 'text-zinc-600' : 'text-zinc-200'}`}>{n ?? 0}</dd>
    </>
  )
}

const inputCls =
  'w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500 disabled:opacity-50'
