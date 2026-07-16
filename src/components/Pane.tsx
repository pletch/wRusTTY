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
  onFocusPane: (id: string) => void
  onConnect: (paneId: string, source: ConnectionSource) => void
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
    onFocusPane,
    onConnect,
    onSaveProfile,
    onSaveCredential,
    onCloseForwards,
    onSlotRef,
    onDropTab,
  } = props
  const sessionId = sessionIdByPane[node.id] ?? null

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
        <div ref={(el) => onSlotRef(node.id, el)} className="relative h-full w-full" />
      ) : (
        <div
          className="h-full w-full"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes(DRAG_TAB_MIME)) e.preventDefault()
          }}
          onDrop={(e) => {
            const draggedTabId = e.dataTransfer.getData(DRAG_TAB_MIME)
            if (draggedTabId) onDropTab(node.id, draggedTabId)
          }}
        >
          <ConnectDialog
            initial={node.initial}
            vaultUnlocked={vaultUnlocked}
            onConnect={(source) => onConnect(node.id, source)}
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
