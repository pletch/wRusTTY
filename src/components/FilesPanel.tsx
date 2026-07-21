import { useEffect, useRef, useState } from 'react'
import { Channel } from '@tauri-apps/api/core'
import { ArrowUp, File, FileText, Folder, RefreshCw, X } from 'lucide-react'
import * as sftp from '../lib/sftp'
import type { RemoteEntry, SftpEvent } from '../lib/sftp'
import { toast } from '../lib/toast'

interface Props {
  sessionId: string
  onClose: () => void
}

function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  if (idx <= 0) return '/'
  return trimmed.slice(0, idx)
}

function join(dir: string, name: string): string {
  if (dir === '/') return `/${name}`
  return `${dir}/${name}`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`
}

export function FilesPanel({ sessionId, onClose }: Props) {
  const [cwd, setCwd] = useState<string | null>(null)
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // remotePath -> editId. Seeded from the backend on mount (see below) rather
  // than only from what this panel instance happened to open, because watches
  // outlive the panel: without that, closing and reopening the panel loses
  // every marker while the watches keep running and keep uploading on save.
  const [activeEdits, setActiveEdits] = useState<Record<string, string>>({})
  const channelRef = useRef<Channel<SftpEvent> | null>(null)

  function getChannel(): Channel<SftpEvent> {
    if (channelRef.current) return channelRef.current
    const channel = new Channel<SftpEvent>()
    channel.onmessage = (event) => {
      if (event.type === 'uploaded') {
        const name = event.remotePath.split('/').pop() || event.remotePath
        toast.success(`Saved ${name}`)
      } else if (event.type === 'uploadFailed') {
        toast.error(`Failed to save ${event.remotePath}: ${event.error}`)
      }
    }
    channelRef.current = channel
    return channel
  }

  async function load(path: string) {
    setLoading(true)
    setError(null)
    try {
      const list = await sftp.listDir(sessionId, path)
      list.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      setEntries(list)
      setCwd(path)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    sftp
      .canonicalize(sessionId, '.')
      .then((home) => {
        if (!cancelled) load(home)
      })
      .catch((err) => {
        if (!cancelled) setError(String(err))
      })
    // Adopt any watches already running for this session — ones this panel
    // started before it was last closed, which are still live and still
    // uploading. Best-effort: a failure here costs the markers, not the
    // directory listing, so it shouldn't surface an error over the panel.
    sftp
      .listEdits(sessionId)
      .then((edits) => {
        if (cancelled) return
        setActiveEdits(Object.fromEntries(edits.map((e) => [e.remotePath, e.editId])))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  async function open(entry: RemoteEntry) {
    if (!cwd) return
    const path = join(cwd, entry.name)
    if (entry.isDir) {
      load(path)
      return
    }
    try {
      toast.info(`Opening ${entry.name}`)
      const editId = await sftp.editFile(sessionId, path, getChannel())
      setActiveEdits((prev) => ({ ...prev, [path]: editId }))
    } catch (err) {
      toast.error(String(err))
    }
  }

  async function stopEditing(path: string) {
    const editId = activeEdits[path]
    if (!editId) return
    await sftp.stopWatching(editId).catch(() => {})
    setActiveEdits((prev) => {
      const next = { ...prev }
      delete next[path]
      return next
    })
    toast.info(`Stopped watching ${path.split('/').pop()}`)
  }

  return (
    <div
      className="animate-in fade-in slide-in-from-top-1 absolute right-2 top-10 z-40 flex w-96 flex-col rounded-lg border border-white/10 bg-[#1f2028] p-3 text-xs shadow-xl duration-100"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 font-medium text-white/90">
          <Folder size={13} /> Remote files
        </h2>
        <button
          onClick={onClose}
          className="flex items-center justify-center rounded p-1 text-white/40 transition-colors duration-100 hover:bg-white/10 hover:text-white/80"
        >
          <X size={13} />
        </button>
      </div>

      <div className="mb-2 flex items-center gap-1">
        <button
          onClick={() => cwd && load(parentOf(cwd))}
          disabled={!cwd || cwd === '/'}
          className="flex items-center justify-center rounded p-1 text-white/40 transition-colors duration-100 hover:bg-white/10 hover:text-white/80 disabled:opacity-30"
        >
          <ArrowUp size={13} />
        </button>
        <span className="min-w-0 flex-1 truncate text-white/60">{cwd ?? '…'}</span>
        <button
          onClick={() => cwd && load(cwd)}
          className="flex items-center justify-center rounded p-1 text-white/40 transition-colors duration-100 hover:bg-white/10 hover:text-white/80"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {error && <p className="mb-2 text-red-400">{error}</p>}

      <ul className="max-h-96 space-y-0.5 overflow-y-auto">
        {loading && <li className="px-2 py-1.5 text-white/40">Loading…</li>}
        {!loading && entries.length === 0 && !error && (
          <li className="px-2 py-1.5 text-white/40">Empty directory</li>
        )}
        {entries.map((entry) => {
          const path = cwd ? join(cwd, entry.name) : entry.name
          const editId = activeEdits[path]
          return (
            <li
              key={entry.name}
              onDoubleClick={() => open(entry)}
              className="flex cursor-default items-center justify-between gap-2 rounded px-2 py-1.5 hover:bg-white/5"
            >
              <span className="flex min-w-0 items-center gap-1.5 text-white/80">
                {entry.isDir ? (
                  <Folder size={12} className="shrink-0 text-sky-400/80" />
                ) : (
                  <FileText size={12} className="shrink-0 text-white/40" />
                )}
                <span className="truncate">{entry.name}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2 text-white/30">
                {editId && (
                  // "watching", not "editing": there's no way to detect an
                  // external editor closing (the OS hands the file off and
                  // returns immediately), so this deliberately persists until
                  // dismissed — otherwise the second save of an editing
                  // session would silently not upload. Labelled and shaped as
                  // a dismissable subscription so it reads as "still live,
                  // click to end" rather than a status stuck on.
                  <button
                    onClick={() => stopEditing(path)}
                    title="Watching for saves and uploading each one. Click to stop — this also deletes the local temp copy, so save in your editor first."
                    className="flex items-center gap-1 rounded px-1 py-0.5 text-sky-400/80 transition-colors duration-fast ease-swift hover:bg-white/10 hover:text-sky-300"
                  >
                    <File size={10} /> watching <X size={9} />
                  </button>
                )}
                {!entry.isDir && <span>{formatSize(entry.size)}</span>}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
