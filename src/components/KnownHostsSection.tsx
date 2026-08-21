import { useEffect, useState } from 'react'
import { RefreshCw, ShieldCheck, Trash2, TriangleAlert } from 'lucide-react'
import {
  forgetHost,
  forgetHostKey,
  groupByHost,
  hostLabel,
  listKnownHosts,
  type KnownHostGroup,
} from '../lib/knownHosts'
import { toast } from '../lib/toast'
import { useConfirm } from './confirmContext'

/**
 * The host-key trust store, listed and removable.
 *
 * Reading this store is the half that was missing. The prompt that writes it
 * has always existed, so trust could be granted and never withdrawn — and the
 * case that matters is not exotic: a host gets rebuilt, offers a new key, and
 * the prompt correctly says the key changed and this may be an attack. With no
 * way to remove the old entry, the only fix was hand-editing `known_hosts`,
 * which is exactly when a user learns to click through the warning instead.
 *
 * Deliberately blunt about what it does. Forgetting a key is *safe* — the worst
 * outcome is being asked to confirm the fingerprint again on the next connect —
 * and saying so is what stops the confirmation dialogs reading as though the
 * dangerous direction were this one. The dangerous direction is accepting a
 * changed key, and that prompt lives elsewhere.
 */
export function KnownHostsSection() {
  const confirm = useConfirm()
  const [groups, setGroups] = useState<KnownHostGroup[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    try {
      setGroups(groupByHost(await listKnownHosts()))
      setError(null)
    } catch (err) {
      setError(String(err))
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function removeKey(group: KnownHostGroup, keyText: string, algorithm: string | null) {
    const ok = await confirm({
      title: `Forget this key for ${hostLabel(group.host, group.port)}?`,
      body:
        `The ${algorithm ?? 'unreadable'} key is removed from known_hosts. ` +
        `Nothing is sent to the host and no connection is affected — the next time you ` +
        `connect you will be asked to confirm its fingerprint, as you were the first time.`,
      confirmLabel: 'Forget',
    })
    if (!ok) return
    try {
      await forgetHostKey(group.host, group.port, keyText)
      await load()
    } catch (err) {
      toast.error(String(err))
    }
  }

  async function removeHost(group: KnownHostGroup) {
    const ok = await confirm({
      title: `Forget ${hostLabel(group.host, group.port)}?`,
      body:
        `All ${group.keys.length} stored key${group.keys.length === 1 ? '' : 's'} for this host ` +
        `are removed. The next connection is treated as a first connection, fingerprint ` +
        `prompt and all — which is what you want after a host has been rebuilt.`,
      confirmLabel: 'Forget host',
    })
    if (!ok) return
    try {
      await forgetHost(group.host, group.port)
      await load()
    } catch (err) {
      toast.error(String(err))
    }
  }

  return (
    <div className="space-y-3 px-2 py-1.5">
      <div className="flex items-start justify-between gap-3">
        <p className="leading-relaxed text-chrome/50">
          Keys accepted at a fingerprint prompt, one per algorithm per host. Forgetting one
          is safe: it asks you to confirm the fingerprint again next time rather than
          weakening anything. Do it when a host has been rebuilt and its key legitimately
          changed.
        </p>
        <button
          type="button"
          onClick={() => void load()}
          title="Reload from disk"
          className="mt-0.5 flex shrink-0 items-center justify-center rounded p-1 text-chrome/40 transition-colors duration-100 hover:bg-chrome/10 hover:text-chrome/80"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {error && <p className="text-red-400">{error}</p>}
      {groups === null && !error && <p className="text-chrome/40">Loading…</p>}
      {groups?.length === 0 && (
        <p className="text-chrome/40">
          No host keys stored yet. One is added each time you accept a fingerprint.
        </p>
      )}

      <div className="space-y-2">
        {groups?.map((group) => (
          <div key={group.id} className="rounded-md border border-chrome/10 bg-black/15 p-2">
            <div className="mb-1.5 flex items-center gap-2">
              <ShieldCheck size={13} className="shrink-0 text-chrome/40" />
              <span className="min-w-0 flex-1 truncate font-medium text-chrome/85">
                {hostLabel(group.host, group.port)}
              </span>
              {group.keys.length > 1 && (
                // Only offered when it means something more than the row
                // button. One key and one host are the same action, and two
                // buttons doing one thing is how a user ends up unsure which
                // they pressed.
                <button
                  type="button"
                  onClick={() => void removeHost(group)}
                  title="Forget every key stored for this host"
                  className="shrink-0 rounded px-1.5 py-0.5 text-chrome/40 transition-colors duration-100 hover:bg-chrome/10 hover:text-red-300"
                >
                  Forget host
                </button>
              )}
            </div>
            <div className="space-y-1">
              {group.keys.map((key) => (
                <div key={key.keyText} className="flex items-center gap-2">
                  {key.fingerprint ? (
                    <>
                      <span className="w-40 shrink-0 truncate text-chrome/45">
                        {key.algorithm}
                      </span>
                      <span
                        className="min-w-0 flex-1 truncate font-mono text-chrome/30"
                        title={key.fingerprint}
                      >
                        {key.fingerprint}
                      </span>
                    </>
                  ) : (
                    // The entry that most needs deleting, and the only one the
                    // user cannot otherwise act on: an unreadable line makes
                    // every connection to this host report "the key changed",
                    // because a corrupt entry could be the one that would have
                    // matched and is deliberately failed closed.
                    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-amber-300/80">
                      <TriangleAlert size={12} className="shrink-0" />
                      <span className="truncate">
                        Unreadable entry — this host will keep reporting a changed key
                        until it is removed
                      </span>
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => void removeKey(group, key.keyText, key.algorithm)}
                    title="Forget this key"
                    className="flex shrink-0 items-center justify-center rounded p-1 text-chrome/30 transition-colors duration-100 hover:bg-chrome/10 hover:text-red-300"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
