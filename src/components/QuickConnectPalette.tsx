import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionProfile } from '../lib/profiles'

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
    return sessions.filter((s) =>
      `${s.label} ${s.username}@${s.host}`.toLowerCase().includes(q),
    )
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
      className="absolute inset-0 z-50 flex items-start justify-center bg-black/60 pt-24"
      onClick={onClose}
    >
      <div
        className="w-96 rounded-lg border border-white/10 bg-[#1f2028] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Jump to session..."
          className="w-full border-b border-white/10 bg-transparent px-3 py-2 text-sm text-white/90 outline-none"
        />
        <div className="max-h-72 overflow-y-auto py-1 text-xs">
          {results.length === 0 && (
            <p className="px-3 py-3 text-white/30">No matching sessions</p>
          )}
          {results.map((s, i) => (
            <div
              key={s.id}
              onMouseEnter={() => setIndex(i)}
              onClick={() => onSelect(s)}
              className={`cursor-pointer px-3 py-1.5 ${
                i === index ? 'bg-white/10 text-white' : 'text-white/70'
              }`}
            >
              <div className="truncate">{s.label}</div>
              <div className="truncate text-white/40">
                {s.username}@{s.host}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
