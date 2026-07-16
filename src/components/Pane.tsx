import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { Terminal } from './Terminal'
import { ConnectDialog } from './ConnectDialog'
import { ForwardPanel } from './ForwardPanel'
import type { PaneLeaf, PaneNode } from '../types'
import type { ConnectionSource } from '../lib/connection'
import { sourceLabel } from '../lib/connection'
import type { SessionProfile } from '../lib/profiles'
import type { VaultSecret } from '../lib/vault'
import type { TerminalSettings } from '../lib/settings'

interface Props {
  node: PaneNode
  activePaneId: string
  settings: TerminalSettings
  vaultUnlocked: boolean
  loggingByPane: Record<string, boolean>
  forwardsOpenByPane: Record<string, boolean>
  sessionIdByPane: Record<string, string | null>
  onFocusPane: (id: string) => void
  onConnect: (paneId: string, source: ConnectionSource) => void
  onSaveProfile: (profile: SessionProfile) => void
  onSaveCredential: (profileId: string, secret: VaultSecret) => void
  onStatus: (paneId: string, status: string) => void
  onSessionId: (paneId: string, id: string | null) => void
  onCloseForwards: (paneId: string) => void
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
    activePaneId,
    settings,
    vaultUnlocked,
    loggingByPane,
    forwardsOpenByPane,
    sessionIdByPane,
    onFocusPane,
    onConnect,
    onSaveProfile,
    onSaveCredential,
    onStatus,
    onSessionId,
    onCloseForwards,
  } = props
  const label = node.initial?.label ?? (node.source ? sourceLabel(node.source) : '')
  const sessionId = sessionIdByPane[node.id] ?? null
  const active = node.id === activePaneId

  return (
    <div
      className="relative flex h-full w-full flex-col"
      onFocusCapture={() => onFocusPane(node.id)}
      onMouseDown={() => onFocusPane(node.id)}
    >
      {node.source ? (
        <Terminal
          key={node.generation}
          source={node.source}
          label={label}
          settings={settings}
          logging={loggingByPane[node.id] ?? false}
          active={active}
          onStatus={(s) => onStatus(node.id, s)}
          onSessionId={(id) => onSessionId(node.id, id)}
        />
      ) : (
        <ConnectDialog
          initial={node.initial}
          vaultUnlocked={vaultUnlocked}
          onConnect={(source) => onConnect(node.id, source)}
          onSaveProfile={onSaveProfile}
          onSaveCredential={onSaveCredential}
        />
      )}
      {forwardsOpenByPane[node.id] && sessionId && (
        <ForwardPanel sessionId={sessionId} onClose={() => onCloseForwards(node.id)} />
      )}
    </div>
  )
}
