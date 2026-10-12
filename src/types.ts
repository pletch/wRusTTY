import type { ConnectionSource } from './lib/connection'
import type { ConnectDialogInitial } from './components/ConnectDialog'

/** A single terminal — either awaiting connection info or holding a live session. */
export interface PaneLeaf {
  type: 'leaf'
  id: string
  source: ConnectionSource | null
  /** Bumped to force the Terminal to remount and open a fresh session. */
  generation: number
  /** Pre-fills the connect form when opening a saved session profile. */
  initial?: ConnectDialogInitial
  /** Per-pane override for "backspace sends Ctrl-H", resolved at connect from
   * the profile or form; null follows the global setting. On the pane because
   * it's a terminal-side byte choice that applies to every protocol. */
  backspaceSendsCtrlH?: boolean | null
  /** Per-pane opt-out of auto-reconnect, resolved at connect; null follows the
   * global setting. Combined by `reconnectPolicy` and sent with the connect
   * command; nothing reads it afterward. */
  autoReconnect?: boolean | null
}

/** Always exactly 2 children; nesting builds arbitrary layouts. */
export interface PaneSplit {
  type: 'split'
  id: string
  /** Matches react-resizable-panels' PanelGroup direction. */
  direction: 'horizontal' | 'vertical'
  children: [PaneNode, PaneNode]
  sizes: [number, number]
}

export type PaneNode = PaneLeaf | PaneSplit

export interface Tab {
  id: string
  title: string
  root: PaneNode
  activePaneId: string
}
