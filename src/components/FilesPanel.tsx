import { useEffect, useRef, useState } from 'react'
import { Channel } from '@tauri-apps/api/core'
import { open as openDialog, save } from '@tauri-apps/plugin-dialog'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import {
  ArrowUp,
  ClipboardCopy,
  Download,
  File,
  FilePen,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  KeyRound,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import * as sftp from '../lib/sftp'
import type { RemoteEntry, SftpEvent } from '../lib/sftp'
import { toast } from '../lib/toast'
import { formatBytes } from '../lib/formatBytes'
import { formatMode, formatOctal, parseOctal } from '../lib/fileMode'
import {
  expandHome,
  nameError,
  safeSuggestedName,
  verdictForDownload,
  verdictForMutation,
} from '../lib/fileActions'
import { useDismissable } from '../hooks/useDismissable'
import { useConfirm } from './confirmContext'

interface Props {
  sessionId: string
  /**
   * Where to open, if the host has reported a working directory.
   *
   * The same directory a file dropped on this pane would land in, and for the
   * same reason: it is where the user believes they are. Opening at the remote
   * home instead meant the panel and the drop disagreed about "here" — you
   * could drop a file onto a pane sitting in `/etc/nginx`, open the panel to
   * check it arrived, and be looking at `/home/tim`.
   *
   * May be `~`-relative — it can come from a window title, and bash prompts
   * render the home directory that way. Resolved on open, since SFTP will not.
   *
   * Null when there is nothing to go on at all, which falls back to the remote
   * home. See `startDirFor` for where it comes from.
   */
  startDir: string | null
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

/** The last path segment, whichever separator the OS used. A picked local path
 *  is the only place this panel sees a Windows-shaped path. */
function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

/** A transfer this panel started, in either direction.
 *
 * `id` is null only for the moment between asking for a transfer and being told
 * its id — short, but long enough to click the cancel button in, which is why
 * the row renders before the id exists rather than after. */
interface Transfer {
  id: string | null
  name: string
  direction: 'up' | 'down'
  transferred: number
  total: number
}

export function FilesPanel({ sessionId, startDir, onClose }: Props) {
  // Rendered only while open, so it is always dismissable while mounted.
  useDismissable(true, onClose, { within: '[data-files-panel], [data-files-toggle]' })
  const confirm = useConfirm()
  // The channel's handler is built once and would otherwise hold the first
  // render's `confirm` forever — the same reason Terminal.tsx keeps one.
  const confirmRef = useRef(confirm)
  confirmRef.current = confirm
  const [cwd, setCwd] = useState<string | null>(null)
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // remotePath -> editId. Seeded from the backend on mount (see below) rather
  // than only from what this panel instance happened to open, because watches
  // outlive the panel: without that, closing and reopening the panel loses
  // every marker while the watches keep running and keep uploading on save.
  const [activeEdits, setActiveEdits] = useState<Record<string, string>>({})
  const [menu, setMenu] = useState<{ entry: RemoteEntry; x: number; y: number } | null>(null)
  const [transfer, setTransfer] = useState<Transfer | null>(null)
  // The one inline text field the panel ever shows: renaming an existing entry,
  // or naming a new directory. One at a time, because it is one field — and
  // because two open at once would leave the user unsure which Enter they were
  // pressing.
  const [naming, setNaming] = useState<
    | { kind: 'rename'; original: string; draft: string }
    | { kind: 'chmod'; original: string; draft: string }
    | { kind: 'mkdir'; draft: string }
    | null
  >(null)
  // Read by `commitNaming` instead of the state it mirrors. The field commits
  // on blur, and a successful Enter clears it — so the blur that follows the
  // field being torn down would otherwise submit a second time against the
  // render's stale `naming`, and the user would see "already exists" for the
  // rename that had just worked.
  const namingRef = useRef<typeof naming>(null)
  namingRef.current = naming
  const channelRef = useRef<Channel<SftpEvent> | null>(null)
  // Read inside the channel callback, which is created once and would otherwise
  // close over the first render's `cwd` forever — a download finishing would
  // then refresh whichever directory the panel opened on.
  const cwdRef = useRef<string | null>(null)
  cwdRef.current = cwd

  function getChannel(): Channel<SftpEvent> {
    if (channelRef.current) return channelRef.current
    const channel = new Channel<SftpEvent>()
    channel.onmessage = (event) => {
      switch (event.type) {
        // An edit being saved: no progress, nothing to cancel.
        case 'uploaded':
          toast.success(`Saved ${basename(event.remotePath)}`)
          break
        case 'uploadFailed':
          toast.error(`Failed to save ${event.remotePath}: ${event.error}`)
          break
        case 'uploadConflict': {
          // Nothing has been written at this point — the save stopped. So the
          // dialog is offering to *make* the change, not to undo one, and the
          // safe answer is the one you get by dismissing it.
          const when = event.remoteModified
            ? new Date(event.remoteModified * 1000).toLocaleString()
            : null
          void confirmRef
            .current({
              title: `${basename(event.remotePath)} changed on the host`,
              body:
                `Your save was not made. ${event.remotePath} was modified` +
                `${when ? ` at ${when}` : ''} after you opened it — by another session, ` +
                `by someone else, or by something running on the host.\n\n` +
                `Overwriting replaces those changes with your copy. To keep them instead, ` +
                `cancel, then stop watching the file and open it again.`,
              confirmLabel: 'Overwrite',
            })
            .then((ok) => {
              if (!ok) return
              void sftp
                .saveEdit(event.editId, true, getChannel())
                .catch((err) => toast.error(String(err)))
            })
          break
        }
        // An explicit transfer. Only the backend knows the total for these —
        // a download's from `stat`, a picked upload's from the file itself.
        case 'transferStarted':
          setTransfer((t) => (t ? { ...t, total: event.total } : t))
          break
        case 'transferProgress':
          setTransfer((t) => (t ? { ...t, transferred: event.transferred } : t))
          break
        case 'transferDone':
          setTransfer((t) => {
            toast.success(
              t?.direction === 'down'
                ? `Downloaded ${t.name}`
                : `Uploaded ${t?.name ?? basename(event.remotePath)}`,
            )
            return null
          })
          // An upload changed the directory being shown; a download didn't, but
          // reloading costs one listing and keeps the size column honest if the
          // file was being written while it was read.
          if (cwdRef.current) void load(cwdRef.current)
          break
        case 'transferCancelled':
          setTransfer((t) => {
            toast.info(`${t?.direction === 'down' ? 'Download' : 'Upload'} cancelled`)
            return null
          })
          break
        case 'transferFailed':
          setTransfer(null)
          toast.error(`Transfer failed: ${event.error}`)
          break
      }
    }
    channelRef.current = channel
    return channel
  }

  /**
   * Lists `path` and shows it, reporting whether it worked.
   *
   * `quiet` suppresses the error banner for an attempt the caller intends to
   * recover from — opening at a reported directory that may be stale. Showing
   * "no such directory" and *then* silently succeeding somewhere else would be
   * the worst of both.
   */
  async function load(path: string, { quiet = false } = {}): Promise<boolean> {
    setLoading(true)
    if (!quiet) setError(null)
    try {
      const list = await sftp.listDir(sessionId, path)
      list.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      setEntries(list)
      setCwd(path)
      return true
    } catch (err) {
      if (!quiet) setError(String(err))
      return false
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    // `startDir` is read once, at mount. Following it afterwards would yank the
    // listing out from under someone who had navigated elsewhere in the panel,
    // every time they ran `cd` in the terminal behind it — the panel is a place
    // you browse, not a mirror of the prompt.
    const openAt = async () => {
      let home: string | null = null
      let target = startDir
      // A `~` has to be resolved before it is sent: SFTP has no tilde
      // expansion, so `~/src` would ask for a directory literally called `~`.
      // Bash prompts render the home directory that way, so this is the common
      // case for exactly the hosts the title guess exists to serve.
      if (target?.startsWith('~')) {
        home = await sftp.canonicalize(sessionId, '.')
        if (cancelled) return
        target = expandHome(target, home)
      }
      // Aimed, but not guaranteed: the host may have moved on, the directory
      // may be gone, and a title-derived guess may never have been a directory
      // at all. Falling back beats opening on an error — the panel still works,
      // just not where it was pointed.
      if (target && (await load(target, { quiet: true }))) return
      if (cancelled) return
      home ??= await sftp.canonicalize(sessionId, '.')
      if (cancelled) return
      load(home)
    }
    openAt().catch((err) => {
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

  /** Save a remote file somewhere the user picks.
   *
   * The dialog is what makes this route better than dragging a file out of the
   * panel would be: it hands over a real local path, so the bytes never cross
   * IPC — the backend reads the SFTP stream and writes straight to disk. */
  async function download(entry: RemoteEntry) {
    if (!cwd) return
    const verdict = verdictForDownload({ isDir: entry.isDir, busy: transfer !== null })
    if (!verdict.ok) {
      toast.error(verdict.reason)
      return
    }
    const remotePath = join(cwd, entry.name)
    let localPath: string | null
    try {
      localPath = await save({ defaultPath: safeSuggestedName(entry.name) })
    } catch (err) {
      toast.error(`Could not open the save dialog: ${String(err)}`)
      return
    }
    // Dismissed. Not an error and not worth a toast — the user changed their
    // mind, and they know it.
    if (!localPath) return

    // `entry.size` is the listing's, which may be minutes old; the backend
    // stats the file and sends the real total as `transferStarted`.
    setTransfer({
      id: null,
      name: basename(localPath),
      direction: 'down',
      transferred: 0,
      total: entry.size,
    })
    try {
      const id = await sftp.downloadBegin(sessionId, remotePath, localPath, getChannel())
      setTransfer((t) => (t ? { ...t, id } : t))
    } catch (err) {
      setTransfer(null)
      toast.error(`Download failed: ${String(err)}`)
    }
  }

  /** Upload into the directory being shown, from a file picker.
   *
   * The route for anyone who would rather not drag — and the cheaper one, since
   * a picked file has a path and its bytes never touch the webview. */
  async function uploadHere() {
    if (!cwd) return
    if (transfer) {
      toast.error('One transfer at a time — wait for the current one to finish.')
      return
    }
    let picked: string | string[] | null
    try {
      picked = await openDialog({ multiple: false, directory: false })
    } catch (err) {
      toast.error(`Could not open the file picker: ${String(err)}`)
      return
    }
    if (!picked || Array.isArray(picked)) return

    const name = basename(picked)
    const remotePath = join(cwd, name)
    let overwrite = false
    try {
      if (await sftp.exists(sessionId, remotePath)) {
        const replace = await confirm({
          title: `Replace ${name}?`,
          body: `${remotePath} already exists. The existing file is left alone unless the whole upload succeeds.`,
          confirmLabel: 'Replace',
        })
        if (!replace) return
        overwrite = true
      }
    } catch (err) {
      toast.error(`Could not check ${remotePath}: ${String(err)}`)
      return
    }

    setTransfer({ id: null, name, direction: 'up', transferred: 0, total: 0 })
    try {
      const id = await sftp.uploadPath(sessionId, cwd, picked, overwrite, getChannel())
      setTransfer((t) => (t ? { ...t, id } : t))
    } catch (err) {
      setTransfer(null)
      toast.error(`Upload failed: ${String(err)}`)
    }
  }

  /** Rename or mkdir, whichever field is open. Both end the same way: reload
   *  the directory, which is the only thing that proves it worked. */
  async function commitNaming() {
    const current = namingRef.current
    if (!current || !cwd) return

    if (current.kind === 'chmod') {
      const mode = parseOctal(current.draft)
      if (mode === null) {
        // Left open, and deliberately not "corrected". A field that read `8` as
        // something would set a permission the user did not ask for, and
        // `chmod 000` on the wrong remote file is a bad afternoon.
        toast.error('Permissions must be octal — 755, 644, 1777.')
        return
      }
      namingRef.current = null
      try {
        await sftp.chmod(sessionId, join(cwd, current.original), mode)
        toast.success(`${current.original} is now ${formatOctal(mode)}`)
        setNaming(null)
        load(cwd)
      } catch (err) {
        namingRef.current = current
        toast.error(String(err))
      }
      return
    }

    const draft = current.draft.trim()
    if (current.kind === 'rename' && draft === current.original) {
      setNaming(null)
      return
    }
    const problem = nameError(draft)
    if (problem) {
      toast.error(problem)
      return
    }
    // Cleared before the await, not after: this is what makes the trailing
    // blur a no-op, and it is also what stops a slow server turning one Enter
    // into two renames.
    namingRef.current = null
    try {
      if (current.kind === 'rename') {
        await sftp.rename(sessionId, join(cwd, current.original), draft)
        toast.success(`Renamed to ${draft}`)
      } else {
        await sftp.mkdir(sessionId, cwd, draft)
        toast.success(`Created ${draft}`)
      }
      setNaming(null)
      load(cwd)
    } catch (err) {
      // Left open on failure — the name is still in the field, and the usual
      // reason is that something is already called that, which the user fixes
      // by typing rather than by starting over. The ref has to come back with
      // it: nothing re-renders on this path, so without this the field would
      // still be on screen and no longer able to submit.
      namingRef.current = current
      toast.error(String(err))
    }
  }

  async function remove(entry: RemoteEntry) {
    if (!cwd) return
    const path = join(cwd, entry.name)
    const verdict = verdictForMutation({ watched: Boolean(activeEdits[path]) })
    if (!verdict.ok) {
      toast.error(verdict.reason)
      return
    }
    const ok = await confirm({
      title: `Delete ${entry.name}?`,
      // Named plainly rather than softened. This is a remote host the user may
      // not easily get back to, there is no undo, and there is no recycle bin
      // on the far side.
      body: entry.isDir
        ? `${path} will be deleted. This cannot be undone, and only works if the directory is empty.`
        : `${path} will be deleted on the remote host. This cannot be undone.`,
      confirmLabel: 'Delete',
    })
    if (!ok) return
    try {
      await sftp.remove(sessionId, path)
      toast.success(`Deleted ${entry.name}`)
      load(cwd)
    } catch (err) {
      toast.error(String(err))
    }
  }

  async function copyPath(entry: RemoteEntry) {
    if (!cwd) return
    try {
      await writeText(join(cwd, entry.name))
      toast.info('Path copied')
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
    toast.info(`Stopped watching ${basename(path)}`)
  }

  const menuItem =
    'flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors duration-100 hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent'

  /** The inline name field, shared by rename and mkdir.
   *
   * `autoFocus` because both are opened by a click somewhere else entirely (a
   * menu item, a toolbar button) and the user's next act is unambiguously to
   * type. Blur commits rather than cancels: clicking away from a field you have
   * just typed a name into reads as "done", and the alternative silently throws
   * the name away. */
  const nameField = (value: string, onChange: (v: string) => void) => (
    <input
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => void commitNaming()}
      onKeyDown={(e) => {
        // Stopped from propagating so Escape reaches this field and not the
        // panel's own dismiss handler, which would close the whole panel.
        e.stopPropagation()
        if (e.key === 'Enter') void commitNaming()
        if (e.key === 'Escape') setNaming(null)
      }}
      className="min-w-0 flex-1 rounded border border-sky-400/40 bg-black/30 px-1 py-0.5 text-white/90 outline-none"
    />
  )

  return (
    <div
      data-files-panel
      className="animate-in fade-in slide-in-from-top-1 absolute right-2 top-10 z-40 flex w-96 flex-col rounded-lg border border-white/10 bg-[#1f2028] p-3 text-xs shadow-xl duration-100"
      onClick={(e) => {
        e.stopPropagation()
        // The panel stops the click reaching window, so the menu cannot rely on
        // an outside-click listener the way the tab strip's does — anywhere
        // else in the panel has to close it explicitly. Menu items run first
        // (React dispatches target-first), so their work is already done.
        setMenu(null)
      }}
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
          title="Up one directory"
          className="flex items-center justify-center rounded p-1 text-white/40 transition-colors duration-100 hover:bg-white/10 hover:text-white/80 disabled:opacity-30"
        >
          <ArrowUp size={13} />
        </button>
        <span className="min-w-0 flex-1 truncate text-white/60">{cwd ?? '…'}</span>
        <button
          onClick={() => setNaming({ kind: 'mkdir', draft: '' })}
          disabled={!cwd}
          title="New folder"
          className="flex items-center justify-center rounded p-1 text-white/40 transition-colors duration-100 hover:bg-white/10 hover:text-white/80 disabled:opacity-30"
        >
          <FolderPlus size={12} />
        </button>
        <button
          onClick={uploadHere}
          disabled={!cwd || transfer !== null}
          title="Upload a file into this directory"
          className="flex items-center justify-center rounded p-1 text-white/40 transition-colors duration-100 hover:bg-white/10 hover:text-white/80 disabled:opacity-30"
        >
          <Upload size={12} />
        </button>
        <button
          onClick={() => cwd && load(cwd)}
          title="Refresh"
          className="flex items-center justify-center rounded p-1 text-white/40 transition-colors duration-100 hover:bg-white/10 hover:text-white/80"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {error && <p className="mb-2 text-red-400">{error}</p>}

      <ul className="max-h-96 space-y-0.5 overflow-y-auto">
        {loading && <li className="px-2 py-1.5 text-white/40">Loading…</li>}
        {!loading && entries.length === 0 && !error && !naming && (
          <li className="px-2 py-1.5 text-white/40">Empty directory</li>
        )}
        {naming?.kind === 'mkdir' && (
          // At the top, where the sort would put it anyway — directories sort
          // first — so the row does not jump when it becomes real.
          <li className="flex items-center gap-1.5 rounded px-2 py-1.5">
            <Folder size={12} className="shrink-0 text-sky-400/80" />
            {nameField(naming.draft, (draft) => setNaming({ kind: 'mkdir', draft }))}
          </li>
        )}
        {entries.map((entry) => {
          const path = cwd ? join(cwd, entry.name) : entry.name
          const editId = activeEdits[path]
          return (
            <li
              key={entry.name}
              onDoubleClick={() => open(entry)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ entry, x: e.clientX, y: e.clientY })
              }}
              className="flex cursor-default items-center justify-between gap-2 rounded px-2 py-1.5 hover:bg-white/5"
            >
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-white/80">
                {entry.isDir ? (
                  <Folder size={12} className="shrink-0 text-sky-400/80" />
                ) : (
                  <FileText size={12} className="shrink-0 text-white/40" />
                )}
                {naming?.kind === 'rename' && naming.original === entry.name ? (
                  nameField(naming.draft, (draft) =>
                    setNaming({ kind: 'rename', original: entry.name, draft }),
                  )
                ) : (
                  <span className="truncate">{entry.name}</span>
                )}
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
                {naming?.kind === 'chmod' && naming.original === entry.name ? (
                  // The field takes the place of the column it edits, so the
                  // before and after are in the same spot.
                  <input
                    autoFocus
                    value={naming.draft}
                    onChange={(e) =>
                      setNaming({ kind: 'chmod', original: entry.name, draft: e.target.value })
                    }
                    onBlur={() => void commitNaming()}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') void commitNaming()
                      if (e.key === 'Escape') setNaming(null)
                    }}
                    size={4}
                    className="w-12 rounded border border-sky-400/40 bg-black/30 px-1 py-0.5 text-right font-mono text-white/90 outline-none"
                  />
                ) : (
                  entry.mode !== null && (
                    <span
                      className="font-mono text-white/25"
                      // The octal is what you type into the field and what
                      // every chmod example is written in; the letters are what
                      // you can scan a column of. Both, rather than a choice.
                      title={`${formatOctal(entry.mode)}${
                        entry.owner ? ` — ${entry.owner}${entry.group ? `:${entry.group}` : ''}` : ''
                      }`}
                    >
                      {formatMode(entry.mode)}
                    </span>
                  )
                )}
                {!entry.isDir && <span className="w-16 text-right">{formatBytes(entry.size)}</span>}
              </span>
            </li>
          )
        })}
      </ul>

      {transfer && (
        <div className="mt-2 flex flex-col gap-1.5 border-t border-white/10 pt-2">
          <div className="flex items-center gap-2">
            {transfer.direction === 'down' ? (
              <Download size={13} className="shrink-0 text-sky-400" />
            ) : (
              <Upload size={13} className="shrink-0 text-sky-400" />
            )}
            <span className="min-w-0 flex-1 truncate text-white/80">{transfer.name}</span>
            <button
              onClick={() => {
                if (transfer.id) void sftp.cancelTransfer(transfer.id).catch(() => {})
              }}
              title="Cancel this transfer"
              className="flex items-center justify-center rounded p-0.5 text-white/40 transition-colors duration-100 hover:bg-white/10 hover:text-white/80"
            >
              <X size={12} />
            </button>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full bg-sky-400 transition-[width] duration-150"
              style={{
                width: `${
                  transfer.total > 0
                    ? Math.min(100, (transfer.transferred / transfer.total) * 100)
                    : 100
                }%`,
              }}
            />
          </div>
          <span className="text-white/40">
            {formatBytes(transfer.transferred)}
            {transfer.total > 0 && ` of ${formatBytes(transfer.total)}`}
          </span>
        </div>
      )}

      {menu && (
        // Fixed to the pointer, like the tab strip's own menu — but rendered
        // inside the panel's subtree so the panel's own click-away rule (which
        // matches on `[data-files-panel]`) doesn't read using the menu as
        // clicking away from the panel.
        <div
          className="animate-in fade-in zoom-in-95 fixed z-50 w-40 origin-top-left rounded-md border border-white/10 bg-[#1f2028] py-1 text-xs text-white/80 shadow-xl duration-100"
          style={{ left: menu.x, top: menu.y }}
        >
          <button className={menuItem} onClick={() => open(menu.entry)}>
            {menu.entry.isDir ? <FolderOpen size={13} /> : <FileText size={13} />}
            {menu.entry.isDir ? 'Open' : 'Edit'}
          </button>
          <button
            className={menuItem}
            onClick={() => download(menu.entry)}
            // Offered-but-refused for a folder rather than hidden: the entry
            // does have a download in its future, and a menu whose items move
            // between entries is harder to learn than one where they grey out.
            disabled={menu.entry.isDir || transfer !== null}
            title={
              menu.entry.isDir
                ? 'Downloading a folder is not supported yet'
                : 'Save this file to a local path'
            }
          >
            <Download size={13} /> Download…
          </button>
          <button className={menuItem} onClick={() => copyPath(menu.entry)}>
            <ClipboardCopy size={13} /> Copy path
          </button>

          <div className="my-1 border-t border-white/10" />

          {/* The two that change the host, kept below a divider and with the
              destructive one last and coloured. Everything above is a read. */}
          <button
            className={menuItem}
            onClick={() =>
              setNaming({ kind: 'rename', original: menu.entry.name, draft: menu.entry.name })
            }
            disabled={Boolean(cwd && activeEdits[join(cwd, menu.entry.name)])}
            title={
              cwd && activeEdits[join(cwd, menu.entry.name)]
                ? 'Open for editing — stop watching it first'
                : 'Rename within this directory'
            }
          >
            <FilePen size={13} /> Rename
          </button>
          <button
            className={menuItem}
            onClick={() =>
              setNaming({
                kind: 'chmod',
                original: menu.entry.name,
                // Prefilled with what it is now, so the common edit is one
                // digit rather than four. A server that reported nothing leaves
                // an empty field rather than a guess at a default.
                draft: menu.entry.mode !== null ? formatOctal(menu.entry.mode) : '',
              })
            }
            disabled={menu.entry.mode === null}
            title={
              menu.entry.mode === null
                ? 'This host did not report permissions for it'
                : 'Change the permission bits'
            }
          >
            <KeyRound size={13} /> Permissions…
          </button>
          <button
            className={`${menuItem} text-red-300`}
            onClick={() => remove(menu.entry)}
            disabled={Boolean(cwd && activeEdits[join(cwd, menu.entry.name)])}
            title={
              cwd && activeEdits[join(cwd, menu.entry.name)]
                ? 'Open for editing — stop watching it first'
                : 'Delete on the remote host'
            }
          >
            <Trash2 size={13} /> Delete
          </button>
        </div>
      )}
    </div>
  )
}
