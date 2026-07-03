import { getCustomerByEmail } from '@/lib/supabase'
import { createClient } from '@/lib/supabase-server'
import { listCustomerTickets } from '@/lib/tickets'

// Bump Vercel's default 10s function timeout. get_customer_detail is
// ~1.1s warm; allowing 60s gives margin for the parallel tickets fetch
// and any cold-cache surprise.
export const maxDuration = 60
import Link from 'next/link'
import { notFound } from 'next/navigation'
import CustomerCampaigns from '@/components/CustomerCampaigns'
import CustomerTicketsList from '@/components/CustomerTicketsList'
import CustomerActivityTabs from '@/components/CustomerActivityTabs'
import EditCustomerButton from '@/components/EditCustomerButton'
import ChangeEmailButton from '@/components/ChangeEmailButton'

function fmt(n: number | string | null, currency = false) {
  if (n === null || n === undefined) return '—'
  const num = typeof n === 'string' ? parseFloat(n) : n
  if (isNaN(num)) return '—'
  if (currency) return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(num)
  return new Intl.NumberFormat('en-US').format(num)
}

type CampaignDetail = { campaign_name: string; campaign_id: number; legacy_code: string; source: string }

export default async function CustomerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ email: string }>
  searchParams: Promise<{ campaign?: string }>
}) {
  const [{ email: encodedEmail }, sp] = await Promise.all([params, searchParams])
  const email = decodeURIComponent(encodedEmail)
  const fromCampaignId = sp.campaign ? parseInt(sp.campaign, 10) : undefined

  const customer = await getCustomerByEmail(email).catch(() => null)
  if (!customer) notFound()

  // Inline tickets list — fetched server-side with the cookie-aware client
  // so the RPC's staff-only check sees our session. We tolerate the call
  // failing (e.g. session race during sign-in) and just hide the section.
  const ticketsClient = await createClient()
  const customerTickets = await listCustomerTickets(ticketsClient, customer.id).catch(() => [])

  const allCampaigns: CampaignDetail[] = [
    ...((customer.campaign_orders_detail as CampaignDetail[]) ?? []),
    ...((customer.raw_orders_detail as CampaignDetail[]) ?? []),
    ...((customer.isod_orders_detail as CampaignDetail[]) ?? []),
    // Historic platforms (wix / gumroad / shopify_legacy) — populated by
    // the 27 May 2026 customer_summary patch.
    ...((customer.historic_orders_detail as CampaignDetail[]) ?? []),
  ]
  const campaigns = [...new Map(allCampaigns.map(x => [x.campaign_id, x])).values()]

  const addressLines = [
    customer.shipping_address_1,
    customer.shipping_address_2,
    [customer.shipping_city, customer.shipping_zip].filter(Boolean).join(' '),
    customer.shipping_country,
  ].filter(Boolean)

  const fromCampaign = fromCampaignId
    ? campaigns.find(c => c.campaign_id === fromCampaignId)
    : undefined

  return (
    <div className="p-4 md:p-8">
      <div className="mb-4 md:mb-6">
        {fromCampaign ? (
          <Link
            href={`/campaigns/${fromCampaignId}`}
            className="text-xs text-zinc-500 hover:text-white transition-colors"
          >
            ← {fromCampaign.campaign_name}
          </Link>
        ) : (
          <Link href="/customers" className="text-xs text-zinc-500 hover:text-white transition-colors">
            ← Customers
          </Link>
        )}
      </div>

      <div className="mb-6 md:mb-8 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl md:text-2xl font-semibold text-white break-words">{customer.full_name || email}</h1>
          <p className="text-xs md:text-sm text-zinc-500 mt-1 break-all">{email}{customer.phone ? ` · ${customer.phone}` : ''}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ChangeEmailButton customer={{ id: customer.id, email: customer.email }} />
          <EditCustomerButton
            customer={{
              id: customer.id,
              email: customer.email,
              first_name: customer.first_name,
              last_name: customer.last_name,
              phone: customer.phone,
              shipping_address_1: customer.shipping_address_1,
              shipping_address_2: customer.shipping_address_2,
              shipping_city: customer.shipping_city,
              shipping_zip: customer.shipping_zip,
              shipping_country: customer.shipping_country,
            }}
          />
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4 mb-6 md:mb-8">
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 md:p-5">
          <p className="text-[11px] md:text-xs text-zinc-500 uppercase tracking-wide font-medium">Total Spent</p>
          <p className="text-xl md:text-2xl font-semibold text-white mt-2">{fmt(customer.total_spend, true)}</p>
          <p className="text-[10px] md:text-xs text-zinc-600 mt-1">{customer.total_line_items} line items · {customer.total_quantity_purchased} units</p>
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 md:p-5">
          <p className="text-[11px] md:text-xs text-zinc-500 uppercase tracking-wide font-medium">Orders</p>
          <p className="text-xl md:text-2xl font-semibold text-white mt-2">{customer.total_orders}</p>
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 md:p-5">
          <p className="text-[11px] md:text-xs text-zinc-500 uppercase tracking-wide font-medium">Shipping Address</p>
          {addressLines.length > 0 ? (
            <div className="mt-2 space-y-0.5">
              {addressLines.map((line, i) => (
                <p key={i} className="text-sm text-white">{line}</p>
              ))}
            </div>
          ) : (
            <p className="text-sm text-zinc-500 mt-2">No address on file</p>
          )}
        </div>
      </div>

      {/* Activity — Campaigns + Tickets behind tabs so the page stays
          compact. Both panels are kept mounted so CustomerCampaigns'
          expansion / fetched-orders state survives tab switches. */}
      <CustomerActivityTabs
        campaignCount={campaigns.length}
        ticketCount={customerTickets.length}
        campaignsSlot={
          <CustomerCampaigns
            campaigns={campaigns}
            email={email}
            initialCampaignId={fromCampaignId}
          />
        }
        ticketsSlot={<CustomerTicketsList tickets={customerTickets} />}
      />
    </div>
  )
}
