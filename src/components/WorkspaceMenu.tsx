import { useEffect, useState } from 'react'
import { LayoutGrid, RefreshCw, Save, Trash2 } from 'lucide-react'
import * as workspaces from '../lib/workspaces'
import type { Workspace } from '../lib/workspaces'
import type { Tab } from '../types'
import { allLeaves } from '../lib/paneTree'
import { toast } from '../lib/toast'
import { useDismissable } from '../hooks/useDismissable'
import { useConfirm } from './confirmContext'

interface Props {
  /** Live tabs, captured when the user saves. */
  tabs: Tab[]
  /** Owned by App so this menu and the connect dialog's sidebar show the
   * same list. */
  saved: Workspace[]
  /** Adds a workspace's tabs to the window. Additive rather than replacing:
   * opening a workspace must never close live sessions the user is in the
   * middle of. */
  onOpen: (workspace: Workspace) => void
  /** Signals App to re-read the list after a save or delete. */
  onChanged: () => void
}

const secondaryButton =
  'flex w-full items-center gap-1.5 rounded py-1.5 text-chrome/60 transition-colors duration-100 hover:bg-chrome/10 hover:text-chrome/90'

export function WorkspaceMenu({ tabs, saved, onOpen, onChanged }: Props) {
  const confirm = useConfirm()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setName('')
  }, [open])

  useDismissable(open, () => setOpen(false), { within: '[data-workspace-menu]' })

  const capturable = workspaces.captureTabs(tabs)
  const paneCount = capturable.reduce((n, t) => n + allLeaves(t.root).length, 0)
  const dropped = workspaces.countDropped(tabs)
  const nothingToSave = capturable.length === 0
  const arrangement = `${paneCount === 1 ? '1 pane' : `${paneCount} panes`} across ${
    capturable.length === 1 ? '1 tab' : `${capturable.length} tabs`
  }`
  // Names are unique, so typing one that exists can only mean "replace that
  // one" — offered as such instead of letting the save come back as an error.
  const collision = workspaces.findByName(saved, name)

  /** Replacing discards a stored arrangement with no undo, so it always asks
   * — including from the save form, where the collision may well be a
   * surprise rather than the intent. */
  function confirmReplace(w: Workspace) {
    return confirm({
      title: `Replace "${w.name}"?`,
      body: `It will be replaced with the current ${arrangement}. Its saved arrangement is discarded.`,
      confirmLabel: 'Replace',
    })
  }

  async function persist(id: string, workspaceName: string, replacing: boolean) {
    setBusy(true)
    try {
      await workspaces.saveWorkspace({ id, name: workspaceName, tabs: capturable })
      onChanged()
      setName('')
      toast.success(replacing ? `Replaced "${workspaceName}"` : 'Workspace saved')
    } catch (err) {
      toast.error(String(err))
    } finally {
      setBusy(false)
    }
  }

  async function doSave(e: React.FormEvent) {
    e.preventDefault()
    if (nothingToSave) return
    if (collision) {
      if (!(await confirmReplace(collision))) return
      await persist(collision.id, collision.name, true)
      return
    }
    await persist(crypto.randomUUID(), name.trim() || workspaces.defaultName(saved), false)
  }

  /** Re-capture over an existing workspace, keeping its id and name. Without
   * this the only way to update one was to delete it and save again. */
  async function doReplace(w: Workspace) {
    if (nothingToSave || !(await confirmReplace(w))) return
    await persist(w.id, w.name, true)
  }

  async function doDelete(w: Workspace) {
    try {
      await workspaces.deleteWorkspace(w.id)
      onChanged()
    } catch (err) {
      toast.error(String(err))
    }
  }

  return (
    <div className="relative" data-workspace-menu>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-center rounded p-1.5 text-chrome/50 transition-colors duration-150 hover:bg-chrome/10 hover:text-chrome/90"
        title="Workspaces"
      >
        <LayoutGrid size={15} strokeWidth={2} />
      </button>
      {open && (
        <div
          className="animate-in fade-in slide-in-from-top-1 absolute right-0 top-full z-50 mt-1.5 w-72 origin-top-right rounded-lg border border-chrome/10 bg-surface p-3 text-xs shadow-xl duration-100"
          onClick={(e) => e.stopPropagation()}
        >
          {saved.length > 0 && (
            <div className="mb-2 space-y-0.5">
              {saved.map((w) => (
                <div
                  key={w.id}
                  className="group flex items-center gap-1.5 rounded px-1.5 py-1.5 text-chrome/70 transition-colors duration-100 hover:bg-chrome/[0.06]"
                >
                  <button
                    onClick={() => {
                      onOpen(w)
                      setOpen(false)
                    }}
                    className="min-w-0 flex-1 truncate text-left hover:text-chrome/90"
                    title="Open this workspace alongside the current tabs"
                  >
                    {w.name}
                    <span className="block text-chrome/35">
                      {w.tabs.length === 1 ? '1 tab' : `${w.tabs.length} tabs`}
                    </span>
                  </button>
                  <button
                    onClick={() => doReplace(w)}
                    disabled={busy || nothingToSave}
                    title={
                      nothingToSave
                        ? 'Nothing open that can be saved'
                        : `Replace with the current ${arrangement}`
                    }
                    className="shrink-0 text-chrome/25 opacity-0 transition-opacity duration-100 hover:text-sky-300 disabled:cursor-not-allowed disabled:hover:text-chrome/25 group-hover:opacity-100"
                  >
                    <RefreshCw size={12} />
                  </button>
                  <button
                    onClick={() => doDelete(w)}
                    title="Delete workspace"
                    className="shrink-0 text-chrome/25 opacity-0 transition-opacity duration-100 hover:text-red-300 group-hover:opacity-100"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <form onSubmit={doSave} className="space-y-2 border-t border-chrome/10 pt-2.5">
            <p className="text-chrome/60">
              {nothingToSave ? 'Nothing open that can be saved.' : `Save ${arrangement}.`}
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
              className="w-full rounded border border-chrome/10 bg-black/20 px-2 py-1.5 text-chrome/90 outline-none transition-colors duration-100 focus:border-sky-400/50"
              placeholder="workspace name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              type="submit"
              disabled={busy || nothingToSave}
              className={`${secondaryButton} justify-center disabled:cursor-not-allowed disabled:opacity-40`}
            >
              {collision ? (
                <>
                  <RefreshCw size={13} /> Replace &ldquo;{collision.name}&rdquo;
                </>
              ) : (
                <>
                  <Save size={13} /> Save current arrangement
                </>
              )}
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
