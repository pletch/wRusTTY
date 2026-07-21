import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, Server, Network } from 'lucide-react'
import type { SessionProfile } from '../lib/profiles'
import { profileSubtitle } from '../lib/profiles'

interface Props {
  sessions: SessionProfile[]
  onSelect: (profile: SessionProfile) => void
  onClose: () => void
}

export function QuickConnectPalette({ sessions, onSelect, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter((s) => `${s.label} ${profileSubtitle(s)}`.toLowerCase().includes(q))
  }, [sessions, query])

  useEffect(() => {
    setIndex(0)
  }, [query])

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const profile = results[index]
      if (profile) onSelect(profile)
    }
  }

  return (
    <div
      className="animate-in fade-in absolute inset-0 z-50 flex items-start justify-center bg-black/60 pt-24 duration-150"
      onClick={onClose}
    >
      <div
        className="animate-in fade-in zoom-in-95 slide-in-from-top-2 w-96 rounded-xl border border-white/10 bg-[#1f2028] shadow-2xl duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-white/10 px-3">
          <Search size={14} className="shrink-0 text-white/40" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Jump to session..."
            className="w-full bg-transparent py-2.5 text-sm text-white/90 outline-none placeholder:text-white/30"
          />
        </div>
        <div className="max-h-72 overflow-y-auto p-1 text-xs">
          {results.length === 0 && (
            <p className="px-3 py-3 text-white/30">No matching sessions</p>
          )}
          {results.map((s, i) => (
            <div
              key={s.id}
              onMouseEnter={() => setIndex(i)}
              onClick={() => onSelect(s)}
              className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors duration-100 ${
                i === index ? 'bg-white/10 text-white' : 'text-white/70'
              }`}
            >
              {s.protocol === 'telnet' ? (
                <Network size={13} className="shrink-0 text-amber-400/40" />
              ) : (
                <Server size={13} className="shrink-0 text-white/30" />
              )}
              <div className="min-w-0">
                <div className="truncate">{s.label}</div>
                <div className="truncate text-white/40">{profileSubtitle(s)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
