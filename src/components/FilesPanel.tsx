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
  /** The `externalEditor` setting, passed through to every edit this panel
   *  opens. Empty means the OS handler, which cannot report a close. */
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
  /**
   * This row's own identity, assigned when it is created.
   *
   * Separate from `id` because a row exists before the backend has given it
   * one, and "the pending row" stops being a unique description the moment two
   * transfers are started in quick succession — both would answer to it, and a
   * single `transferStarted` would stamp its id onto both.
   */
  key: string
  /** The backend's transfer id, once it has one. */
  id: string | null
  name: string
  direction: 'up' | 'down'
  transferred: number
  total: number
  /** Which file a folder transfer is on. Absent for a single file, which is
   *  already named by the row itself. */
  file?: { name: string; index: number; count: number }
  /**
   * Runs this same transfer again with resume on.
   *
   * Held from the moment the transfer starts, because by the time it fails the
   * arguments that built it are long out of scope. A failed transfer used to
   * vanish into a toast, which for a folder meant the only offer after dying on
   * file 400 of 500 was to set the whole thing up again from the context menu.
   */
  restart: () => void
  /** The error, once there is one. The row stays on screen holding it. */
  failed?: string
  /**
   * The connection went away and this transfer is waiting for it.
   *
   * Deliberately separate from `failed`, because the two ask the user for
   * opposite things. A failure wants them to do something — free some disk,
   * fix a permission, press Retry. This wants them to do nothing at all: the
   * reconnect is already running and the transfer picks up on its own. Showing
   * it as failed would send someone to fix what is about to fix itself, and a
   * Retry pressed during the outage only fails again.
   */
  interrupted?: boolean
}

// A row is created with `id: null` and gets its real one a round trip later.
// The cancel button has to exist inside that gap — otherwise the first thing a
// user does with a transfer started by mistake is discover they cannot stop it
// yet — so the row renders throughout, and cancelling before the id lands is a
// no-op rather than an error.

