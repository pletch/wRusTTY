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
}

/** Always exactly 2 children — nesting splits produces arbitrary layouts,
 * same as Tabby's/VS Code's split-pane model. */
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
