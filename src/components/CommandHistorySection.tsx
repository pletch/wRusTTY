import { useEffect, useState } from 'react'
import { RefreshCw, Server, Trash2, Undo2 } from 'lucide-react'
import {
  allowCommandHistory,
  describeHistoryHost,
  forgetCommandHistory,
  forgetImportedHistory,
  listCommandHistory,
  type HistoryEntry,
  type HostHistory,
} from '../lib/commandHistory'
import { listSessions, type SessionProfile } from '../lib/profiles'
import { toast } from '../lib/toast'
import { useConfirm } from './confirmContext'

/**
 * What autocomplete has remembered, per host, and how to delete it.
 *
 * Not an optional nicety. If the app is going to keep a record of command
 * lines typed on other people's servers, the person it belongs to gets to read
 * that record and remove from it — which is why this ships in the same phase
 * as the store itself rather than after the feature that makes it useful.
 *
 * Deliberately shows the commands themselves rather than a count. A count is
 * unauditable: the whole question someone opens this to answer is "what did it
 * actually keep", and "1,284 commands" does not answer it.
 */

/** Rendered per host before the rest are summarised. A busy host reaches the
 * store's 5,000-entry cap, and a list that long is neither readable nor
 * cheap to lay out — the ones worth checking are the ones ranked highest,
 * which is the order the backend already returns them in. */
const SHOWN_PER_HOST = 50

