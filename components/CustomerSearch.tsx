'use client'

import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { useRef, useTransition } from 'react'
import { Loader2 } from 'lucide-react'

export default function CustomerSearch({ defaultValue }: { defaultValue?: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const inputRef = useRef<HTMLInputElement>(null)
  // useTransition wraps router.push so we get an isPending flag while
  // the server re-renders. Reiner asked for a "searching…" indicator;
  // this covers both the round-trip AND the browser-side navigation.
  const [isPending, startTransition] = useTransition()

  function submit(q: string) {
    const params = new URLSearchParams(searchParams.toString())
    params.delete('page')
    if (q.trim()) {
      params.set('q', q.trim())
    } else {
      params.delete('q')
    }
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`)
    })
  }

  function handleClear() {
    if (inputRef.current) inputRef.current.value = ''
    submit('')
  }

  return (
    <div className="flex items-center gap-2 w-full sm:w-auto">
      <div className="relative flex-1 sm:flex-initial">
        <input
          ref={inputRef}
          type="text"
          defaultValue={defaultValue}
          placeholder="Search name, email or order number…"
          disabled={isPending}
          onKeyDown={e => e.key === 'Enter' && submit((e.target as HTMLInputElement).value)}
          className="bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-2 pr-9 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500 w-full sm:w-64 disabled:opacity-60"
        />
        {isPending ? (
          <Loader2
            size={16}
            strokeWidth={2}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 animate-spin"
            aria-label="Searching"
          />
        ) : defaultValue ? (
          <button
            onClick={handleClear}
            disabled={isPending}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white transition-colors text-lg leading-none disabled:opacity-50"
          >
            ×
          </button>
        ) : null}
      </div>
      <button
        onClick={() => submit(inputRef.current?.value ?? '')}
        disabled={isPending}
        className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 disabled:bg-zinc-800/50 text-sm text-white rounded-lg transition-colors inline-flex items-center gap-2"
      >
        {isPending && <Loader2 size={14} strokeWidth={2} className="animate-spin" />}
        {isPending ? 'Searching…' : 'Search'}
      </button>
    </div>
  )
}
