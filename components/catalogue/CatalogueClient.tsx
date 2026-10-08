'use client'

import { useState } from 'react'
import { AlertTriangle, Package } from 'lucide-react'
import type { Role } from '@/lib/auth'
import type { CampaignProductRow } from '@/lib/supabase'
import ProductsManager from './ProductsManager'
import InboxManager from './InboxManager'
import UnroutedOrdersPanel from './UnroutedOrdersPanel'
import type { Campaign, Product, Variant, UnroutedSuffix } from './types'

type Tab = 'products' | 'inbox'

export default function CatalogueClient({
  role,
  campaigns,
  products,
  variants,
  mappedLegacyCodes,
  observedByCampaign,
  pendingInboxCount,
  unroutedSuffixes,
  unroutedError,
  errors,
}: {
  role: Role
  campaigns: Campaign[]
  products: Product[]
  variants: Variant[]
  mappedLegacyCodes: string[]
  observedByCampaign: Record<number, CampaignProductRow[]>
  pendingInboxCount: number
  unroutedSuffixes: UnroutedSuffix[]
  unroutedError: string | null
  errors: { campaigns: string | null; products: string | null; variants: string | null }
}) {
  const [tab, setTab] = useState<Tab>('products')
  const [productInboxCount, setProductInboxCount] = useState(pendingInboxCount)
  const [unroutedCount, setUnroutedCount] = useState(unroutedSuffixes.length)
  const inboxBadge = productInboxCount + unroutedCount
  const mappedSet = new Set(mappedLegacyCodes)

  const errMsg = errors.campaigns || errors.products || errors.variants
  if (errMsg) {
    return (
      <div className="p-4 md:p-8">
        <div className="bg-red-950/40 border border-red-900/60 rounded-xl px-4 py-3">
          <p className="text-sm text-red-300">Catalogue read failed: {errMsg}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 md:p-8">
      <header className="mb-6 md:mb-8 flex items-center gap-3">
        <span className="inline-flex items-center justify-center w-9 h-9 md:w-10 md:h-10 rounded-lg bg-[#3B9EE8]">
          <Package size={18} className="text-white" strokeWidth={2.25} />
        </span>
        <div>
          <h1 className="text-xl md:text-2xl font-semibold text-white">Catalogue</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Products, variants and Shopify mappings. New Shopify variants and unrouted orders land in the Inbox.
          </p>
        </div>
      </header>

      {unroutedCount > 0 && tab !== 'inbox' && (
        <div className="mb-6 flex items-center justify-between gap-3 flex-wrap bg-amber-950/30 border border-amber-900/60 rounded-xl px-4 py-3">
          <p className="text-sm text-amber-200 flex items-center gap-2">
            <AlertTriangle size={15} className="shrink-0" />
            {unroutedCount} order suffix{unroutedCount === 1 ? '' : 'es'} not linked to a campaign
          </p>
          <button
            onClick={() => setTab('inbox')}
            className="px-3 py-1.5 text-xs font-bold rounded-md bg-amber-900/50 hover:bg-amber-900/70 text-amber-100 transition-colors"
          >
            Review
          </button>
        </div>
      )}

      {/* Sub-tabs — pill style consistent with the campaign-detail tabs */}
      <div className="flex items-center gap-2 mb-6" role="tablist">
        <PillButton active={tab === 'products'} onClick={() => setTab('products')} label="Products" count={products.length} />
        <PillButton
          active={tab === 'inbox'}
          onClick={() => setTab('inbox')}
          label="Inbox"
          count={inboxBadge}
          highlight={inboxBadge > 0}
        />
      </div>

      <div role="tabpanel" hidden={tab !== 'products'}>
        {tab === 'products' && (
          <ProductsManager
            role={role}
            campaigns={campaigns}
            products={products}
            variants={variants}
            mappedLegacyCodes={mappedSet}
            observedByCampaign={observedByCampaign}
          />
        )}
      </div>
      <div role="tabpanel" hidden={tab !== 'inbox'}>
        <UnroutedOrdersPanel
          initialRows={unroutedSuffixes}
          loadError={unroutedError}
          campaigns={campaigns}
          onCountChange={setUnroutedCount}
        />
        {tab === 'inbox' && (
          <InboxManager
            campaigns={campaigns}
            products={products}
            variants={variants}
            onInboxCountChange={setProductInboxCount}
          />
        )}
      </div>
    </div>
  )
}

function PillButton({
  active,
  onClick,
  label,
  count,
  highlight = false,
}: {
  active: boolean
  onClick: () => void
  label: string
  count: number
  highlight?: boolean
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`
        group relative flex items-center gap-2.5 px-5 py-2.5 rounded-full
        text-sm font-bold tracking-tight transition-all duration-150
        ${
          active
            ? 'bg-[#3B9EE8] text-white shadow-[0_0_0_1px_rgba(59,158,232,0.4),0_4px_20px_-4px_rgba(59,158,232,0.5)]'
            : 'bg-zinc-900 text-zinc-400 border border-zinc-800 hover:text-white hover:border-zinc-700 hover:bg-zinc-800/60'
        }
      `}
    >
      <span>{label}</span>
      <span
        className={`
          inline-flex items-center justify-center min-w-[1.5rem] h-5 px-1.5 rounded-full
          text-[11px] font-bold tabular-nums
          ${
            active
              ? 'bg-white/20 text-white'
              : highlight
              ? 'bg-amber-900/50 text-amber-300'
              : 'bg-zinc-800 text-zinc-400 group-hover:bg-zinc-700 group-hover:text-zinc-200'
          }
        `}
      >
        {count}
      </span>
    </button>
  )
}
