import type { CommandActivity } from '../lib/shellIntegration'
import { IDLE } from '../lib/shellIntegration'

/** Everything about a pane that isn't its position in the tree (that's
 * `PaneNode`/`Tab` in types.ts) or its saved connection details (that's
 * `PaneLeaf.source`/`initial`) — the live, ephemeral state a connected
 * Terminal reports back up as it runs.
 *
 * Replaces eight parallel `Record<paneId, T>` state hooks that used to live
 * directly in App.tsx (statusByPane, connectedAtByPane, loggingByPane,
 * forwardsOpenByPane, filesOpenByPane, sessionIdByPane, activityByPane,
 * attentionPanes). Those were written from separate handlers and had to be
 * kept in step by hand — closing a pane meant remembering to delete its
 * entry from all eight, and nothing did. One record per pane, deleted in one
 * place (`paneClosed`), makes that leak unrepresentable instead of fixed. */
export interface PaneRuntime {
  status: string
  /** Epoch ms the pane last reached 'connected'; null while disconnected —
   * see the `statusChanged` case below for the coupling. */
  connectedAt: number | null
  sessionId: string | null
  logging: boolean
  forwardsOpen: boolean
  filesOpen: boolean
  activity: CommandActivity
  /** Something you haven't seen: a bell rang, or a long command finished,
   * while this pane wasn't in view. */
  attention: boolean
  /** The pane's grid in cells, as the engine last fitted it — the same
   * numbers sent to the remote PTY, so this is what the far end believes the
   * terminal is. Null until the engine has fitted once. */
  dimensions: PaneDimensions | null
  /** Bytes of scrollback *this pane's engine* was built with. Not derivable
   * from the current setting: the core fixes its limit at construction, so a
   * pane opened before the setting changed keeps the old budget. Null until
   * the engine reports it at mount. */
  scrollbackBudgetBytes: number | null
}

export interface PaneDimensions {
  cols: number
  rows: number
}

const DEFAULT_RUNTIME: PaneRuntime = {
  status: '',
  connectedAt: null,
  sessionId: null,
  logging: false,
  forwardsOpen: false,
  filesOpen: false,
  activity: IDLE,
  attention: false,
  dimensions: null,
  scrollbackBudgetBytes: null,
}

export type PaneRuntimeState = Record<string, PaneRuntime>

export type PaneRuntimeAction =
  | { type: 'paneClosed'; paneId: string }
  | { type: 'statusChanged'; paneId: string; status: string; now: number }
  | { type: 'sessionIdSet'; paneId: string; sessionId: string | null }
  | { type: 'loggingSet'; paneId: string; logging: boolean }
  | { type: 'loggingToggled'; paneId: string }
  | { type: 'panelToggled'; paneId: string; panel: 'forwards' | 'files' }
  | { type: 'panelSet'; paneId: string; panel: 'forwards' | 'files'; open: boolean }
  | { type: 'activityChanged'; paneId: string; activity: CommandActivity }
  | { type: 'attentionRaised'; paneId: string }
  | { type: 'attentionCleared'; paneId: string }
  | { type: 'dimensionsChanged'; paneId: string; cols: number; rows: number }
  | { type: 'scrollbackBudgetSet'; paneId: string; budgetBytes: number }

