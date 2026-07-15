import { useEffect, useState } from 'react'
import * as profiles from '../lib/profiles'
import type { SessionProfile } from '../lib/profiles'

interface Props {
  onOpen: (profile: SessionProfile) => void
  /** Bump to force a refetch (e.g. after a new profile is saved elsewhere). */
  refreshToken: number
}

export function SessionManager({ onOpen, refreshToken }: Props) {
  const [sessions, setSessions] = useState<SessionProfile[]>([])
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)

  useEffect(() => {
    profiles.listSessions().then(setSessions).catch(() => setSessions([]))
  }, [refreshToken])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menu])

  async function remove(id: string) {
    await profiles.deleteSession(id).catch(() => {})
    setSessions((prev) => prev.filter((s) => s.id !== id))
  }

  const groups = new Map<string, SessionProfile[]>()
  for (const s of sessions) {
    const key = s.folder ?? 'Sessions'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(s)
  }

  return (
    <div className="flex w-56 shrink-0 flex-col border-r border-white/10 bg-black/10 text-xs">
      <div className="border-b border-white/10 px-3 py-2 text-white/50">Sessions</div>
      <div className="flex-1 overflow-y-auto">
        {sessions.length === 0 && (
          <p className="px-3 py-3 text-white/30">
            No saved sessions yet. Check "Save as session" when connecting.
          </p>
        )}
        {[...groups.entries()].map(([folder, items]) => (
          <div key={folder}>
            <div className="px-3 pt-2 text-[10px] uppercase tracking-wide text-white/30">
              {folder}
            </div>
            {items.map((s) => (
              <div
                key={s.id}
                onDoubleClick={() => onOpen(s)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ id: s.id, x: e.clientX, y: e.clientY })
                }}
                className="cursor-pointer px-3 py-1.5 text-white/70 hover:bg-white/5"
                title={`${s.username}@${s.host}:${s.port}`}
              >
                <div className="truncate text-white/90">{s.label}</div>
                <div className="truncate text-white/40">
                  {s.username}@{s.host}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      {menu && (
        <div
          className="fixed z-50 w-32 rounded border border-white/10 bg-[#1f2028] py-1 shadow-lg"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            className="block w-full px-3 py-1.5 text-left text-white/80 hover:bg-white/10"
            onClick={() => {
              const profile = sessions.find((s) => s.id === menu.id)
              if (profile) onOpen(profile)
              setMenu(null)
            }}
          >
            Open
          </button>
          <button
            className="block w-full px-3 py-1.5 text-left text-red-300 hover:bg-white/10"
            onClick={() => {
              remove(menu.id)
              setMenu(null)
            }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  )
}
