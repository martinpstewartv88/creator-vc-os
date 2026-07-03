'use client'

import { LogOut } from 'lucide-react'
import Logo from './Logo'
import { useAuth } from './AuthProvider'
import ThemeToggle from './ThemeToggle'
import MobileMenu from './MobileMenu'

export default function MobileTopBar() {
  const { signOut } = useAuth()

  return (
    <header
      className="md:hidden flex items-center justify-between bg-zinc-900 border-b border-zinc-800 px-4 py-3 sticky top-0 z-30"
      style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
    >
      <div className="flex items-center gap-2">
        <MobileMenu />
        <Logo size="sm" />
      </div>
      <div className="flex items-center">
        <ThemeToggle variant="icon" />
        <button
          onClick={signOut}
          aria-label="Sign out"
          className="p-2 -mr-2 text-zinc-400 hover:text-white"
        >
          <LogOut size={18} strokeWidth={1.75} />
        </button>
      </div>
    </header>
  )
}
