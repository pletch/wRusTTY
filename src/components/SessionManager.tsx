import { useEffect, useState } from 'react'
import { Folder, Server, ExternalLink, Trash2, PanelLeft } from 'lucide-react'
import * as profiles from '../lib/profiles'
import type { SessionProfile } from '../lib/profiles'
import { toast } from '../lib/toast'

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
    const label = sessions.find((s) => s.id === id)?.label
    try {
      await profiles.deleteSession(id)
      setSessions((prev) => prev.filter((s) => s.id !== id))
      toast.info(label ? `Deleted "${label}"` : 'Session deleted')
    } catch (err) {
      toast.error(`Couldn't delete session: ${err}`)
    }
  }

  const groups = new Map<string, SessionProfile[]>()
  for (const s of sessions) {
    const key = s.folder ?? 'Sessions'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(s)
  }

  return (
    <div className="flex w-56 shrink-0 flex-col border-r border-white/10 bg-black/10 text-xs">
      <div className="flex items-center gap-1.5 border-b border-white/10 px-3 py-2.5 text-white/50">
        <PanelLeft size={13} />
        <span>Sessions</span>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {sessions.length === 0 && (
          <p className="px-3 py-3 leading-relaxed text-white/30">
            No saved sessions yet. Check "Save as session" when connecting.
          </p>
        )}
        {[...groups.entries()].map(([folder, items]) => (
          <div key={folder}>
            <div className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[10px] uppercase tracking-wide text-white/30">
              <Folder size={10} />
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
                className="mx-1 flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-white/70 transition-colors duration-100 hover:bg-white/[0.06]"
                title={`${s.username}@${s.host}:${s.port}`}
              >
                <Server size={12} className="mt-0.5 shrink-0 text-white/30" />
                <div className="min-w-0">
                  <div className="truncate text-white/90">{s.label}</div>
                  <div className="truncate text-white/40">
                    {s.username}@{s.host}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      {menu && (
        <div
          className="animate-in fade-in zoom-in-95 fixed z-50 w-36 origin-top-left rounded-md border border-white/10 bg-[#1f2028] py-1 shadow-xl duration-100"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/80 transition-colors duration-100 hover:bg-white/10"
            onClick={() => {
              const profile = sessions.find((s) => s.id === menu.id)
              if (profile) onOpen(profile)
              setMenu(null)
            }}
          >
            <ExternalLink size={13} /> Open
          </button>
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-300 transition-colors duration-100 hover:bg-white/10"
            onClick={() => {
              remove(menu.id)
              setMenu(null)
            }}
          >
            <Trash2 size={13} /> Delete
          </button>
        </div>
      )}
    </div>
  )
}
