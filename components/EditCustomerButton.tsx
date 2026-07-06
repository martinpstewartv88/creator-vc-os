'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Pencil } from 'lucide-react'
import { createClient } from '@/lib/supabase-browser'

// Edit customer contact + shipping details. All three staff roles can
// edit; email is intentionally read-only (it's the identity key joining
// orders → customers). Submit calls customer_update + router.refresh()
// so the server-rendered detail page picks up the new values.
//
// Trims everything on the server; an empty/whitespace input clears the
// stored value to NULL.

export type EditableCustomer = {
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

export default function EditCustomerButton({ customer }: { customer: EditableCustomer }) {
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-sm font-medium transition-colors"
      >
        <Pencil size={14} strokeWidth={1.75} />
        Edit
      </button>
    )
  }

  return <EditCustomerModal customer={customer} onClose={() => setOpen(false)} />
}

function EditCustomerModal({
  customer,
  onClose,
}: {
  customer: EditableCustomer
  onClose: () => void
}) {
  const router = useRouter()
  const supabase = createClient()

  const [firstName, setFirstName] = useState(customer.first_name ?? '')
  const [lastName, setLastName] = useState(customer.last_name ?? '')
  const [phone, setPhone] = useState(customer.phone ?? '')
  const [address1, setAddress1] = useState(customer.shipping_address_1 ?? '')
  const [address2, setAddress2] = useState(customer.shipping_address_2 ?? '')
  const [city, setCity] = useState(customer.shipping_city ?? '')
  const [zip, setZip] = useState(customer.shipping_zip ?? '')
  const [country, setCountry] = useState(customer.shipping_country ?? '')

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    const { error: e2 } = await supabase.rpc('customer_update', {
      p_customer_id: customer.id,
      p_first_name: firstName,
      p_last_name: lastName,
      p_phone: phone,
      p_shipping_address_1: address1,
      p_shipping_address_2: address2,
      p_shipping_city: city,
      p_shipping_zip: zip,
      p_shipping_country: country,
    })
    if (e2) {
      setError(e2.message.replace(/^ERROR:\s+[A-Z0-9]{5}:\s*/, ''))
      setSubmitting(false)
      return
    }
    // getCustomerByEmail is wrapped in unstable_cache (600s revalidate),
    // so router.refresh() alone would serve the old row. Bust the tag
    // via a route handler first, then trigger the re-render.
    try {
      await fetch('/api/customer/revalidate', { method: 'POST' })
    } catch {
      // Non-fatal — worst case the operator sees the old address until
      // the 10-min cache TTL rolls over. The DB write is already committed.
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
        className="w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-xl p-5 md:p-6 space-y-4 max-h-[90vh] overflow-y-auto"
      >
        <div>
          <p className="text-xs uppercase tracking-wide text-zinc-500 font-medium">Edit customer</p>
          <p className="text-sm text-zinc-300 mt-1">{customer.email}</p>
          <p className="text-[11px] text-zinc-600 mt-0.5">
            Email isn&apos;t editable — it&apos;s the key linking orders to this record.
          </p>
        </div>

        {/* Contact */}
        <fieldset className="space-y-3">
          <legend className="text-[10px] uppercase tracking-wide text-zinc-500 font-medium">
            Contact
          </legend>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="First name">
              <input
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                disabled={submitting}
                className={inputCls}
              />
            </Field>
            <Field label="Last name">
              <input
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                disabled={submitting}
                className={inputCls}
              />
            </Field>
          </div>
          <Field label="Phone">
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={submitting}
              placeholder="+44 …"
              className={inputCls}
            />
          </Field>
        </fieldset>

        {/* Shipping address */}
        <fieldset className="space-y-3">
          <legend className="text-[10px] uppercase tracking-wide text-zinc-500 font-medium">
            Shipping address
          </legend>
          <Field label="Address line 1">
            <input
              type="text"
              value={address1}
              onChange={(e) => setAddress1(e.target.value)}
              disabled={submitting}
              className={inputCls}
            />
          </Field>
          <Field label="Address line 2">
            <input
              type="text"
              value={address2}
              onChange={(e) => setAddress2(e.target.value)}
              disabled={submitting}
              className={inputCls}
            />
          </Field>
          <div className="grid grid-cols-1 md:grid-cols-[1fr,140px] gap-3">
            <Field label="City">
              <input
                type="text"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                disabled={submitting}
                className={inputCls}
              />
            </Field>
            <Field label="Post / ZIP">
              <input
                type="text"
                value={zip}
                onChange={(e) => setZip(e.target.value)}
                disabled={submitting}
                className={inputCls}
              />
            </Field>
          </div>
          <Field label="Country">
            <input
              type="text"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              disabled={submitting}
              placeholder="United Kingdom"
              className={inputCls}
            />
            <p className="text-[10px] text-zinc-600 mt-1">
              Editing this clears the stored ISO country code so it stays consistent with the new label.
            </p>
          </Field>
        </fieldset>

        {error && (
          <p className="text-xs text-red-400 bg-red-950 border border-red-900/60 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        <div className="flex gap-2 justify-end pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 rounded-lg bg-[#3B9EE8] hover:bg-[#3691d4] disabled:opacity-50 text-white text-sm font-medium transition-colors"
          >
            {submitting ? 'Saving…' : 'Save changes'}
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
