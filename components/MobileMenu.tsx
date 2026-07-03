'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Menu, X, Settings, UsersRound, Mail, Package } from 'lucide-react'
import { useAuth } from './AuthProvider'
import { canAccess, type Screen } from '@/lib/auth'

// Top-left burger menu, mobile only. Holds the four "less-often used"
// nav items (Settings, Users, Marketing, Catalogue) so the bottom nav
// stays uncluttered on small screens. Each entry is role-gated via
// canAccess, so support (who has none of these four) sees the button
// disappear entirely.
//
// Opens a full-height drawer from the left with a translucent scrim.

const items: ReadonlyArray<{
  href: string
  label: string
  Icon: typeof Menu
  screen: Screen
}> = [
  { href: '/settings',  label: 'Settings',  Icon: Settings,   screen: 'settings'  },
  { href: '/users',     label: 'Users',     Icon: UsersRound, screen: 'users'     },
  { href: '/marketing', label: 'Marketing', Icon: Mail,       screen: 'marketing' },
  { href: '/catalogue', label: 'Catalogue', Icon: Package,    screen: 'catalogue' },
]

export default function MobileMenu() {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()
  const { role } = useAuth()

  const visible = items.filter((item) => canAccess(role, item.screen))

  // Close the drawer whenever the pathname changes — i.e. after a
  // navigation completes. Avoids the drawer staying open behind the
  // fresh page.
  useEffect(() => { setOpen(false) }, [pathname])

  // Escape to close.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (visible.length === 0) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        className="md:hidden p-2 -ml-2 text-zinc-400 hover:text-white"
      >
        <Menu size={20} strokeWidth={1.75} />
      </button>

      {open && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <aside
            className="absolute inset-y-0 left-0 w-64 max-w-[80vw] bg-zinc-900 border-r border-zinc-800 flex flex-col shadow-2xl"
            style={{
              paddingTop: 'calc(env(safe-area-inset-top) + 0.5rem)',
              paddingBottom: 'env(safe-area-inset-bottom)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
              <p className="text-xs uppercase tracking-wide text-zinc-500 font-medium">Menu</p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close menu"
                className="p-2 -mr-2 text-zinc-400 hover:text-white"
              >
                <X size={18} strokeWidth={1.75} />
              </button>
            </div>

            <nav className="flex-1 overflow-y-auto py-2">
              {visible.map(({ href, label, Icon }) => {
                const active = pathname.startsWith(href)
                return (
                  <Link
                    key={href}
                    href={href}
                    className={`flex items-center gap-3 px-4 py-3 text-sm font-medium transition-colors ${
                      active
                        ? 'text-[#3B9EE8] bg-zinc-800/50'
                        : 'text-zinc-300 active:bg-zinc-800/70 active:text-white'
                    }`}
                    aria-current={active ? 'page' : undefined}
                  >
                    <Icon size={18} strokeWidth={1.75} />
                    <span>{label}</span>
                  </Link>
                )
              })}
            </nav>
          </aside>
        </div>
      )}
    </>
  )
}
