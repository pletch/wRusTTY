import { useEffect, useState } from 'react'
import { LayoutGrid, Save, Trash2 } from 'lucide-react'
import * as workspaces from '../lib/workspaces'
import type { Workspace } from '../lib/workspaces'
import type { Tab } from '../types'
import { allLeaves } from '../lib/paneTree'
import { toast } from '../lib/toast'

interface Props {
  /** Live tabs, captured when the user saves. */
  tabs: Tab[]
  /** Adds a workspace's tabs to the window. Additive rather than replacing:
   * opening a workspace must never close live sessions the user is in the
   * middle of. */
  onOpen: (workspace: Workspace) => void
}

const secondaryButton =
  'flex w-full items-center gap-1.5 rounded py-1.5 text-white/60 transition-colors duration-100 hover:bg-white/10 hover:text-white/90'

export function WorkspaceMenu({ tabs, onOpen }: Props) {
  const [open, setOpen] = useState(false)
  const [saved, setSaved] = useState<Workspace[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setName('')
    workspaces.listWorkspaces().then(setSaved).catch(() => {})
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-workspace-menu]')) setOpen(false)
    }
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [open])

  const capturable = workspaces.captureTabs(tabs)
  const paneCount = capturable.reduce((n, t) => n + allLeaves(t.root).length, 0)
  const dropped = workspaces.countDropped(tabs)

  async function doSave(e: React.FormEvent) {
    e.preventDefault()
    if (capturable.length === 0) return
    setBusy(true)
    try {
      await workspaces.saveWorkspace({
        id: crypto.randomUUID(),
        name: name.trim() || `Workspace ${saved.length + 1}`,
        tabs: capturable,
      })
      setSaved(await workspaces.listWorkspaces())
      setName('')
      toast.success('Workspace saved')
    } catch (err) {
      toast.error(String(err))
    } finally {
      setBusy(false)
    }
  }

  async function doDelete(w: Workspace) {
    try {
      await workspaces.deleteWorkspace(w.id)
      setSaved(await workspaces.listWorkspaces())
    } catch (err) {
      toast.error(String(err))
    }
  }

  return (
    <div className="relative" data-workspace-menu>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-center rounded p-1.5 text-white/50 transition-colors duration-150 hover:bg-white/10 hover:text-white/90"
        title="Workspaces"
      >
        <LayoutGrid size={15} strokeWidth={2} />
      </button>
      {open && (
        <div
          className="animate-in fade-in slide-in-from-top-1 absolute right-0 top-full z-50 mt-1.5 w-72 origin-top-right rounded-lg border border-white/10 bg-[#1f2028] p-3 text-xs shadow-xl duration-100"
          onClick={(e) => e.stopPropagation()}
        >
          {saved.length > 0 && (
            <div className="mb-2 space-y-0.5">
              {saved.map((w) => (
                <div
                  key={w.id}
                  className="group flex items-center gap-1.5 rounded px-1.5 py-1.5 text-white/70 transition-colors duration-100 hover:bg-white/[0.06]"
                >
                  <button
                    onClick={() => {
                      onOpen(w)
                      setOpen(false)
                    }}
                    className="min-w-0 flex-1 truncate text-left hover:text-white/90"
                    title="Open this workspace alongside the current tabs"
                  >
                    {w.name}
                    <span className="block text-white/35">
                      {w.tabs.length === 1 ? '1 tab' : `${w.tabs.length} tabs`}
                    </span>
                  </button>
                  <button
                    onClick={() => doDelete(w)}
                    title="Delete workspace"
                    className="shrink-0 text-white/25 opacity-0 transition-opacity duration-100 hover:text-red-300 group-hover:opacity-100"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <form onSubmit={doSave} className="space-y-2 border-t border-white/10 pt-2.5">
            <p className="text-white/60">
              {capturable.length === 0
                ? 'Nothing open that can be saved.'
                : `Save ${paneCount === 1 ? '1 pane' : `${paneCount} panes`} across ${
                    capturable.length === 1 ? '1 tab' : `${capturable.length} tabs`
                  }.`}
            </p>
            {/* Said before saving, not discovered on reopen. Both causes are
                things the user can act on — save the session as a profile, or
                accept that serial stays ad-hoc. */}
            {dropped > 0 && (
              <p className="text-amber-400/70">
                {dropped === 1 ? '1 pane will be skipped' : `${dropped} panes will be skipped`}:
                serial connections, and sessions using a password typed at connect time.
              </p>
            )}
            <input
              className="w-full rounded border border-white/10 bg-black/20 px-2 py-1.5 text-white/90 outline-none transition-colors duration-100 focus:border-sky-400/50"
              placeholder="workspace name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              type="submit"
              disabled={busy || capturable.length === 0}
              className={`${secondaryButton} justify-center disabled:cursor-not-allowed disabled:opacity-40`}
            >
              <Save size={13} /> Save current arrangement
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
