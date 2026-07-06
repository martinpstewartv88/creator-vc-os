import { NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'
import { createClient } from '@/lib/supabase-server'

// Bust the customer-detail + customer list caches after a staff edit.
//
// EditCustomerButton calls customer_update RPC client-side and then hits
// this route so the SSR-rendered detail page re-fetches on the next
// router.refresh() instead of serving the stale unstable_cache entry.
//
// Staff-only. The Supabase server client resolves the caller's role from
// their session cookie; if they aren't signed in, we 401.

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  // Any staff row is enough — customer_update itself enforces the same.
  const { data: roleRow } = await supabase
    .from('app_user_roles')
    .select('role')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!roleRow?.role) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  // Immediate expiration on both tags. Next 16's revalidateTag second
  // arg selects between stale-while-revalidate ('max') and immediate
  // (expire: 0) — we want fresh data on the next render.
  revalidateTag('customer-detail', { expire: 0 })
  revalidateTag('customers-list', { expire: 0 })

  return NextResponse.json({ ok: true })
}
