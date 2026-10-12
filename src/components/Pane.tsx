import { useCallback, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { GripVertical, X } from 'lucide-react'
import { ConnectDialog } from './ConnectDialog'
import { ElevatedRestore } from './ElevatedRestore'
import { ForwardPanel } from './ForwardPanel'
import { FilesPanel, type FilesReveal } from './FilesPanel'
import type { PaneLeaf, PaneNode } from '../types'
import type { ConnectionSource } from '../lib/connection'
import type { SessionProfile } from '../lib/profiles'
import type { Workspace } from '../lib/workspaces'
import type { VaultSecret } from '../lib/vault'
import { DRAG_TAB_MIME, DRAG_PANE_MIME } from '../lib/dragTypes'
import { startDirFor } from '../lib/fileActions'

interface Props {
  node: PaneNode
  tabId: string
  /** Whether this pane's tab is split; the drag/close grip is offered only
   * then. */
  tabHasSplit: boolean
  /** The focused pane in this tab, for the focus ring (and others' scrim). */
  activePaneId: string
  onClosePane: (paneId: string) => void
  vaultUnlocked: boolean
  forwardsOpenByPane: Record<string, boolean>
  /** Each pane's connection status, so the forward panel re-reads its list
   *  after a reconnect. */
  statusByPane: Record<string, string>
  filesOpenByPane: Record<string, boolean>
  /** Where a Ctrl+clicked path asked each pane's files panel to go. */
  filesRevealByPane: Record<string, FilesReveal>
  /** The directory each pane's host last reported, where the Files panel
   *  opens. */
  cwdByPane: Record<string, string | null>
  /** Each host's window title, used only to guess a directory (`startDirFor`). */
  titleByPane: Record<string, string | null>
  /** The `externalEditor` setting, for the Files panel's edit route. */
  editorCommand: string
  /** Whether Settings names an outbound proxy, so the form can offer a bypass. */
  proxyAvailable: boolean
  /** The connected terminal's background as CSS. A waiting pane paints it too,
   * so it matches its tab and doesn't change tone on connect. */
  paneBackground: string
  sessionIdByPane: Record<string, string | null>
  sessions: SessionProfile[]
  workspaces: Workspace[]
  onOpenWorkspace: (workspace: Workspace) => void
  onFocusPane: (id: string) => void
  onConnect: (
    paneId: string,
    source: ConnectionSource,
    logSession: boolean,
    paneOptions?: {
      backspaceSendsCtrlH: boolean | null
      autoReconnect: boolean | null
      label?: string | null
      form?: PaneLeaf['initial'] | null
    },
  ) => void
  onSelectSession: (paneId: string, profile: SessionProfile) => void
  onEditSession: (paneId: string, profile: SessionProfile) => void
  onDeleteSession: (profile: SessionProfile) => void
  onWakeSession: (profile: SessionProfile) => void
  onUnlockAndSelectSession: (paneId: string, profile: SessionProfile, password: string) => Promise<void>
  osUnlockAvailable: boolean
  onUnlockWithOsAndSelectSession: (paneId: string, profile: SessionProfile) => Promise<void>
  onSaveProfile: (profile: SessionProfile) => void
  onSaveCredential: (profileId: string, secret: VaultSecret) => void
  onImportKeyToVault: (profileId: string, keyPath: string, passphrase: string | null) => void
  onDeleteCredential: (profileId: string) => void
  onReorderSessions: (draggedId: string, targetId: string) => void
  onCloseForwards: (paneId: string) => void
  onCloseFiles: (paneId: string) => void
  onSlotRef: (paneId: string, el: HTMLDivElement | null) => void
  onDropTab: (targetPaneId: string, draggedTabId: string) => void
}

/** Recursive dispatcher only, with no hooks: a pane can flip between split
 * and leaf, and a leaf's hooks must belong to a component that mounts and
 * unmounts with it. */
export function Pane(props: Props) {
  const { node } = props

  if (node.type === 'split') {
    return (
      <PanelGroup direction={node.direction}>
        <Panel defaultSize={node.sizes[0]} minSize={10}>
          <Pane {...props} node={node.children[0]} />
        </Panel>
        <PanelResizeHandle
          className={`bg-chrome/5 transition-colors duration-150 hover:bg-sky-400/40 active:bg-sky-400/60 ${
            node.direction === 'horizontal' ? 'w-[3px]' : 'h-[3px]'
          }`}
        />
        <Panel defaultSize={node.sizes[1]} minSize={10}>
          <Pane {...props} node={node.children[1]} />
        </Panel>
      </PanelGroup>
    )
  }

  return <PaneLeafView {...props} node={node} />
}

function PaneLeafView(props: Omit<Props, 'node'> & { node: PaneLeaf }) {
  const {
    node,
    tabId,
    tabHasSplit,
    activePaneId,
    onClosePane,
    vaultUnlocked,
    forwardsOpenByPane,
    statusByPane,
    filesOpenByPane,
    filesRevealByPane,
    cwdByPane,
    titleByPane,
    editorCommand,
    proxyAvailable,
    paneBackground,
    sessionIdByPane,
    sessions,
    workspaces,
    onOpenWorkspace,
    onFocusPane,
    onConnect,
    onSelectSession,
    onEditSession,
    onDeleteSession,
    onWakeSession,
    onUnlockAndSelectSession,
    osUnlockAvailable,
    onUnlockWithOsAndSelectSession,
    onSaveProfile,
    onSaveCredential,
    onImportKeyToVault,
    onDeleteCredential,
    onReorderSessions,
    onCloseForwards,
    onCloseFiles,
    onSlotRef,
    onDropTab,
  } = props
  const sessionId = sessionIdByPane[node.id] ?? null
  // Stable across renders: an inline ref callback would detach and reattach
  // every render, and each call updates state, looping forever.
  const slotRef = useCallback(
    (el: HTMLDivElement | null) => onSlotRef(node.id, el),
    [node.id, onSlotRef],
  )
  const [dragOver, setDragOver] = useState(false)
  const [gripHover, setGripHover] = useState(false)
  // A restored administrator pane asks one question instead of showing the form
  // (see ElevatedRestore); "change settings" sets this.
  const [showElevatedForm, setShowElevatedForm] = useState(false)
  const elevatedShellId = node.initial?.local?.elevated ? node.initial.local.shellId : null
  // Only once split: a lone pane needs no highlight.
  const isActive = tabHasSplit && node.id === activePaneId

  return (
    <div
      className="relative flex h-full w-full min-w-0 flex-col"
      onFocusCapture={() => onFocusPane(node.id)}
      onMouseDown={() => onFocusPane(node.id)}
    >
      {tabHasSplit && (
        // A small corner hotzone rather than the whole pane, overlaid on the
        // content's own background.
        <div
          // Offset to roughly clear the custom scrollbar, which sizes itself
          // dynamically (see updateScrollbarGeometry in Terminal.tsx); z-30, above
          // the scrollbar's z-20, keeps the icons clickable regardless.
          className="absolute right-3 top-0 z-30 flex h-6 w-14 items-start justify-end gap-0.5 p-1"
          onMouseEnter={() => setGripHover(true)}
          onMouseLeave={() => setGripHover(false)}
        >
          {gripHover && (
            <>
              <span
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData(DRAG_PANE_MIME, JSON.stringify({ tabId, paneId: node.id }))
                }}
                onMouseDown={(e) => e.stopPropagation()}
                title="Drag to move this pane to a new tab"
                className="cursor-grab rounded bg-black/40 p-1 text-chrome/50 backdrop-blur-sm hover:bg-black/60 hover:text-chrome/90 active:cursor-grabbing"
              >
                <GripVertical size={12} />
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onClosePane(node.id)
                }}
                onMouseDown={(e) => e.stopPropagation()}
                title="Close this pane"
                className="rounded bg-black/40 p-1 text-chrome/50 backdrop-blur-sm hover:bg-red-500/60 hover:text-chrome"
              >
                <X size={12} />
              </button>
            </>
          )}
        </div>
      )}
      {node.source ? (
        // The <Terminal> lives in a flat pool at the App root and is portaled
        // here, so moving a connection between tabs moves data rather than
        // remounting (and tearing down) the session.
        <div ref={slotRef} className="relative h-full w-full" />
      ) : (
        <div
          // Painted explicitly: below full opacity the terminal paints over the
          // window, so the window's own background is a different color.
          style={{ background: paneBackground }}
          className={`h-full w-full min-w-0 transition-colors duration-100 ${dragOver ? 'bg-sky-400/10' : ''}`}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(DRAG_TAB_MIME)) return
            e.preventDefault()
            // WebView2 shows "not allowed" over the drop target unless dropEffect
            // matches dragstart's effectAllowed, even after preventDefault().
            e.dataTransfer.dropEffect = 'move'
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            setDragOver(false)
            const draggedTabId = e.dataTransfer.getData(DRAG_TAB_MIME)
            if (draggedTabId) onDropTab(node.id, draggedTabId)
          }}
        >
          {elevatedShellId && !showElevatedForm ? (
            <ElevatedRestore
              shellId={elevatedShellId}
              label={node.initial?.label}
              onReopen={() =>
                onConnect(
                  node.id,
                  { protocol: 'elevated', shellId: elevatedShellId, profileId: node.initial?.id ?? null },
                  false,
                  {
                    backspaceSendsCtrlH: null,
                    autoReconnect: false,
                    label: node.initial?.label ?? null,
                    // Kept, so closing wRusTTY again restores this card.
                    form: node.initial ?? null,
                  },
                )
              }
              onClose={() => onClosePane(node.id)}
              onEdit={() => setShowElevatedForm(true)}
            />
          ) : (
          <ConnectDialog
            // Remounts fresh when a different saved session is picked, rather than
            // syncing every field from `initial` in an effect.
            key={node.initial?.id ?? 'blank'}
            initial={node.initial}
            vaultUnlocked={vaultUnlocked}
            proxyAvailable={proxyAvailable}
            sessions={sessions}
            workspaces={workspaces}
            onOpenWorkspace={onOpenWorkspace}
            onConnect={(source, logSession, paneOptions) =>
              onConnect(node.id, source, logSession, paneOptions)
            }
            onSelectSession={(profile) => onSelectSession(node.id, profile)}
            onEditSession={(profile) => onEditSession(node.id, profile)}
            onDeleteSession={onDeleteSession}
            onWakeSession={onWakeSession}
            onUnlockAndSelectSession={(profile, password) =>
              onUnlockAndSelectSession(node.id, profile, password)
            }
            osUnlockAvailable={osUnlockAvailable}
            onUnlockWithOsAndSelectSession={(profile) =>
              onUnlockWithOsAndSelectSession(node.id, profile)
            }
            onSaveProfile={onSaveProfile}
            onSaveCredential={onSaveCredential}
            onImportKeyToVault={onImportKeyToVault}
            onDeleteCredential={onDeleteCredential}
            onReorderSessions={onReorderSessions}
          />
          )}
        </div>
      )}
      {tabHasSplit && (
        // Focus affordance for splits: one pointer-events-none overlay above the
        // WebGL canvas (an inset shadow on the wrapper would be underneath it).
        // Always mounted so focus changes cross-fade. z-20, below the grip's z-30.
        // The inactive scrim is faint enough to keep a watched pane readable.
        <div
          aria-hidden
          className={`pointer-events-none absolute inset-0 z-20 ring-1 ring-inset transition-[box-shadow,background-color] duration-base ease-swift ${
            isActive ? 'ring-sky-400/45' : 'bg-black/15 ring-transparent'
          }`}
        />
      )}
      {forwardsOpenByPane[node.id] && sessionId && (
        <ForwardPanel
          sessionId={sessionId}
          status={statusByPane[node.id]}
          onClose={() => onCloseForwards(node.id)}
        />
      )}
      {filesOpenByPane[node.id] && sessionId && (
        <FilesPanel
          sessionId={sessionId}
          startDir={startDirFor(cwdByPane[node.id], titleByPane[node.id])}
          reveal={filesRevealByPane[node.id] ?? null}
          editorCommand={editorCommand}
          onClose={() => onCloseFiles(node.id)}
        />
      )}
    </div>
  )
}
