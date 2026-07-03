'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AtSign } from 'lucide-react'
import { createClient } from '@/lib/supabase-browser'
import { useAuth } from './AuthProvider'
import { formatErrorMessage } from '@/lib/format-error'

// "Change or merge email" action.
//
// Two paths, one entry point:
//   RENAME — target email is free. Preview shows what will move across
//     the 8 satellite tables, retype-target confirmation, atomic swap.
//   MERGE  — target email already belongs to another customer. Preview
//     flips to a merge view: THIS customer will die, its orders and
//     junction rows re-point at the target (survivor), NULL fields on
//     the survivor get backfilled from this customer. Then this row is
//     deleted.
//
// Visible to admin + support (roles that manage customers day-to-day).
// The DB RPCs enforce the same staff gate, so a role change alone can't
// widen access without a matching migration.
//
// Freshdesk decision (unchanged): tickets.customer_id is re-pointed (merge
// only — rename doesn't touch it). tickets.requester_email is left as
// whatever Freshdesk knows. Audit log records the count left untouched.

type RenameCounts = {
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

type RenamePreview = {
  customer_id: number
  old_email: string
  new_email: string
  collision: boolean
  collision_customer_id: number | null
  counts: RenameCounts
}

type CustomerBrief = {
  id: number
  email: string
  first_name: string | null
  last_name: string | null
  phone: string | null
  shipping_address_1: string | null
  shipping_address_2: string | null
  shipping_city: string | null
  shipping_zip: string | null
  shipping_country: string | null
}

type MergeCounts = {
  raw_orders?: number
  historic_orders?: number
  order_entitlements?: number
  payhere_payments?: number
  manual_shipping_marks?: number
  acutrack_received?: number
  backer_fulfillment?: number
  junction_raw_orders?: number
  junction_campaign_orders?: number
  tickets_by_customer_id?: number
  tickets_requester_email_left_untouched?: number
}

type MergePreview = {
  survivor: CustomerBrief
  merged:   CustomerBrief
  backfill_fields: string[]
  counts: MergeCounts
}

type Mode = 'rename' | 'merge'

export default function ChangeEmailButton({
  customer,
}: {
  customer: { id: number; email: string }
}) {
  const { role } = useAuth()
  const [open, setOpen] = useState(false)

  if (role !== 'admin' && role !== 'support') return null

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-sm font-medium transition-colors"
        title="Change this customer's email, or merge them into an existing customer."
      >
        <AtSign size={14} strokeWidth={1.75} />
        Change or merge email
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

  const [step, setStep]        = useState<'input' | 'confirm'>('input')
  const [mode, setMode]        = useState<Mode>('rename')
  const [newEmail, setNewEmail] = useState('')
  const [confirmEmail, setConfirm] = useState('')
  const [note, setNote]        = useState('')
  const [rename, setRename]    = useState<RenamePreview | null>(null)
  const [merge, setMerge]      = useState<MergePreview | null>(null)
  const [busy, setBusy]        = useState(false)
  const [error, setError]      = useState<string | null>(null)

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
      const renameResult = data as RenamePreview

      if (!renameResult.collision) {
        setMode('rename')
        setRename(renameResult)
        setMerge(null)
        setStep('confirm')
        return
      }

      // Collision — pivot to merge preview. Survivor = the OTHER customer;
      // the currently-viewed customer becomes the merged/dead record.
      const survivorId = renameResult.collision_customer_id!
      const { data: mergeData, error: mergeErr } = await supabase.rpc('preview_customer_merge', {
        p_survivor_id: survivorId,
        p_merged_id:   customer.id,
      })
      if (mergeErr) throw mergeErr
      setMode('merge')
      setRename(renameResult)
      setMerge(mergeData as MergePreview)
      setStep('confirm')
    } catch (err) {
      setError(formatErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const doCommit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      if (mode === 'rename') {
        if (!rename) return
        if (confirmEmail.trim().toLowerCase() !== rename.new_email) {
          setError('Confirmation email doesn\'t match. Type the new email again exactly.')
          setBusy(false)
          return
        }
        const { data, error } = await supabase.rpc('admin_change_customer_email', {
          p_customer_id: customer.id,
          p_new_email:   rename.new_email,
          p_note:        note.trim() ? note.trim() : null,
        })
        if (error) throw error
        const result = data as { new_email: string }
        router.push(`/customers/${encodeURIComponent(result.new_email)}`)
        router.refresh()
      } else {
        if (!merge) return
        if (confirmEmail.trim().toLowerCase() !== merge.survivor.email.toLowerCase()) {
          setError('Confirmation email doesn\'t match the survivor. Type it again exactly.')
          setBusy(false)
          return
        }
        const { data, error } = await supabase.rpc('admin_merge_customers', {
          p_survivor_id: merge.survivor.id,
          p_merged_id:   customer.id,
          p_note:        note.trim() ? note.trim() : null,
        })
        if (error) throw error
        const result = data as { survivor_email: string }
        router.push(`/customers/${encodeURIComponent(result.survivor_email)}`)
        router.refresh()
      }
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
        onSubmit={step === 'input' ? doPreview : doCommit}
        className="w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-xl p-5 md:p-6 space-y-4 max-h-[90vh] overflow-y-auto"
      >
        <div>
          <p className="text-xs uppercase tracking-wide text-zinc-500 font-medium">
            {step === 'input' ? 'Change or merge email' : mode === 'rename' ? 'Rename customer email' : 'Merge customer'}
          </p>
          <p className="text-sm text-zinc-300 mt-1 break-all">{customer.email}</p>
          <p className="text-[11px] text-zinc-600 mt-0.5">
            If the new email already belongs to another customer, we&apos;ll merge the two accounts.
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
                placeholder='e.g. "Customer requested consolidation into gmail address"'
                className={inputCls}
              />
            </label>
          </fieldset>
        )}

        {step === 'confirm' && mode === 'rename' && rename && (
          <div className="space-y-4">
            <div className="rounded-lg bg-zinc-800/60 border border-zinc-800 p-3">
              <p className="text-[10px] uppercase tracking-wide text-zinc-500 font-medium mb-2">Summary</p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <CountRow label="Orders" n={(rename.counts.raw_orders ?? 0) + (rename.counts.historic_orders ?? 0)} />
              </dl>
              <p className="mt-3 text-[11px] text-zinc-500">
                <span className="text-zinc-400 font-mono">{rename.old_email}</span>{' → '}
                <span className="text-white font-mono">{rename.new_email}</span>
              </p>
            </div>

            <label className="block">
              <span className="block text-xs font-medium text-zinc-400 mb-1.5">Retype the new email to confirm</span>
              <input
                type="email"
                required
                autoFocus
                value={confirmEmail}
                onChange={(e) => setConfirm(e.target.value)}
                disabled={busy}
                placeholder={rename.new_email}
                className={inputCls}
              />
            </label>
          </div>
        )}

        {step === 'confirm' && mode === 'merge' && merge && (
          <div className="space-y-4">
            <div className="rounded-lg bg-amber-950/40 border border-amber-900/60 p-3">
              <p className="text-xs text-amber-200/90">
                These two accounts will be merged. All of{' '}
                <span className="font-mono">{merge.merged.email}</span>&apos;s orders and tickets will move over to{' '}
                <span className="font-mono">{merge.survivor.email}</span>, and this record will be removed.
              </p>
            </div>

            <div className="rounded-lg bg-zinc-800/60 border border-zinc-800 p-3">
              <p className="text-[10px] uppercase tracking-wide text-zinc-500 font-medium mb-2">Summary</p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <CountRow label="Orders"      n={(merge.counts.raw_orders ?? 0) + (merge.counts.historic_orders ?? 0)} />
                <CountRow label="Tickets"     n={merge.counts.tickets_by_customer_id} />
              </dl>
            </div>

            <label className="block">
              <span className="block text-xs font-medium text-zinc-400 mb-1.5">
                Retype the survivor email to confirm
              </span>
              <input
                type="email"
                required
                autoFocus
                value={confirmEmail}
                onChange={(e) => setConfirm(e.target.value)}
                disabled={busy}
                placeholder={merge.survivor.email}
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
              onClick={() => { setStep('input'); setError(null); setConfirm('') }}
              disabled={busy}
              className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium transition-colors disabled:opacity-50"
            >
              Back
            </button>
          )}
          <button
            type="submit"
            disabled={busy}
            className={
              step === 'confirm' && mode === 'merge'
                ? 'px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-medium transition-colors'
                : 'px-4 py-2 rounded-lg bg-[#3B9EE8] hover:bg-[#3691d4] disabled:opacity-50 text-white text-sm font-medium transition-colors'
            }
          >
            {busy
              ? (step === 'input' ? 'Checking…' : mode === 'merge' ? 'Merging…' : 'Changing…')
              : (step === 'input'
                  ? 'Preview'
                  : mode === 'merge'
                    ? 'Merge accounts'
                    : 'Change email')}
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
