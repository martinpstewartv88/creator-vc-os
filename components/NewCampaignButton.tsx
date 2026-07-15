'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { useAuth } from './AuthProvider'

// "New campaign" button + modal form. Visible only to admin/team
// (support has no campaigns access at all). The role check is also
// enforced inside the create_campaign RPC — the gate here is just a
// UX cue so the button doesn't tease users who can't act on it.
//
// Submit goes through POST /api/campaigns rather than directly via
// supabase.rpc, because the route handler busts the getCampaigns
// cache tag (5-min TTL); without that the new campaign wouldn't
// appear on the list page until the cache expired.
//
// Layout: backdrop-overlay modal (mirroring EditCustomerButton) — the
// inline-grid version got cramped on the page header and pushed the
// table down. Modal keeps the table in view and gives the form room.
//
// On success we router.refresh() so the server page re-renders with
// the freshly-busted cache and the new row shows up in the table.
export default function NewCampaignButton() {
  const { role } = useAuth()
  const [open, setOpen] = useState(false)

  const canCreate = role === 'admin' || role === 'team'
  if (!canCreate) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-[#3B9EE8] hover:bg-[#3691d4] text-white text-sm font-medium transition-colors"
      >
        <Plus size={15} strokeWidth={2.25} />
        New campaign
      </button>
      {open && <NewCampaignModal onClose={() => setOpen(false)} />}
    </>
  )
}

function NewCampaignModal({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [legacyCode, setLegacyCode] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setPending(true)
    setError(null)
    let res: Response
    try {
      res = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          legacyCode: legacyCode.trim(),
        }),
      })
    } catch (e2) {
      setPending(false)
      setError(e2 instanceof Error ? e2.message : 'network error')
      return
    }
    setPending(false)
    if (!res.ok) {
      // The route handler surfaces the RPC's Postgres message directly
      // (forbidden / invalid / duplicate legacy_code) — all human-
      // readable so we just show whatever came back.
      let msg = `Create failed (${res.status})`
      try {
        const body = await res.json()
        if (body?.error) msg = String(body.error)
      } catch {}
      setError(msg)
      return
    }
    router.refresh()
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-xl p-5 md:p-6 space-y-4 max-h-[90vh] overflow-y-auto"
      >
        <div>
          <p className="text-xs uppercase tracking-wide text-zinc-500 font-medium">
            New campaign
          </p>
          <p className="text-[11px] text-zinc-600 mt-1">
            Adds a row to the campaigns list. The campaign starts empty —
            backers and revenue appear once orders land against it.
          </p>
        </div>

        <Field label="Campaign name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            required
            disabled={pending}
            placeholder="e.g. Project Phoenix"
            className={inputCls}
          />
        </Field>
        <Field label="Legacy code">
          <input
            type="text"
            value={legacyCode}
            // Normalise on every keystroke so it can't be saved in the
            // wrong shape: uppercase, and any run of non-alphanumeric
            // chars collapses to a single underscore. The shopify-webhook
            // extracts the campaign suffix from order numbers like
            // '#22093-JAWS-EXPLORED' and normalises to 'JAWS_EXPLORED'
            // before querying campaigns.legacy_code — a mis-cased or
            // dash-separated value silently mis-routes every future
            // order to the default campaign.
            onChange={(e) => setLegacyCode(
              e.target.value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
            )}
            required
            disabled={pending}
            placeholder="e.g. PHOENIX_2026"
            className={inputCls}
          />
          <p className="text-[10px] text-zinc-600 mt-1">
            Used by the Shopify webhook to route orders to this campaign.
            Must be UPPERCASE_UNDERSCORE — auto-normalised as you type.
          </p>
        </Field>

        {error && (
          <p className="text-xs text-red-400 bg-red-950 border border-red-900/60 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        <div className="flex gap-2 justify-end pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending || !name.trim() || !legacyCode.trim()}
            className="px-4 py-2 rounded-lg bg-[#3B9EE8] hover:bg-[#3691d4] disabled:opacity-50 text-white text-sm font-medium transition-colors"
          >
            {pending ? 'Creating…' : 'Create campaign'}
          </button>
        </div>
      </form>
    </div>
  )
}

const inputCls =
  'w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500 disabled:opacity-50'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-zinc-400 mb-1.5">{label}</span>
      {children}
    </label>
  )
}