function relativeDay(ms: number, now: number): string {
  const days = Math.floor((now - ms) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.round(days / 30)}mo ago`
  return `${Math.round(days / 365)}y ago`
}

export function CommandHistorySection() {
  const confirm = useConfirm()
  const [hosts, setHosts] = useState<HostHistory[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Saved sessions by id, so a `profile://` key can be shown by name. */
  const [profiles, setProfiles] = useState<ReadonlyMap<string, SessionProfile>>(new Map())
  // Sampled once per load rather than per row: a few hundred rows all asking
  // the clock for the same answer is wasted work, and a list whose relative
  // dates disagree by a tick reads as a bug.
  const [now, setNow] = useState(() => Date.now())

  async function load() {
    try {
      // Names are a nicety: if the session list will not load, the history
      // still should, headed by its keys.
      const [listed, sessions] = await Promise.all([
        listCommandHistory(),
        listSessions().catch(() => [] as SessionProfile[]),
      ])
      setHosts(listed)
      setProfiles(new Map(sessions.map((p) => [p.id, p])))
      setNow(Date.now())
      setError(null)
    } catch (err) {
      setError(String(err))
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function forgetOne(host: string, entry: HistoryEntry) {
    try {
      await forgetCommandHistory({ host, command: entry.command })
      await load()
    } catch (err) {
      toast.error(String(err))
    }
  }

  async function allow(host: string, command: string) {
    try {
      await allowCommandHistory(host, command)
      await load()
    } catch (err) {
      toast.error(String(err))
    }
  }

  async function forgetHost(host: HostHistory) {
    const blocks = host.blocked.length
    const ok = await confirm({
      title: `Forget every command remembered for ${describeHistoryHost(host.host, profiles).title}?`,
      body:
        `All ${host.entries.length} stored command${host.entries.length === 1 ? '' : 's'} for ` +
        `this host are deleted from this machine` +
        (blocks > 0
          ? `, and its never-suggest list of ${blocks} is cleared — those can be suggested again. `
          : '. ') +
        `Nothing is sent anywhere and the host's own shell history is untouched — this only ` +
        `removes what wRusTTY kept.`,
      confirmLabel: 'Forget host',
    })
    if (!ok) return
    try {
      await forgetCommandHistory({ host: host.host })
      await load()
    } catch (err) {
      toast.error(String(err))
    }
  }

  /** The other half of the harvest's separate consent: what an import brought
   * in can be taken back out again, without touching anything the user
   * actually ran in front of us. */
  async function forgetImported() {
    const imported =
      hosts?.reduce((sum, h) => sum + h.entries.filter((e) => e.source === 'harvest').length, 0) ?? 0
    const ok = await confirm({
      title: 'Forget everything imported from remote hosts?',
      body:
        `The ${imported} command${imported === 1 ? '' : 's'} that came from hosts' own shell ` +
        `history files are deleted. Commands you have actually run while connected are kept, ` +
        `including any that were imported first and then run — those stopped being imports the ` +
        `moment you used them.`,
      confirmLabel: 'Forget imports',
    })
    if (!ok) return
    try {
      await forgetImportedHistory()
      await load()
    } catch (err) {
      toast.error(String(err))
    }
  }

  async function forgetEverything() {
    const total = hosts?.reduce((sum, h) => sum + h.entries.length, 0) ?? 0
    const ok = await confirm({
      title: 'Forget every remembered command?',
      body:
        `All ${total} stored command${total === 1 ? '' : 's'}, across every host, are deleted ` +
        `from this machine, along with every never-suggest list. Autocomplete starts again ` +
        `from nothing. No remote host is contacted and no shell history on any server is ` +
        `changed.`,
      confirmLabel: 'Forget everything',
    })
    if (!ok) return
    try {
      await forgetCommandHistory()
      await load()
    } catch (err) {
      toast.error(String(err))
    }
  }

  return (
    <div className="space-y-3 px-2 py-1.5">
      <div className="flex items-start justify-between gap-3">
        <p className="leading-relaxed text-chrome/50">
          What has been remembered, newest and most-used first. Kept on this machine
          only — never synced, never sent anywhere, and not part of a backup bundle.
          Lines that looked like they carried a password or a token were never stored
          in the first place. Forgetting a command — here, or with Shift+Delete on a
          suggestion — also stops it coming back, until you allow it again.
        </p>
        <button
          type="button"
          onClick={() => void load()}
          title="Reload"
          className="mt-0.5 flex shrink-0 items-center justify-center rounded p-1 text-chrome/40 transition-colors duration-100 hover:bg-chrome/10 hover:text-chrome/80"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {error && <p className="text-red-400">{error}</p>}
      {hosts === null && !error && <p className="text-chrome/40">Loading…</p>}
      {hosts?.length === 0 && (
        <p className="text-chrome/40">
          Nothing remembered yet. Commands are recorded as you run them, once
          autocomplete is turned on above.
        </p>
      )}

      {hosts !== null && hosts.length > 0 && (
        <div className="flex gap-1.5">
          {/* Only offered when there is something imported to forget — the
              button is meaningless otherwise, and an always-present one
              implies the app has been importing when it may never have. */}
          {hosts.some((h) => h.entries.some((e) => e.source === 'harvest')) && (
            <button
              type="button"
              onClick={() => void forgetImported()}
              className="flex-1 rounded bg-chrome/[0.06] py-1.5 text-chrome/70 transition-colors duration-fast ease-swift hover:bg-red-500/20 hover:text-red-200"
            >
              Forget imported history
            </button>
          )}
          <button
            type="button"
            onClick={() => void forgetEverything()}
            className="flex-1 rounded bg-chrome/[0.06] py-1.5 text-chrome/70 transition-colors duration-fast ease-swift hover:bg-red-500/20 hover:text-red-200"
          >
            Forget everything
          </button>
        </div>
      )}

      <div className="space-y-2">
        {hosts?.map((host) => (
          <div key={host.host} className="rounded-md border border-chrome/10 bg-black/15 p-2">
            <div className="mb-1.5 flex items-center gap-2">
              <Server size={13} className="shrink-0 text-chrome/40" />
              {/* The raw key stays in the tooltip: it is what tells two
                  same-named sessions, or a deleted one, apart. */}
              <span className="min-w-0 flex-1 truncate" title={host.host}>
                {(() => {
                  const { title, detail } = describeHistoryHost(host.host, profiles)
                  return (
                    <>
                      <span className="font-medium text-chrome/85">{title}</span>
                      {detail && <span className="ml-2 text-chrome/35">{detail}</span>}
                    </>
                  )
                })()}
              </span>
              <span className="shrink-0 text-chrome/30">{host.entries.length}</span>
              <button
                type="button"
                onClick={() => void forgetHost(host)}
                title="Forget every command remembered for this host"
                className="shrink-0 rounded px-1.5 py-0.5 text-chrome/40 transition-colors duration-100 hover:bg-chrome/10 hover:text-red-300"
              >
                Forget host
              </button>
            </div>
            <div className="space-y-1">
              {host.entries.slice(0, SHOWN_PER_HOST).map((entry) => (
                <div key={entry.command} className="flex items-center gap-2">
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-chrome/60"
                    title={entry.command}
                  >
                    {entry.command}
                  </span>
                  {/* Imported entries are marked, because "when" means
                      something different for them: it is when the import ran,
                      not when the command did — the file could not say. */}
                  <span className="w-20 shrink-0 text-right text-chrome/25">
                    {entry.source === 'harvest' ? 'imported' : relativeDay(entry.lastUsed, now)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void forgetOne(host.host, entry)}
                    title="Forget this command and never suggest it again"
                    className="flex shrink-0 items-center justify-center rounded p-1 text-chrome/30 transition-colors duration-100 hover:bg-chrome/10 hover:text-red-300"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              {host.entries.length > SHOWN_PER_HOST && (
                <p className="pt-1 text-chrome/25">
                  …and {host.entries.length - SHOWN_PER_HOST} more, ranked below these.
                  Forget the host to remove them all.
                </p>
              )}
            </div>
            {host.blocked.length > 0 && (
              <div className="mt-2 space-y-1 border-t border-chrome/10 pt-1.5">
                <p className="text-chrome/40">Never suggested</p>
                {host.blocked.map((command) => (
                  <div key={command} className="flex items-center gap-2">
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-chrome/40 line-through decoration-chrome/20"
                      title={command}
                    >
                      {command}
                    </span>
                    <button
                      type="button"
                      onClick={() => void allow(host.host, command)}
                      title="Let this command be remembered and suggested again"
                      className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-chrome/40 transition-colors duration-100 hover:bg-chrome/10 hover:text-chrome/80"
                    >
                      <Undo2 size={12} />
                      Allow again
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
