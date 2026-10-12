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
  FolderUp,
  KeyRound,
  RefreshCw,
  RotateCw,
  ShieldAlert,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import * as sftp from '../lib/sftp'
import type { RemoteEntry, SftpEvent } from '../lib/sftp'
import { toast } from '../lib/toast'
import { formatBytes } from '../lib/formatBytes'
import { formatMode, formatOctal, needsRootToEdit, parseOctal } from '../lib/fileMode'
import type { RemoteIdentity } from '../lib/fileMode'
import {
  describeTree,
  expandHome,
  isPermissionDenied,
  nameError,
  safeSuggestedName,
  verdictForMutation,
} from '../lib/fileActions'
import { SudoPrompt } from './SudoPrompt'
import { useDismissable } from '../hooks/useDismissable'
import { useConfirm } from './confirmContext'

/**
 * A request to show a directory, and optionally pick out one entry in it, from
 * a Ctrl+clicked path (already resolved). `nonce` makes a repeat click a new
 * request.
 */
export interface FilesReveal {
  dir: string
  select: string | null
  nonce: number
}

interface Props {
  sessionId: string
  /**
   * Where to open: the host's reported working directory, the same place a
   * dropped file would land. May be `~`-relative (it can come from a window
   * title) and is expanded on open. Null falls back to the remote home. See
   * `startDirFor`.
   */
  startDir: string | null
  /** Where a clicked path asked the panel to go, or null. Wins over `startDir`,
   *  and moves an open panel when it changes. */
  reveal: FilesReveal | null
  /** The `externalEditor` setting; empty means the OS handler. */
  editorCommand: string
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

/** The last path segment, with either separator (picked local paths may be
 *  Windows-shaped). */
function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

/** A transfer this panel started, in either direction. The row renders before
 * the backend assigns its id so it can be canceled immediately; canceling
 * before the id arrives is a no-op. */
interface Transfer {
  /**
   * The row's own identity. Separate from `id` because two rows can both be
   * waiting for an id at once.
   */
  key: string
  /** The backend's transfer id, once it has one. */
  id: string | null
  name: string
  direction: 'up' | 'down'
  transferred: number
  total: number
  /** Which file a folder transfer is on; absent for a single file. */
  file?: { name: string; index: number; count: number }
  /**
   * Runs this transfer again with resume on. Captured at start, since the
   * arguments are gone by the time it fails.
   */
  restart: () => void
  /** The error, once there is one; the row stays to offer Retry. */
  failed?: string
  /**
   * The connection dropped and the transfer is waiting to resume. Separate from
   * `failed`: nothing is needed from the user.
   */
  interrupted?: boolean
}

export function FilesPanel({ sessionId, startDir, reveal, editorCommand, onClose }: Props) {
  // Rendered only while open.
  useDismissable(true, onClose, { within: '[data-files-panel], [data-files-toggle]' })
  const confirm = useConfirm()
  // The channel's handler is built once; read `confirm` through a ref.
  const confirmRef = useRef(confirm)
  confirmRef.current = confirm
  const [cwd, setCwd] = useState<string | null>(null)
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The entry a clicked path pointed at, until the listing changes.
  const [selected, setSelected] = useState<string | null>(null)
  // The reveal already acted on, so re-renders don't yank the listing back.
  const seenReveal = useRef<number | null>(reveal?.nonce ?? null)
  const selectedRef = useRef<HTMLLIElement | null>(null)
  // remotePath -> editId. Seeded from the backend on mount, since watches
  // outlive the panel.
  const [activeEdits, setActiveEdits] = useState<Record<string, string>>({})
  // Which watched files have a root helper, by remote path.
  const [elevatedEdits, setElevatedEdits] = useState<Record<string, boolean>>({})
  // Who the host says we are, asked once per session. Null means "don't
  // guess".
  const [identity, setIdentity] = useState<RemoteIdentity | null>(null)
  const [sudoPrompt, setSudoPrompt] = useState<{
    requestId: string
    remotePath: string
    retry: boolean
  } | null>(null)
  const [menu, setMenu] = useState<{ entry: RemoteEntry; x: number; y: number } | null>(null)
  // Concurrent transfers; a folder copy can run for minutes.
  const [transfers, setTransfers] = useState<Transfer[]>([])
  // The panel's one inline text field: rename, chmod or a new directory.
  const [naming, setNaming] = useState<
    | { kind: 'rename'; original: string; draft: string }
    | { kind: 'chmod'; original: string; draft: string }
    | { kind: 'mkdir'; draft: string }
    | null
  >(null)
  // Read by `commitNaming`: the blur after a successful Enter would otherwise
  // submit again against stale state.
  const namingRef = useRef<typeof naming>(null)
  namingRef.current = naming
  const channelRef = useRef<Channel<SftpEvent> | null>(null)
  // Read inside the once-built channel callback.
  const cwdRef = useRef<string | null>(null)
  cwdRef.current = cwd
  const elevatedRef = useRef<Record<string, boolean>>({})
  elevatedRef.current = elevatedEdits
  // Row keys; a counter is unique enough and reproducible in tests.
  const nextKey = useRef(0)

  /** ` — root:root`, ` — 0:0`, or nothing. */
  function describeOwner(entry: RemoteEntry): string {
    const owner = entry.owner ?? (entry.uid !== null ? String(entry.uid) : null)
    const group = entry.group ?? (entry.gid !== null ? String(entry.gid) : null)
    if (owner === null) return ''
    return ` — ${owner}${group !== null ? `:${group}` : ''}`
  }

  function getChannel(): Channel<SftpEvent> {
    if (channelRef.current) return channelRef.current
    const channel = new Channel<SftpEvent>()
    channel.onmessage = (event) => {
      switch (event.type) {
        // Saving an edit: no progress, nothing to cancel.
        case 'uploaded':
          toast.success(`Saved ${basename(event.remotePath)}`)
          break
        case 'uploadFailed': {
          // Typical for `/etc`: readable to all, writable only by root, so the
          // save is what's refused. Offer to elevate; local edits are untouched.
          if (isPermissionDenied(event.error) && !elevatedRef.current[event.remotePath]) {
            void confirmRef
              .current({
                title: `Cannot save ${basename(event.remotePath)}`,
                body:
                  `The host refused the write: this session is connected as a user who ` +
                  `cannot modify ${event.remotePath}.

` +
                  `Saving it as root runs sudo on the host and keeps a privileged helper ` +
                  `running until you stop watching the file. You may be asked for that ` +
                  `host's sudo password — which is not the password for this SSH session.`,
                confirmLabel: 'Save as root',
              })
              .then(async (ok) => {
                if (!ok) return
                try {
                  await sftp.elevateEdit(event.editId, getChannel())
                  setElevatedEdits((prev) => ({ ...prev, [event.remotePath]: true }))
                  // Save separately so the conflict check still runs.
                  await sftp.saveEdit(event.editId, false, getChannel())
                } catch (err) {
                  toast.error(String(err))
                }
              })
            break
          }
          toast.error(`Failed to save ${event.remotePath}: ${event.error}`)
          break
        }
        case 'editorExited':
          if (event.stillWatching) {
            // The command returned too fast, handing the file off instead of
            // waiting. Point at the fix.
            toast.info(
              `${basename(event.remotePath)} is still being watched — your editor command ` +
                `returned immediately. Add its wait flag (for example "code --wait").`,
            )
            break
          }
          setActiveEdits((prev) => {
            const next = { ...prev }
            delete next[event.remotePath]
            return next
          })
          // The watch ending also ends the helper.
          setElevatedEdits((prev) => {
            const next = { ...prev }
            delete next[event.remotePath]
            return next
          })
          toast.info(`Finished editing ${basename(event.remotePath)}`)
          break
        case 'uploadConflict': {
          // Nothing was written; dismissing is the safe answer.
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
        case 'sudoPrompt':
          setSudoPrompt({
            requestId: event.requestId,
            remotePath: event.remotePath,
            retry: event.retry,
          })
          break
        // An explicit transfer. `transferStarted` carries the total and assigns
        // the row its id.
        case 'transferStarted': {
          // Claims the first row still waiting for an id; this arrives before the
          // command returns.
          let claimed = false
          setTransfers((list) =>
            list.map((t) => {
              if (t.id === event.transferId) return { ...t, total: event.total }
              if (!claimed && t.id === null) {
                claimed = true
                return { ...t, id: event.transferId, total: event.total }
              }
              return t
            }),
          )
          break
        }
        case 'transferProgress':
          setTransfers((list) =>
            list.map((t) =>
              t.id === event.transferId ? { ...t, transferred: event.transferred } : t,
            ),
          )
          break
        case 'transferFile':
          setTransfers((list) =>
            list.map((t) =>
              t.id === event.transferId
                ? { ...t, file: { name: event.name, index: event.index, count: event.count } }
                : t,
            ),
          )
          break
        case 'transferNote':
          toast.info(event.note)
          break
        case 'transferDone':
          setTransfers((list) => {
            const done = list.find((t) => t.id === event.transferId)
            toast.success(
              done?.direction === 'down'
                ? `Downloaded ${done.name}`
                : `Uploaded ${done?.name ?? basename(event.remotePath)}`,
            )
            return list.filter((t) => t.id !== event.transferId)
          })
          // Refresh the listing (also keeps sizes current after a download).
          if (cwdRef.current) void load(cwdRef.current)
          break
        case 'transferCancelled':
          setTransfers((list) => {
            const stopped = list.find((t) => t.id === event.transferId)
            toast.info(`${stopped?.direction === 'down' ? 'Download' : 'Upload'} canceled`)
            return list.filter((t) => t.id !== event.transferId)
          })
          // A canceled folder transfer leaves what it copied.
          if (cwdRef.current) void load(cwdRef.current)
          break
        case 'transferFailed':
          // Kept on screen with the error (which names the file) and Retry.
          setTransfers((list) =>
            list.map((t) =>
              t.id === event.transferId ? { ...t, failed: event.error, interrupted: false } : t,
            ),
          )
          toast.error(`Transfer failed: ${event.error}`)
          if (cwdRef.current) void load(cwdRef.current)
          break
        case 'transferInterrupted':
          setTransfers((list) =>
            list.map((t) => (t.id === event.transferId ? { ...t, interrupted: true } : t)),
          )
          // No toast: the pane already shows the dropped connection.
          break
        case 'transferResumed':
          setTransfers((list) =>
            list.map((t) =>
              t.id === event.transferId ? { ...t, interrupted: false, failed: undefined } : t,
            ),
          )
          break
      }
    }
    channelRef.current = channel
    return channel
  }

  /**
   * Lists `path` and shows it, returning whether it worked. `quiet` suppresses
   * the error banner for attempts the caller will recover from.
   */
  async function load(
    path: string,
    { quiet = false, select = null }: { quiet?: boolean; select?: string | null } = {},
  ): Promise<boolean> {
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
      setSelected(select)
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
    // `startDir` is read once, at mount; the panel doesn't follow `cd`.
    const openAt = async () => {
      let home: string | null = null
      // A clicked path is known to exist; fall through only if it vanished.
      if (reveal && (await load(reveal.dir, { quiet: true, select: reveal.select }))) return
      if (cancelled) return
      let target = startDir
      // SFTP has no tilde expansion, so resolve `~` first.
      if (target?.startsWith('~')) {
        home = await sftp.canonicalize(sessionId, '.')
        if (cancelled) return
        target = expandHome(target, home)
      }
      // The directory may be stale or not a directory; fall back to home.
      if (target && (await load(target, { quiet: true }))) return
      if (cancelled) return
      home ??= await sftp.canonicalize(sessionId, '.')
      if (cancelled) return
      load(home)
    }
    openAt().catch((err) => {
      if (!cancelled) setError(String(err))
    })
    // Adopt watches already running for this session. Best-effort.
    sftp
      .listEdits(sessionId)
      .then((edits) => {
        if (cancelled) return
        setActiveEdits(Object.fromEntries(edits.map((e) => [e.remotePath, e.editId])))
        setElevatedEdits(
          Object.fromEntries(edits.filter((e) => e.elevated).map((e) => [e.remotePath, true])),
        )
      })
      .catch(() => {})
    // Best-effort: without `id` we just don't predict.
    sftp
      .remoteIdentity(sessionId)
      .then((who) => {
        if (!cancelled) setIdentity(who)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // A path clicked while the panel is open moves it.
  useEffect(() => {
    if (!reveal || reveal.nonce === seenReveal.current) return
    seenReveal.current = reveal.nonce
    void load(reveal.dir, { select: reveal.select })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal])

  // Scroll the selected entry into view.
  useEffect(() => {
    if (selected) selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selected, entries])

  /** Transfer row helpers: add before the id exists, claim it when it arrives,
   *  drop it if the call failed. Keyed by row key. */
  function addTransfer(t: Omit<Transfer, 'key'>): string {
    const key = `t${nextKey.current++}`
    setTransfers((list) => [...list, { ...t, key }])
    return key
  }
  function claimTransfer(key: string, id: string) {
    // `transferStarted` usually sets this first.
    setTransfers((list) => list.map((t) => (t.key === key ? { ...t, id: t.id ?? id } : t)))
  }
  function dropTransfer(key: string) {
    setTransfers((list) => list.filter((t) => t.key !== key))
  }

  async function open(entry: RemoteEntry) {
    if (!cwd) return
    const path = join(cwd, entry.name)
    if (entry.isDir) {
      load(path)
      return
    }
    // When the mode bits say the edit would definitely be refused, go straight
    // to sudo (see `needsRootToEdit`). Uncertain cases try normally, and the
    // failure paths below offer root for ACLs or read-only mounts.
    if (needsRootToEdit(entry, identity)) {
      await openElevated(path)
      return
    }
    try {
      toast.info(`Opening ${entry.name}`)
      const editId = await sftp.editFile(sessionId, path, editorCommand, getChannel())
      setActiveEdits((prev) => ({ ...prev, [path]: editId }))
    } catch (err) {
      // Offer root only once the host actually refused.
      if (!isPermissionDenied(err)) {
        toast.error(String(err))
        return
      }
      const ok = await confirmRef.current({
        title: `Cannot open ${entry.name}`,
        body:
          `The host refused to read ${path}: this session is connected as a user who ` +
          `cannot see it.

` +
          `Opening it as root runs sudo on the host and keeps a privileged helper running ` +
          `until you stop watching the file. You may be asked for that host's sudo ` +
          `password — which is not the password for this SSH session.`,
        confirmLabel: 'Open as root',
      })
      if (!ok) return
      await openElevated(path)
    }
  }

  /**
   * Opens a file as root without trying the ordinary way first (the context
   * menu's "Open as root…", and predicted refusals). No confirmation: the choice
   * is already deliberate, and the sudo dialog explains itself.
   */
  async function openElevated(path: string) {
    try {
      // Distinct from "Opening x", so it's clear the elevated path was taken.
      toast.info(`Opening ${basename(path)} as root`)
      const editId = await sftp.editFile(sessionId, path, editorCommand, getChannel(), true)
      setActiveEdits((prev) => ({ ...prev, [path]: editId }))
      setElevatedEdits((prev) => ({ ...prev, [path]: true }))
    } catch (err) {
      // If elevation fails, offer the ordinary read-only-in-practice open, with
      // a confirmation since saving will be refused.
      const ok = await confirmRef.current({
        title: `Could not open ${basename(path)} as root`,
        body:
          `${String(err)}

` +
          `It can still be opened without root. You will be able to read it and edit ` +
          `your local copy, but saving it back will be refused unless the host's ` +
          `permissions change.`,
        confirmLabel: 'Open without root',
      })
      if (!ok) return
      try {
        const editId = await sftp.editFile(sessionId, path, editorCommand, getChannel())
        setActiveEdits((prev) => ({ ...prev, [path]: editId }))
      } catch (plainErr) {
        toast.error(String(plainErr))
      }
    }
  }

  /** Save a remote file to a path the user picks; the backend streams straight
   * to disk. */
  async function download(entry: RemoteEntry) {
    if (!cwd) return
    const remotePath = join(cwd, entry.name)
    let localPath: string | null
    try {
      // A folder: pick the parent, and the folder keeps its own name.
      localPath = entry.isDir
        ? await openDialog({ directory: true, title: `Copy ${entry.name} into…` }).then((dir) =>
            typeof dir === 'string' ? `${dir}/${safeSuggestedName(entry.name)}` : null,
          )
        : await save({ defaultPath: safeSuggestedName(entry.name) })
    } catch (err) {
      toast.error(`Could not open the dialog: ${String(err)}`)
      return
    }
    // Dismissed.
    if (!localPath) return

    // The backend sends the real total (a directory lists as 0).
    void startDownload(remotePath, localPath, entry.isDir ? 0 : entry.size, false)
  }

  /** Starts (or restarts) one download. `resume` is true from the Retry button,
   *  so a retry skips what already landed. */
  async function startDownload(
    remotePath: string,
    localPath: string,
    total: number,
    resume: boolean,
  ) {
    const key = addTransfer({
      id: null,
      name: basename(localPath),
      direction: 'down',
      transferred: 0,
      total,
      restart: () => void startDownload(remotePath, localPath, total, true),
    })
    try {
      const id = await sftp.downloadBegin(sessionId, remotePath, localPath, resume, getChannel())
      claimTransfer(key, id)
    } catch (err) {
      dropTransfer(key)
      toast.error(`Download failed: ${String(err)}`)
    }
  }

  /** Upload into the current directory from a picker. Picked paths never cross
   * the webview, and only this route can send a folder (a drop has no path). */
  async function uploadHere(directory: boolean) {
    if (!cwd) return
    let picked: string | string[] | null
    try {
      picked = await openDialog({ multiple: false, directory })
    } catch (err) {
      toast.error(`Could not open the picker: ${String(err)}`)
      return
    }
    if (!picked || Array.isArray(picked)) return

    const name = basename(picked)
    const remotePath = join(cwd, name)
    let overwrite = false
    try {
      if (await sftp.exists(sessionId, remotePath)) {
        const replace = await confirm({
          title: directory ? `Merge into ${name}?` : `Replace ${name}?`,
          // A folder is merged into, not replaced; say so.
          body: directory
            ? `${remotePath} already exists. Files with the same names are replaced; anything else already in it is left alone.`
            : `${remotePath} already exists. The existing file is left alone unless the whole upload succeeds.`,
          confirmLabel: directory ? 'Merge' : 'Replace',
        })
        if (!replace) return
        overwrite = true
      }
    } catch (err) {
      toast.error(`Could not check ${remotePath}: ${String(err)}`)
      return
    }

    void startUpload(cwd, picked, name, overwrite, false)
  }

  /** Starts (or restarts) one upload. See `startDownload` for `resume`. */
  async function startUpload(
    remoteDir: string,
    localPath: string,
    name: string,
    overwrite: boolean,
    resume: boolean,
  ) {
    const key = addTransfer({
      id: null,
      name,
      direction: 'up',
      transferred: 0,
      total: 0,
      restart: () => void startUpload(remoteDir, localPath, name, overwrite, true),
    })
    try {
      const id = await sftp.uploadPath(
        sessionId,
        remoteDir,
        localPath,
        overwrite,
        resume,
        getChannel(),
      )
      claimTransfer(key, id)
    } catch (err) {
      dropTransfer(key)
      toast.error(`Upload failed: ${String(err)}`)
    }
  }

  /** Rename, chmod or mkdir, whichever field is open; reloads on success. */
  async function commitNaming() {
    const current = namingRef.current
    if (!current || !cwd) return

    if (current.kind === 'chmod') {
      const mode = parseOctal(current.draft)
      if (mode === null) {
        // Left open rather than "corrected"; a wrong mode is dangerous.
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
    // Cleared before the await, so the trailing blur (or a slow server) can't
    // submit twice.
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
      // Left open (usually the name is taken); restore the ref so the field can
      // submit again.
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
    // Count first so the confirmation is specific.
    let count: sftp.TreeCount | null = null
    if (entry.isDir) {
      try {
        count = await sftp.countTree(sessionId, path)
      } catch (err) {
        toast.error(`Could not read ${path}: ${String(err)}`)
        return
      }
    }

    const ok = await confirm({
      title: `Delete ${entry.name}?`,
      // Plain wording: no undo, no recycle bin.
      body: count
        ? count.files + count.dirs + count.links === 0
          ? `${path} is empty and will be deleted. This cannot be undone.`
          : `${path} and everything in it will be deleted — ${describeTree(count)}. ` +
            `This cannot be undone.` +
            (count.links
              ? `\n\nSymbolic links are removed as links; whatever they point at is left alone.`
              : '')
        : `${path} will be deleted on the remote host. This cannot be undone.`,
      confirmLabel: 'Delete',
    })
    if (!ok) return
    try {
      await sftp.remove(sessionId, path, entry.isDir)
      toast.success(`Deleted ${entry.name}`)
      load(cwd)
    } catch (err) {
      toast.error(String(err))
      // A partial delete is possible; reload.
      load(cwd)
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
    const wasElevated = elevatedEdits[path]
    await sftp.stopWatching(editId).catch(() => {})
    setActiveEdits((prev) => {
      const next = { ...prev }
      delete next[path]
      return next
    })
    setElevatedEdits((prev) => {
      const next = { ...prev }
      delete next[path]
      return next
    })
    // Confirm that the root helper ended.
    toast.info(
      wasElevated
        ? `Stopped watching ${basename(path)} — the root helper on the host has ended`
        : `Stopped watching ${basename(path)}`,
    )
  }

  const menuItem =
    'flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors duration-100 hover:bg-chrome/10 disabled:opacity-30 disabled:hover:bg-transparent'

  /** The inline name field for rename and mkdir. Auto-focused; blur commits
   * rather than cancels. */
  const nameField = (value: string, onChange: (v: string) => void) => (
    <input
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => void commitNaming()}
      onKeyDown={(e) => {
        // Keep Escape from reaching the panel's dismiss handler.
        e.stopPropagation()
        if (e.key === 'Enter') void commitNaming()
        if (e.key === 'Escape') setNaming(null)
      }}
      className="min-w-0 flex-1 rounded border border-sky-400/40 bg-black/30 px-1 py-0.5 text-chrome/90 outline-none"
    />
  )

  return (
    <div
      data-files-panel
      className="animate-in fade-in slide-in-from-top-1 absolute right-2 top-10 z-40 flex w-96 flex-col rounded-lg border border-chrome/10 bg-surface p-3 text-xs shadow-xl duration-100"
      onClick={(e) => {
        e.stopPropagation()
        // The panel stops clicks reaching window, so close the menu explicitly.
        // Menu items run first.
        setMenu(null)
      }}
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 font-medium text-chrome/90">
          <Folder size={13} /> Remote files
        </h2>
        <button
          onClick={onClose}
          className="flex items-center justify-center rounded p-1 text-chrome/40 transition-colors duration-100 hover:bg-chrome/10 hover:text-chrome/80"
        >
          <X size={13} />
        </button>
      </div>

      <div className="mb-2 flex items-center gap-1">
        <button
          onClick={() => cwd && load(parentOf(cwd))}
          disabled={!cwd || cwd === '/'}
          title="Up one directory"
          className="flex items-center justify-center rounded p-1 text-chrome/40 transition-colors duration-100 hover:bg-chrome/10 hover:text-chrome/80 disabled:opacity-30"
        >
          <ArrowUp size={13} />
        </button>
        <span className="min-w-0 flex-1 truncate text-chrome/60">{cwd ?? '…'}</span>
        <button
          onClick={() => setNaming({ kind: 'mkdir', draft: '' })}
          disabled={!cwd}
          title="New folder"
          className="flex items-center justify-center rounded p-1 text-chrome/40 transition-colors duration-100 hover:bg-chrome/10 hover:text-chrome/80 disabled:opacity-30"
        >
          <FolderPlus size={12} />
        </button>
        <button
          onClick={() => uploadHere(false)}
          disabled={!cwd}
          title="Upload a file into this directory"
          className="flex items-center justify-center rounded p-1 text-chrome/40 transition-colors duration-100 hover:bg-chrome/10 hover:text-chrome/80 disabled:opacity-30"
        >
          <Upload size={12} />
        </button>
        <button
          onClick={() => uploadHere(true)}
          disabled={!cwd}
          title="Upload a folder into this directory"
          className="flex items-center justify-center rounded p-1 text-chrome/40 transition-colors duration-100 hover:bg-chrome/10 hover:text-chrome/80 disabled:opacity-30"
        >
          <FolderUp size={12} />
        </button>
        <button
          onClick={() => cwd && load(cwd)}
          title="Refresh"
          className="flex items-center justify-center rounded p-1 text-chrome/40 transition-colors duration-100 hover:bg-chrome/10 hover:text-chrome/80"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {error && <p className="mb-2 text-red-400">{error}</p>}

      <ul className="max-h-96 space-y-0.5 overflow-y-auto">
        {loading && <li className="px-2 py-1.5 text-chrome/40">Loading…</li>}
        {!loading && entries.length === 0 && !error && !naming && (
          <li className="px-2 py-1.5 text-chrome/40">Empty directory</li>
        )}
        {naming?.kind === 'mkdir' && (
          // At the top, where directories sort anyway.
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
              ref={entry.name === selected ? selectedRef : undefined}
              aria-selected={entry.name === selected || undefined}
              onDoubleClick={() => open(entry)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ entry, x: e.clientX, y: e.clientY })
              }}
              className={`flex cursor-default items-center justify-between gap-2 rounded px-2 py-1.5 ${
                entry.name === selected ? 'bg-sky-400/15' : 'hover:bg-chrome/5'
              }`}
            >
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-chrome/80">
                {entry.isDir ? (
                  <Folder size={12} className="shrink-0 text-sky-400/80" />
                ) : (
                  <FileText size={12} className="shrink-0 text-chrome/40" />
                )}
                {naming?.kind === 'rename' && naming.original === entry.name ? (
                  nameField(naming.draft, (draft) =>
                    setNaming({ kind: 'rename', original: entry.name, draft }),
                  )
                ) : (
                  <span className="truncate">{entry.name}</span>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-2 text-chrome/30">
                {editId && (
                  // "watching", dismissable by hand: with the OS opener nothing can tell
                  // when the editor closes. With `externalEditor` set it clears itself on
                  // `editorExited`.
                  <button
                    onClick={() => stopEditing(path)}
                    title={
                      elevatedEdits[path]
                        ? 'Watching for saves and writing each one as root. A privileged helper is running on the host until you click to stop — which also deletes the local temp copy, so save in your editor first.'
                        : 'Watching for saves and uploading each one. Click to stop — this also deletes the local temp copy, so save in your editor first.'
                    }
                    // Amber with a shield when elevated: the only visible sign (and the
                    // off switch) of a standing root helper.
                    className={`flex items-center gap-1 rounded px-1 py-0.5 transition-colors duration-fast ease-swift hover:bg-chrome/10 ${
                      elevatedEdits[path]
                        ? 'text-amber-400/90 hover:text-amber-300'
                        : 'text-sky-400/80 hover:text-sky-300'
                    }`}
                  >
                    {elevatedEdits[path] ? (
                      <>
                        <ShieldAlert size={10} /> root
                      </>
                    ) : (
                      <>
                        <File size={10} /> watching
                      </>
                    )}{' '}
                    <X size={9} />
                  </button>
                )}
                {naming?.kind === 'chmod' && naming.original === entry.name ? (
                  // Edited in place of the column it changes.
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
                    className="w-12 rounded border border-sky-400/40 bg-black/30 px-1 py-0.5 text-right font-mono text-chrome/90 outline-none"
                  />
                ) : (
                  entry.mode !== null && (
                    <span
                      className="font-mono text-chrome/25"
                      // Octal in the tooltip (what you type), letters in the column (what
                      // you scan). Owner falls back to numeric ids, since SFTP v3 carries no
                      // names.
                      title={`${formatOctal(entry.mode)}${describeOwner(entry)}`}
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

      {transfers.length > 0 && (
        <div className="mt-2 flex max-h-32 flex-col gap-2 overflow-y-auto border-t border-chrome/10 pt-2">
          {transfers.map((t) => (
            <div key={t.key} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                {t.direction === 'down' ? (
                  <Download size={13} className="shrink-0 text-sky-400" />
                ) : (
                  <Upload size={13} className="shrink-0 text-sky-400" />
                )}
                <span className="min-w-0 flex-1 truncate text-chrome/80">{t.name}</span>
                {t.failed && (
                  <button
                    onClick={() => {
                      // Replaced by the retry's own row.
                      dropTransfer(t.key)
                      t.restart()
                    }}
                    title="Try again, skipping whatever already arrived"
                    className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-sky-400/80 transition-colors duration-100 hover:bg-chrome/10 hover:text-sky-300"
                  >
                    <RotateCw size={11} /> Retry
                  </button>
                )}
                <button
                  onClick={() => {
                    // Cancel a running transfer, or dismiss a stopped one.
                    if (t.failed) dropTransfer(t.key)
                    // An interrupted transfer is waiting in the backend; canceling drops
                    // it from the resume queue.
                    else if (t.interrupted && t.id) {
                      void sftp.cancelTransfer(t.id).catch(() => {})
                      dropTransfer(t.key)
                    } else if (t.id) void sftp.cancelTransfer(t.id).catch(() => {})
                  }}
                  title={t.failed ? 'Dismiss' : 'Cancel this transfer'}
                  className="flex items-center justify-center rounded p-0.5 text-chrome/40 transition-colors duration-100 hover:bg-chrome/10 hover:text-chrome/80"
                >
                  <X size={12} />
                </button>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-chrome/10">
                <div
                  className={`h-full transition-[width] duration-150 ${
                    t.failed ? 'bg-red-400/70' : t.interrupted ? 'bg-amber-400/70' : 'bg-sky-400'
                  }`}
                  style={{
                    width: `${
                      t.total > 0 ? Math.min(100, (t.transferred / t.total) * 100) : 100
                    }%`,
                  }}
                />
              </div>
              {t.failed ? (
                <span className="text-red-300/90">{t.failed}</span>
              ) : t.interrupted ? (
                // Explains why the progress bar isn't moving.
                <span className="text-amber-300/80">
                  connection lost — resuming when it comes back (
                  {formatBytes(t.transferred)} so far)
                </span>
              ) : (
                <span className="flex items-baseline gap-2 text-chrome/40">
                  <span className="shrink-0">
                    {formatBytes(t.transferred)}
                    {t.total > 0 && ` of ${formatBytes(t.total)}`}
                  </span>
                  {t.file && (
                    // Both the count and the name.
                    <span className="min-w-0 truncate text-chrome/25">
                      {t.file.index} of {t.file.count} — {t.file.name}
                    </span>
                  )}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {menu && (
        // Fixed to the pointer, but inside the panel's subtree so its
        // click-away rule doesn't treat the menu as outside.
        <div
          className="animate-in fade-in zoom-in-95 fixed z-50 w-40 origin-top-left rounded-md border border-chrome/10 bg-surface py-1 text-xs text-chrome/80 shadow-xl duration-100"
          style={{ left: menu.x, top: menu.y }}
        >
          <button className={menuItem} onClick={() => open(menu.entry)}>
            {menu.entry.isDir ? <FolderOpen size={13} /> : <FileText size={13} />}
            {menu.entry.isDir ? 'Open' : 'Edit'}
          </button>
          {!menu.entry.isDir && needsRootToEdit(menu.entry, identity) && (
            // Only when the mode bits and `id` agree the edit would be refused.
            // Double-click already routes there; this names it up front.
            <button
              className={menuItem}
              onClick={() => cwd && void openElevated(join(cwd, menu.entry.name))}
              disabled={Boolean(cwd && activeEdits[join(cwd, menu.entry.name)])}
              title={
                cwd && activeEdits[join(cwd, menu.entry.name)]
                  ? 'Already open for editing — stop watching it first'
                  : 'This session cannot write it. Edit as root runs sudo on the host, and asks for the sudo password there.'
              }
            >
              <ShieldAlert size={13} /> Edit as root…
            </button>
          )}
          <button
            className={menuItem}
            onClick={() => download(menu.entry)}
            title={
              menu.entry.isDir
                ? 'Copy this folder and everything in it to a local directory'
                : 'Save this file to a local path'
            }
          >
            <Download size={13} /> Download…
          </button>
          <button className={menuItem} onClick={() => copyPath(menu.entry)}>
            <ClipboardCopy size={13} /> Copy path
          </button>

          <div className="my-1 border-t border-chrome/10" />

          {/* The host-changing actions below a divider, the destructive one last. */}
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
                // Prefilled with the current mode; empty if the server reported none.
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
      {sudoPrompt && (
        // Keyed per request so a retry starts with an empty field.
        <SudoPrompt
          key={sudoPrompt.requestId}
          remotePath={sudoPrompt.remotePath}
          retry={sudoPrompt.retry}
          onAnswer={(password) => {
            void sftp.respondSudoPrompt(sudoPrompt.requestId, password).catch(() => {})
            setSudoPrompt(null)
          }}
        />
      )}
    </div>
  )
}
