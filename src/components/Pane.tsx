import { useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { SplitSquareHorizontal, SplitSquareVertical, X, ScrollText, ArrowLeftRight } from 'lucide-react'
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

const toolbarButton =
  'flex items-center justify-center rounded p-1 text-white/35 transition-colors duration-150 hover:bg-white/10 hover:text-white/85'

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
      className={`relative flex h-full w-full flex-col rounded-md transition-shadow duration-150 ${
        active ? 'ring-1 ring-inset ring-sky-400/40' : 'ring-1 ring-inset ring-transparent'
      }`}
      onFocusCapture={() => onFocusPane(node.id)}
      onMouseDown={() => onFocusPane(node.id)}
    >
      <div className="flex h-6 shrink-0 items-center justify-end gap-0.5 rounded-t-md bg-black/30 px-1">
        {node.source && (
          <button
            className={`${toolbarButton} ${loggingEnabled ? 'text-red-400 hover:text-red-300' : ''}`}
            title={
              loggingEnabled
                ? 'Session logging on (applies from next connect)'
                : 'Log session output to file (applies from next connect)'
            }
            onClick={() => setLoggingEnabled((v) => !v)}
          >
            <ScrollText size={13} strokeWidth={2} />
          </button>
        )}
        {isSsh && sessionId && (
          <button
            className={toolbarButton}
            title="Port forwarding"
            onClick={() => setForwardsOpen((v) => !v)}
          >
            <ArrowLeftRight size={13} strokeWidth={2} />
          </button>
        )}
        <button
          className={toolbarButton}
          title="Split right"
          onClick={() => onSplit(node.id, 'horizontal')}
        >
          <SplitSquareHorizontal size={13} strokeWidth={2} />
        </button>
        <button
          className={toolbarButton}
          title="Split down"
          onClick={() => onSplit(node.id, 'vertical')}
        >
          <SplitSquareVertical size={13} strokeWidth={2} />
        </button>
        <button
          className={`${toolbarButton} hover:bg-red-500/25 hover:text-white`}
          title="Close pane"
          onClick={() => onClose(node.id)}
        >
          <X size={13} strokeWidth={2} />
        </button>
      </div>
      <div className="relative min-h-0 flex-1 p-1.5">
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