export function paneRuntimeReducer(state: PaneRuntimeState, action: PaneRuntimeAction): PaneRuntimeState {
  switch (action.type) {
    case 'paneClosed': {
      if (!(action.paneId in state)) return state
      const next = { ...state }
      delete next[action.paneId]
      return next
    }

    case 'statusChanged': {
      const current = state[action.paneId] ?? DEFAULT_RUNTIME
      // Transitioning to 'connected' sets the clock, but only if it isn't
      // already set — a reconnect that goes connecting -> connected ->
      // connecting -> connected shouldn't restart the uptime clock on the
      // second 'connected', only on the first. Any other status clears it,
      // so a genuine reconnect (through a disconnected/failed/connecting
      // stretch) does restart the clock rather than counting through the
      // outage.
      const connectedAt =
        action.status === 'connected' ? (current.connectedAt ?? action.now) : null
      return { ...state, [action.paneId]: { ...current, status: action.status, connectedAt } }
    }

    case 'sessionIdSet':
      return {
        ...state,
        [action.paneId]: { ...(state[action.paneId] ?? DEFAULT_RUNTIME), sessionId: action.sessionId },
      }

    case 'loggingSet':
      return {
        ...state,
        [action.paneId]: { ...(state[action.paneId] ?? DEFAULT_RUNTIME), logging: action.logging },
      }

    case 'loggingToggled': {
      const current = state[action.paneId] ?? DEFAULT_RUNTIME
      return { ...state, [action.paneId]: { ...current, logging: !current.logging } }
    }

    case 'panelToggled': {
      const current = state[action.paneId] ?? DEFAULT_RUNTIME
      const key = action.panel === 'forwards' ? 'forwardsOpen' : 'filesOpen'
      return { ...state, [action.paneId]: { ...current, [key]: !current[key] } }
    }

    case 'panelSet': {
      const current = state[action.paneId] ?? DEFAULT_RUNTIME
      const key = action.panel === 'forwards' ? 'forwardsOpen' : 'filesOpen'
      if (current[key] === action.open) return state
      return { ...state, [action.paneId]: { ...current, [key]: action.open } }
    }

    case 'activityChanged': {
      const current = state[action.paneId]
      const currentActivity = current?.activity ?? IDLE
      // Idle is the resting state for the overwhelming majority of panes
      // (every host with no shell integration, forever) — skip the update
      // entirely rather than produce a new state object nothing needed.
      if (action.activity.state === 'idle' && currentActivity.state === 'idle') return state
      return {
        ...state,
        [action.paneId]: { ...(current ?? DEFAULT_RUNTIME), activity: action.activity },
      }
    }

    case 'attentionRaised':
      return {
        ...state,
        [action.paneId]: { ...(state[action.paneId] ?? DEFAULT_RUNTIME), attention: true },
      }

    case 'attentionCleared': {
      const current = state[action.paneId]
      if (!current?.attention) return state
      return { ...state, [action.paneId]: { ...current, attention: false } }
    }

    case 'dimensionsChanged': {
      const current = state[action.paneId] ?? DEFAULT_RUNTIME
      const dims = current.dimensions
      // The no-op case is the whole point of this action, not a nicety. It is
      // driven by a ResizeObserver, so it fires continuously while a window is
      // dragged — but the *cell* grid changes only when a drag crosses a whole
      // cell, which is a small fraction of those ticks. Returning the same
      // object lets React bail out of the render entirely; without it a drag
      // would re-render App, and with it every pane, at pointer rate. Terminal
      // gates on this too, so an unchanged grid never even dispatches.
      if (dims && dims.cols === action.cols && dims.rows === action.rows) return state
      return {
        ...state,
        [action.paneId]: { ...current, dimensions: { cols: action.cols, rows: action.rows } },
      }
    }

    case 'scrollbackBudgetSet': {
      const current = state[action.paneId] ?? DEFAULT_RUNTIME
      if (current.scrollbackBudgetBytes === action.budgetBytes) return state
      return {
        ...state,
        [action.paneId]: { ...current, scrollbackBudgetBytes: action.budgetBytes },
      }
    }
  }
}

// --- Derived views -----------------------------------------------------
//
// App.tsx's child components (TabBar, Pane, StatusBar) still take the old
// per-field `Record<paneId, T>` shapes; these rebuild those views from the
// consolidated state each render rather than changing every prop signature
// downstream. Each mirrors the exact fallback the corresponding read site
// used before consolidation (some default to false, some to null, some
// leave the pane out of the map entirely) — see App.tsx's call sites.

export function statusByPaneOf(state: PaneRuntimeState): Record<string, string> {
  const out: Record<string, string> = {}
  for (const id in state) out[id] = state[id].status
  return out
}

export function connectedAtByPaneOf(state: PaneRuntimeState): Record<string, number> {
  const out: Record<string, number> = {}
  for (const id in state) {
    const at = state[id].connectedAt
    if (at !== null) out[id] = at
  }
  return out
}

export function loggingByPaneOf(state: PaneRuntimeState): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const id in state) out[id] = state[id].logging
  return out
}

export function forwardsOpenByPaneOf(state: PaneRuntimeState): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const id in state) out[id] = state[id].forwardsOpen
  return out
}

export function filesOpenByPaneOf(state: PaneRuntimeState): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const id in state) out[id] = state[id].filesOpen
  return out
}

export function sessionIdByPaneOf(state: PaneRuntimeState): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const id in state) out[id] = state[id].sessionId
  return out
}

export function activityByPaneOf(state: PaneRuntimeState): Record<string, CommandActivity> {
  const out: Record<string, CommandActivity> = {}
  for (const id in state) out[id] = state[id].activity
  return out
}

export function attentionPanesOf(state: PaneRuntimeState): Record<string, true> {
  const out: Record<string, true> = {}
  for (const id in state) if (state[id].attention) out[id] = true
  return out
}

export function dimensionsByPaneOf(state: PaneRuntimeState): Record<string, PaneDimensions> {
  const out: Record<string, PaneDimensions> = {}
  for (const id in state) {
    const dims = state[id].dimensions
    if (dims !== null) out[id] = dims
  }
  return out
}

export function scrollbackBudgetByPaneOf(state: PaneRuntimeState): Record<string, number> {
  const out: Record<string, number> = {}
  for (const id in state) {
    const budget = state[id].scrollbackBudgetBytes
    if (budget !== null) out[id] = budget
  }
  return out
}