export function FilesPanel({ sessionId, startDir, editorCommand, onClose }: Props) {
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
  // Which of those edits has a root helper running behind it, by remote path.
  // Separate from `activeEdits` rather than folded into it so every existing
  // read of "is this watched" keeps working unchanged — elevation is an extra
  // fact about a watch, not a different kind of one.
  const [elevatedEdits, setElevatedEdits] = useState<Record<string, boolean>>({})
  // Who the host says we are, asked once per session. Null until it answers,
  // and null forever on a host that will not — which the prediction reads as
  // "do not guess" rather than as "denied".
  const [identity, setIdentity] = useState<RemoteIdentity | null>(null)
  const [sudoPrompt, setSudoPrompt] = useState<{
    requestId: string
    remotePath: string
    retry: boolean
  } | null>(null)
  const [menu, setMenu] = useState<{ entry: RemoteEntry; x: number; y: number } | null>(null)
  // A list, not one: the backend always allowed concurrent transfers — the map
  // was there from the start — and only this row's singularity stopped the panel
  // offering them. A folder copy can run for minutes, and refusing to let
  // anything else happen meanwhile was the wrong trade.
  const [transfers, setTransfers] = useState<Transfer[]>([])
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
  // Same reason as `cwdRef`: the channel callback is built once and would
  // otherwise ask the first render whether a file is elevated — and answer
  // "no" forever, offering to elevate a file that already is.
  const elevatedRef = useRef<Record<string, boolean>>({})
  elevatedRef.current = elevatedEdits
  // Row identities. A counter rather than a random id: it only has to be
  // unique within this panel's lifetime, and a counter is reproducible in a
  // test where a random one is not.
  const nextKey = useRef(0)

  /** ` — root:root`, ` — 0:0`, or nothing at all. */
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
        // An edit being saved: no progress, nothing to cancel.
        case 'uploaded':
          toast.success(`Saved ${basename(event.remotePath)}`)
          break
        case 'uploadFailed': {
          // The ordinary shape of this problem, and the reason the offer lives
          // here rather than only on open: a file under `/etc` is usually
          // readable by anyone and writable only by root, so opening it worked
          // and it is the save — minutes and several edits later — that is
          // refused. Nothing local has been touched, so accepting costs the
          // user nothing they have typed.
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
                  // A separate call on purpose: the save that follows runs the
                  // same conflict check as any other, so elevating cannot
                  // become a way past a warning that someone else changed the
                  // file underneath this edit.
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
            // The command returned before the user could plausibly have
            // finished, which means it handed the file off rather than waiting.
            // Said plainly and with the fix in it, because the symptom
            // otherwise is "the chip never goes away" and nothing points at the
            // setting.
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
          // The watch ending is the helper ending: the backend drops the edit,
          // which closes the channel it was running on. Clearing the marker
          // here keeps the panel from claiming a privilege that is already
          // gone.
          setElevatedEdits((prev) => {
            const next = { ...prev }
            delete next[event.remotePath]
            return next
          })
          toast.info(`Finished editing ${basename(event.remotePath)}`)
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
        case 'sudoPrompt':
          setSudoPrompt({
            requestId: event.requestId,
            remotePath: event.remotePath,
            retry: event.retry,
          })
          break
        // An explicit transfer. Only the backend knows the total for these — a
        // download's from `stat` or the tree walk, an upload's from the file
        // or tree itself — and `transferStarted` is also where a row stops
        // being `PENDING` and takes its real id.
        case 'transferStarted': {
          // Claims the *first* row still waiting for an id, in start order. The
          // command sends this before it returns, so the row it belongs to
          // normally has no id yet and cannot be found by one.
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
          // An upload changed the directory being shown; a download didn't, but
          // reloading costs one listing and keeps the size column honest if the
          // file was being written while it was read.
          if (cwdRef.current) void load(cwdRef.current)
          break
        case 'transferCancelled':
          setTransfers((list) => {
            const stopped = list.find((t) => t.id === event.transferId)
            toast.info(`${stopped?.direction === 'down' ? 'Download' : 'Upload'} cancelled`)
            return list.filter((t) => t.id !== event.transferId)
          })
          // A cancelled folder transfer leaves what it already copied, so the
          // listing is stale in exactly the case the user most wants to check.
          if (cwdRef.current) void load(cwdRef.current)
          break
        case 'transferFailed':
          // Kept on screen rather than removed. The error names the file it got
          // to, which for a folder is the whole difference between "it failed"
          // and "it failed on this one" — and the row is where Retry lives.
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
          // No toast. The pane behind this is already saying the connection
          // dropped and counting down to the next attempt; a second notice
          // about the same event, for something that needs nothing from the
          // user, is noise on top of the news they already have.
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
        setElevatedEdits(
          Object.fromEntries(edits.filter((e) => e.elevated).map((e) => [e.remotePath, true])),
        )
      })
      .catch(() => {})
    // Best-effort, like the watch adoption above: a host that will not run
    // `id` costs the prediction, not the panel.
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

  /** Starting a transfer takes three steps, and every caller does all three:
   *  show the row before the id exists, give it the id when it arrives, and take
   *  it away again if the call never got that far. Keyed by the row's own key,
   *  so two transfers started together cannot be confused for each other. */
  function addTransfer(t: Omit<Transfer, 'key'>): string {
    const key = `t${nextKey.current++}`
    setTransfers((list) => [...list, { ...t, key }])
    return key
  }
  function claimTransfer(key: string, id: string) {
    // `transferStarted` usually wins the race and has already set this; the
    // guard is for a transfer that fails before ever sending one.
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
    // Asked before the attempt, not after it. When the host has already told us
    // who we are and the mode says this edit would be refused, making the user
    // watch it fail first teaches nobody anything — the sudo dialog is what
    // they need, and it should come up on the click.
    //
    // Only ever a *definite* refusal routes this way; see `needsRootToEdit`.
    // Everything uncertain still tries the ordinary way, and the offers on the
    // failure paths below are what catch an ACL or a read-only mount that the
    // mode bits could not have predicted.
    if (needsRootToEdit(entry, identity)) {
      await openElevated(path)
      return
    }
    try {
      toast.info(`Opening ${entry.name}`)
      const editId = await sftp.editFile(sessionId, path, editorCommand, getChannel())
      setActiveEdits((prev) => ({ ...prev, [path]: editId }))
    } catch (err) {
      // Asked only once the host has actually refused, never predicted from the
      // mode bits. The panel knows the connected user's name but not their
      // groups, so a prediction is wrong often enough to be noise — and an
      // offer of root that turns out to have been unnecessary is worse than
      // noise.
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
   * Opens a file as root without trying the ordinary way first.
   *
   * The context menu's route, and the answer to "why did it make me fail
   * before it would offer": when the user has *said* they want root, the
   * refused attempt teaches nobody anything and the sudo dialog should come up
   * on the click. The failure paths still offer it too, because most people
   * find out a file needs root by being told so.
   *
   * No confirmation in front of it. Choosing "Open as root…" from a menu is
   * already the deliberate act a confirmation exists to obtain, and the sudo
   * dialog itself says what is about to happen before any password is typed.
   */
  async function openElevated(path: string) {
    try {
      // Said before anything blocks, and deliberately distinct from the
      // ordinary "Opening x" — this is the one line that tells the user the
      // elevated path was taken at all, before sudo is asked anything and
      // before any dialog can appear.
      toast.info(`Opening ${basename(path)} as root`)
      const editId = await sftp.editFile(sessionId, path, editorCommand, getChannel(), true)
      setActiveEdits((prev) => ({ ...prev, [path]: editId }))
      setElevatedEdits((prev) => ({ ...prev, [path]: true }))
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
    const remotePath = join(cwd, entry.name)
    let localPath: string | null
    try {
      // A folder needs somewhere to go, not a name to be saved as — so the
      // dialog asks for the *parent* and the folder keeps its own name inside
      // it, which is what every other copy of a directory does.
      localPath = entry.isDir
        ? await openDialog({ directory: true, title: `Copy ${entry.name} into…` }).then((dir) =>
            typeof dir === 'string' ? `${dir}/${safeSuggestedName(entry.name)}` : null,
          )
        : await save({ defaultPath: safeSuggestedName(entry.name) })
    } catch (err) {
      toast.error(`Could not open the dialog: ${String(err)}`)
      return
    }
    // Dismissed. Not an error and not worth a toast — the user changed their
    // mind, and they know it.
    if (!localPath) return

    // `entry.size` is the listing's and is 0 for a directory; the backend stats
    // or walks and sends the real total as `transferStarted`.
    void startDownload(remotePath, localPath, entry.isDir ? 0 : entry.size, false)
  }

  /** Starts (or restarts) one download. `resume` is false the first time and
   *  true from the Retry button — a fresh copy should copy everything, a retry
   *  should not redo what already landed. */
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

  /** Upload into the directory being shown, from a picker.
   *
   * The route for anyone who would rather not drag — and the cheaper one, since
   * a picked path never puts its bytes through the webview. It is also the only
   * route that can send a *folder*: a drop hands over a `File` with no path, so
   * there is nothing to walk. */
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
          // A folder is not replaced, it is merged into — files with the same
          // name are overwritten and everything else is left where it is. That
          // is a materially different promise from the single-file one, and the
          // dialog has to make it rather than imply the other.
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
    // Counted before asking, so the question is specific. "Are you sure" is
    // worth almost nothing; "this removes 341 files in 27 directories" is worth
    // a great deal — and only if it is said *before* the answer.
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
      // Named plainly rather than softened. This is a remote host the user may
      // not easily get back to, there is no undo, and there is no recycle bin
      // on the far side.
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
      // Partial deletes are possible — the walk removes files before
      // directories — so what is on screen may no longer be what is there.
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
    // Said out loud when there was one, because ending the privilege is the
    // part worth confirming: the root helper on the host is gone, and the
    // sentence is the user's evidence of it.
    toast.info(
      wasElevated
        ? `Stopped watching ${basename(path)} — the root helper on the host has ended`
        : `Stopped watching ${basename(path)}`,
    )
  }

  const menuItem =
    'flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors duration-100 hover:bg-chrome/10 disabled:opacity-30 disabled:hover:bg-transparent'

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
      className="min-w-0 flex-1 rounded border border-sky-400/40 bg-black/30 px-1 py-0.5 text-chrome/90 outline-none"
    />
  )

  return (
    <div
      data-files-panel
      className="animate-in fade-in slide-in-from-top-1 absolute right-2 top-10 z-40 flex w-96 flex-col rounded-lg border border-chrome/10 bg-surface p-3 text-xs shadow-xl duration-100"
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
              className="flex cursor-default items-center justify-between gap-2 rounded px-2 py-1.5 hover:bg-chrome/5"
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
                  // "watching", not "editing", and dismissable by hand —
                  // because on the default route nothing can tell when the
                  // editor is closed. The OS hands the file off and returns at
                  // once, usually to an instance already running, so ending the
                  // watch on that would mean the second save of a session
                  // silently not uploading. Shaped as a subscription so it
                  // reads as "still live, click to end" rather than a status
                  // stuck on.
                  //
                  // With `externalEditor` set the chip clears itself on
                  // `editorExited`, and this is then a manual override rather
                  // than the only way out.
                  <button
                    onClick={() => stopEditing(path)}
                    title={
                      elevatedEdits[path]
                        ? 'Watching for saves and writing each one as root. A privileged helper is running on the host until you click to stop — which also deletes the local temp copy, so save in your editor first.'
                        : 'Watching for saves and uploading each one. Click to stop — this also deletes the local temp copy, so save in your editor first.'
                    }
                    // Amber and a shield when the watch is elevated, because
                    // this chip is the only place a standing privilege on the
                    // host is visible — and it is also the control that ends
                    // it. A root watch that looked like every other watch would
                    // be one nobody thinks to close.
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
                    className="w-12 rounded border border-sky-400/40 bg-black/30 px-1 py-0.5 text-right font-mono text-chrome/90 outline-none"
                  />
                ) : (
                  entry.mode !== null && (
                    <span
                      className="font-mono text-chrome/25"
                      // The octal is what you type into the field and what
                      // every chmod example is written in; the letters are what
                      // you can scan a column of. Both, rather than a choice.
                      // Owner falls back to the numeric id, because the name
                      // is never there: SFTP v3 carries no owner names, so this
                      // half of the tooltip has always been blank. `0:0` says
                      // considerably more than nothing when the question is
                      // why a file needs root.
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
                      // The failed row goes as the retry's own row arrives, so
                      // one transfer is never on screen twice.
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
                    // Two jobs, one button, and which one it is depends on
                    // whether the transfer is still running: cancel it, or
                    // dismiss the record of one that already stopped.
                    if (t.failed) dropTransfer(t.key)
                    // An interrupted transfer has no live task to cancel — it
                    // is waiting in the backend — so giving up on it is
                    // dismissing the row, which also drops it from the queue
                    // the reconnect would otherwise resume.
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
                // Says the byte count is standing still on purpose. Without
                // this the row is a stalled progress bar, which is the one
                // thing a progress bar must never be without explanation.
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
                    // The file *and* the count. Either alone leaves a question:
                    // the name without "3 of 57" gives no sense of how far along
                    // it is, and the count without the name gives no sense of
                    // whether it is stuck.
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
        // Fixed to the pointer, like the tab strip's own menu — but rendered
        // inside the panel's subtree so the panel's own click-away rule (which
        // matches on `[data-files-panel]`) doesn't read using the menu as
        // clicking away from the panel.
        <div
          className="animate-in fade-in zoom-in-95 fixed z-50 w-40 origin-top-left rounded-md border border-chrome/10 bg-surface py-1 text-xs text-chrome/80 shadow-xl duration-100"
          style={{ left: menu.x, top: menu.y }}
        >
          <button className={menuItem} onClick={() => open(menu.entry)}>
            {menu.entry.isDir ? <FolderOpen size={13} /> : <FileText size={13} />}
            {menu.entry.isDir ? 'Open' : 'Edit'}
          </button>
          {!menu.entry.isDir && needsRootToEdit(menu.entry, identity) && (
            // Shown only when the mode bits and the host's own answer to `id`
            // agree that this edit would be refused. On a file the user can
            // write it would be an offer of privilege they do not need, which
            // is how an offer of privilege stops being read at all.
            //
            // Double-clicking such a file already routes here on its own, so
            // this is mostly a signpost — it names what is about to happen
            // before anything happens.
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
      {sudoPrompt && (
        // Keyed by request, so a rejected password gets a fresh, empty dialog
        // rather than the previous attempt still sitting in the field.
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
