import { useEffect, useState } from 'react'
import { RefreshCw, Server, Trash2 } from 'lucide-react'
import {
  forgetCommandHistory,
  listCommandHistory,
  type HistoryEntry,
  type HostHistory,
} from '../lib/commandHistory'
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
  // Sampled once per load rather than per row: a few hundred rows all asking
  // the clock for the same answer is wasted work, and a list whose relative
  // dates disagree by a tick reads as a bug.
  const [now, setNow] = useState(() => Date.now())

  async function load() {
    try {
      setHosts(await listCommandHistory())
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

  async function forgetHost(host: HostHistory) {
    const ok = await confirm({
      title: `Forget every command remembered for ${host.host}?`,
      body:
        `All ${host.entries.length} stored command${host.entries.length === 1 ? '' : 's'} for ` +
        `this host are deleted from this machine. Nothing is sent anywhere and the host's ` +
        `own shell history is untouched — this only removes what wRusTTY kept.`,
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

  async function forgetEverything() {
    const total = hosts?.reduce((sum, h) => sum + h.entries.length, 0) ?? 0
    const ok = await confirm({
      title: 'Forget every remembered command?',
      body:
        `All ${total} stored command${total === 1 ? '' : 's'}, across every host, are deleted ` +
        `from this machine. Autocomplete starts again from nothing. No remote host is ` +
        `contacted and no shell history on any server is changed.`,
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
        <p className="leading-relaxed text-white/50">
          What has been remembered, newest and most-used first. Kept on this machine
          only — never synced, never sent anywhere, and not part of a backup bundle.
          Lines that looked like they carried a password or a token were never stored
          in the first place.
        </p>
        <button
          type="button"
          onClick={() => void load()}
          title="Reload"
          className="mt-0.5 flex shrink-0 items-center justify-center rounded p-1 text-white/40 transition-colors duration-100 hover:bg-white/10 hover:text-white/80"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {error && <p className="text-red-400">{error}</p>}
      {hosts === null && !error && <p className="text-white/40">Loading…</p>}
      {hosts?.length === 0 && (
        <p className="text-white/40">
          Nothing remembered yet. Commands are recorded as you run them, once
          autocomplete is turned on above.
        </p>
      )}

      {hosts !== null && hosts.length > 0 && (
        <button
          type="button"
          onClick={() => void forgetEverything()}
          className="w-full rounded bg-white/[0.06] py-1.5 text-white/70 transition-colors duration-fast ease-swift hover:bg-red-500/20 hover:text-red-200"
        >
          Forget everything
        </button>
      )}

      <div className="space-y-2">
        {hosts?.map((host) => (
          <div key={host.host} className="rounded-md border border-white/10 bg-black/15 p-2">
            <div className="mb-1.5 flex items-center gap-2">
              <Server size={13} className="shrink-0 text-white/40" />
              <span className="min-w-0 flex-1 truncate font-medium text-white/85">
                {host.host}
              </span>
              <span className="shrink-0 text-white/30">{host.entries.length}</span>
              <button
                type="button"
                onClick={() => void forgetHost(host)}
                title="Forget every command remembered for this host"
                className="shrink-0 rounded px-1.5 py-0.5 text-white/40 transition-colors duration-100 hover:bg-white/10 hover:text-red-300"
              >
                Forget host
              </button>
            </div>
            <div className="space-y-1">
              {host.entries.slice(0, SHOWN_PER_HOST).map((entry) => (
                <div key={entry.command} className="flex items-center gap-2">
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-white/60"
                    title={entry.command}
                  >
                    {entry.command}
                  </span>
                  <span className="w-16 shrink-0 text-right text-white/25">
                    {relativeDay(entry.lastUsed, now)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void forgetOne(host.host, entry)}
                    title="Forget this command"
                    className="flex shrink-0 items-center justify-center rounded p-1 text-white/30 transition-colors duration-100 hover:bg-white/10 hover:text-red-300"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              {host.entries.length > SHOWN_PER_HOST && (
                <p className="pt-1 text-white/25">
                  …and {host.entries.length - SHOWN_PER_HOST} more, ranked below these.
                  Forget the host to remove them all.
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
