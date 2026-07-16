import { useCallback, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { ConnectDialog } from './ConnectDialog'
import { ForwardPanel } from './ForwardPanel'
import type { PaneLeaf, PaneNode } from '../types'
import type { ConnectionSource } from '../lib/connection'
import type { SessionProfile } from '../lib/profiles'
import type { VaultSecret } from '../lib/vault'
import { DRAG_TAB_MIME } from '../lib/dragTypes'

interface Props {
  node: PaneNode
  vaultUnlocked: boolean
  forwardsOpenByPane: Record<string, boolean>
  sessionIdByPane: Record<string, string | null>
  sessions: SessionProfile[]
  onFocusPane: (id: string) => void
  onConnect: (paneId: string, source: ConnectionSource) => void
  onSelectSession: (paneId: string, profile: SessionProfile) => void
  onEditSession: (paneId: string, profile: SessionProfile) => void
  onDeleteSession: (profile: SessionProfile) => void
  onUnlockAndSelectSession: (paneId: string, profile: SessionProfile, password: string) => Promise<void>
  onSaveProfile: (profile: SessionProfile) => void
  onSaveCredential: (profileId: string, secret: VaultSecret) => void
  onCloseForwards: (paneId: string) => void
  onSlotRef: (paneId: string, el: HTMLDivElement | null) => void
  onDropTab: (targetPaneId: string, draggedTabId: string) => void
}

/** Recursive dispatcher only — no hooks here, since a pane can flip between
 * split and leaf across renders (splitting/closing) and a leaf view's hooks
 * must belong to a component that actually mounts/unmounts on that change,
 * not one that conditionally skips them. */
export function Pane(props: Props) {
  const { node } = props

  if (node.type === 'split') {
    return (
      <PanelGroup direction={node.direction}>
        <Panel defaultSize={node.sizes[0]} minSize={10}>
          <Pane {...props} node={node.children[0]} />
        </Panel>
        <PanelResizeHandle
          className={`bg-white/5 transition-colors duration-150 hover:bg-sky-400/40 active:bg-sky-400/60 ${
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
    vaultUnlocked,
    forwardsOpenByPane,
    sessionIdByPane,
    sessions,
    onFocusPane,
    onConnect,
    onSelectSession,
    onEditSession,
    onDeleteSession,
    onUnlockAndSelectSession,
    onSaveProfile,
    onSaveCredential,
    onCloseForwards,
    onSlotRef,
    onDropTab,
  } = props
  const sessionId = sessionIdByPane[node.id] ?? null
  // Stable across re-renders of this same leaf — an inline `(el) =>
  // onSlotRef(node.id, el)` would be a brand-new function every render,
  // which makes React treat the ref as "changed" every time, perpetually
  // detaching and reattaching it (each of which calls onSlotRef, which
  // updates state, which triggers another render — infinite loop).
  const slotRef = useCallback(
    (el: HTMLDivElement | null) => onSlotRef(node.id, el),
    [node.id, onSlotRef],
  )
  const [dragOver, setDragOver] = useState(false)

  return (
    <div
      className="relative flex h-full w-full flex-col"
      onFocusCapture={() => onFocusPane(node.id)}
      onMouseDown={() => onFocusPane(node.id)}
    >
      {node.source ? (
        // The actual <Terminal> lives in a single flat pool rendered once at
        // the App root (see App.tsx) and is portaled in here — not mounted
        // directly in this tree — so that dragging a connection between
        // tabs/panes moves data, not a React component. If this div were
        // the terminal's real home, moving it between tabs (a totally
        // separate React subtree per tab) would force an unmount/remount,
        // tearing down the live session to move it.
        <div ref={slotRef} className="relative h-full w-full" />
      ) : (
        <div
          className={`h-full w-full transition-colors duration-100 ${dragOver ? 'bg-sky-400/10' : ''}`}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(DRAG_TAB_MIME)) return
            e.preventDefault()
            // Chromium (WebView2 on Windows) is stricter than WebKitGTK
            // here — without an explicit dropEffect matching what dragstart
            // declared as effectAllowed, it shows the "not allowed" cursor
            // over this drop target even though preventDefault() was
            // called, which is technically enough on some engines but not
            // this one.
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
          <ConnectDialog
            // Remounts fresh (with the newly-selected profile's data already
            // baked into its initial useState() calls) whenever a different
            // saved session is picked from the sidebar — simpler than
            // syncing every field from `initial` via an effect, and it's
            // exactly the "start fresh" semantics we want here anyway.
            key={node.initial?.id ?? 'blank'}
            initial={node.initial}
            vaultUnlocked={vaultUnlocked}
            sessions={sessions}
            onConnect={(source) => onConnect(node.id, source)}
            onSelectSession={(profile) => onSelectSession(node.id, profile)}
            onEditSession={(profile) => onEditSession(node.id, profile)}
            onDeleteSession={onDeleteSession}
            onUnlockAndSelectSession={(profile, password) =>
              onUnlockAndSelectSession(node.id, profile, password)
            }
            onSaveProfile={onSaveProfile}
            onSaveCredential={onSaveCredential}
          />
        </div>
      )}
      {forwardsOpenByPane[node.id] && sessionId && (
        <ForwardPanel sessionId={sessionId} onClose={() => onCloseForwards(node.id)} />
      )}
    </div>
  )
}
