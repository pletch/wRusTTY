import { useState } from 'react'
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
  onFocusPane: (id: string) => void
  onConnect: (paneId: string, source: ConnectionSource) => void
  onSaveProfile: (profile: SessionProfile) => void
  onSaveCredential: (profileId: string, secret: VaultSecret) => void
  onStatus: (paneId: string, status: string) => void
  onSplit: (paneId: string, direction: 'horizontal' | 'vertical') => void
  onClose: (paneId: string) => void
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
          className={
            node.direction === 'horizontal'
              ? 'w-1 bg-white/5 hover:bg-white/20 active:bg-white/30'
              : 'h-1 bg-white/5 hover:bg-white/20 active:bg-white/30'
          }
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
    onFocusPane,
    onConnect,
    onSaveProfile,
    onSaveCredential,
    onStatus,
    onSplit,
    onClose,
  } = props
  const active = node.id === activePaneId
  const label = node.initial?.label ?? (node.source ? sourceLabel(node.source) : '')
  const isSsh = node.source?.protocol === 'ssh' || node.source?.protocol === 'sshProfile'

  const [sessionId, setSessionId] = useState<string | null>(null)
  const [forwardsOpen, setForwardsOpen] = useState(false)
  const [loggingEnabled, setLoggingEnabled] = useState(false)

  return (
    <div
      className={`relative flex h-full w-full flex-col ${
        active ? 'ring-1 ring-inset ring-white/20' : ''
      }`}
      onFocusCapture={() => onFocusPane(node.id)}
      onMouseDown={() => onFocusPane(node.id)}
    >
      <div className="group flex h-5 shrink-0 items-center justify-end gap-1 bg-black/30 px-1">
        {node.source && (
          <button
            className={`rounded px-1 text-[10px] leading-none hover:bg-white/10 hover:text-white/80 ${
              loggingEnabled ? 'text-red-400' : 'text-white/30'
            }`}
            title={
              loggingEnabled
                ? 'Session logging on (applies from next connect)'
                : 'Log session output to file (applies from next connect)'
            }
            onClick={() => setLoggingEnabled((v) => !v)}
          >
            ●
          </button>
        )}
        {isSsh && sessionId && (
          <button
            className="rounded px-1 text-[10px] leading-none text-white/30 hover:bg-white/10 hover:text-white/80"
            title="Port forwarding"
            onClick={() => setForwardsOpen((v) => !v)}
          >
            ⇄
          </button>
        )}
        <button
          className="rounded px-1 text-[10px] leading-none text-white/30 hover:bg-white/10 hover:text-white/80"
          title="Split right"
          onClick={() => onSplit(node.id, 'horizontal')}
        >
          ⬌
        </button>
        <button
          className="rounded px-1 text-[10px] leading-none text-white/30 hover:bg-white/10 hover:text-white/80"
          title="Split down"
          onClick={() => onSplit(node.id, 'vertical')}
        >
          ⬍
        </button>
        <button
          className="rounded px-1 text-[10px] leading-none text-white/30 hover:bg-red-500/30 hover:text-white/80"
          title="Close pane"
          onClick={() => onClose(node.id)}
        >
          ×
        </button>
      </div>
      <div className="relative min-h-0 flex-1 p-1">
        {node.source ? (
          <Terminal
            key={node.generation}
            source={node.source}
            label={label}
            settings={settings}
            logging={loggingEnabled}
            onStatus={(s) => onStatus(node.id, s)}
            onSessionId={setSessionId}
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
        {forwardsOpen && sessionId && (
          <ForwardPanel sessionId={sessionId} onClose={() => setForwardsOpen(false)} />
        )}
      </div>
    </div>
  )
}
