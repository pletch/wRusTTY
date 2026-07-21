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
  /** Per-pane override for the global "backspace sends Ctrl-H" setting,
   * resolved at connect time from the session profile or the connect form.
   * `null`/absent follows the global setting.
   *
   * Lives on the pane rather than in the connection config because it is a
   * terminal-side concern: nothing is sent to the far end, the local terminal
   * simply emits a different byte. It applies to SSH, telnet, and serial
   * alike, which is why it isn't a field on any one protocol's config. */
  backspaceSendsCtrlH?: boolean | null
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
