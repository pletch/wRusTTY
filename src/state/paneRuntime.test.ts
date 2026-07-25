import { describe, it, expect } from 'vitest'
import { IDLE } from '../lib/shellIntegration'
import type { CommandActivity } from '../lib/shellIntegration'
import {
  paneRuntimeReducer,
  statusByPaneOf,
  connectedAtByPaneOf,
  loggingByPaneOf,
  forwardsOpenByPaneOf,
  filesOpenByPaneOf,
  sessionIdByPaneOf,
  activityByPaneOf,
  attentionPanesOf,
} from './paneRuntime'
import type { PaneRuntimeState } from './paneRuntime'

const EMPTY: PaneRuntimeState = {}

describe('statusChanged / connectedAt coupling', () => {
  it('sets connectedAt on the first transition to connected', () => {
    const state = paneRuntimeReducer(EMPTY, { type: 'statusChanged', paneId: 'p1', status: 'connected', now: 1000 })
    expect(state.p1.status).toBe('connected')
    expect(state.p1.connectedAt).toBe(1000)
  })

  it('does not restart the clock on a second connected in a row', () => {
    let state = paneRuntimeReducer(EMPTY, { type: 'statusChanged', paneId: 'p1', status: 'connected', now: 1000 })
    state = paneRuntimeReducer(state, { type: 'statusChanged', paneId: 'p1', status: 'connected', now: 2000 })
    expect(state.p1.connectedAt).toBe(1000)
  })

  it('clears connectedAt on any non-connected status', () => {
    let state = paneRuntimeReducer(EMPTY, { type: 'statusChanged', paneId: 'p1', status: 'connected', now: 1000 })
    state = paneRuntimeReducer(state, { type: 'statusChanged', paneId: 'p1', status: 'disconnected', now: 2000 })
    expect(state.p1.status).toBe('disconnected')
    expect(state.p1.connectedAt).toBeNull()
  })

  it('a reconnect (connected -> disconnected -> connected) restarts the clock', () => {
    let state = paneRuntimeReducer(EMPTY, { type: 'statusChanged', paneId: 'p1', status: 'connected', now: 1000 })
    state = paneRuntimeReducer(state, { type: 'statusChanged', paneId: 'p1', status: 'disconnected', now: 2000 })
    state = paneRuntimeReducer(state, { type: 'statusChanged', paneId: 'p1', status: 'connected', now: 3000 })
    expect(state.p1.connectedAt).toBe(3000)
  })
})

describe('paneClosed', () => {
  it('deletes the whole record for that pane, and no other pane', () => {
    let state = paneRuntimeReducer(EMPTY, { type: 'statusChanged', paneId: 'p1', status: 'connected', now: 1 })
    state = paneRuntimeReducer(state, { type: 'statusChanged', paneId: 'p2', status: 'connected', now: 1 })
    state = paneRuntimeReducer(state, { type: 'paneClosed', paneId: 'p1' })
    expect('p1' in state).toBe(false)
    expect('p2' in state).toBe(true)
  })

  it('is a no-op (same reference) for a pane with no record', () => {
    const state = paneRuntimeReducer(EMPTY, { type: 'paneClosed', paneId: 'ghost' })
    expect(state).toBe(EMPTY)
  })

  it('opening and closing 100 panes leaves the runtime map empty', () => {
    let state: PaneRuntimeState = {}
    const ids = Array.from({ length: 100 }, (_, i) => `pane-${i}`)
    for (const id of ids) {
      state = paneRuntimeReducer(state, { type: 'statusChanged', paneId: id, status: 'connected', now: 1 })
      state = paneRuntimeReducer(state, { type: 'sessionIdSet', paneId: id, sessionId: 's' })
      state = paneRuntimeReducer(state, { type: 'loggingToggled', paneId: id })
      state = paneRuntimeReducer(state, { type: 'attentionRaised', paneId: id })
    }
    expect(Object.keys(state).length).toBe(100)
    for (const id of ids) {
      state = paneRuntimeReducer(state, { type: 'paneClosed', paneId: id })
    }
    expect(state).toEqual({})
  })
})

describe('sessionIdSet / loggingSet / loggingToggled', () => {
  it('sets and clears a session id', () => {
    let state = paneRuntimeReducer(EMPTY, { type: 'sessionIdSet', paneId: 'p1', sessionId: 'abc' })
    expect(state.p1.sessionId).toBe('abc')
    state = paneRuntimeReducer(state, { type: 'sessionIdSet', paneId: 'p1', sessionId: null })
    expect(state.p1.sessionId).toBeNull()
  })

  it('loggingSet assigns the given value regardless of the prior one', () => {
    let state = paneRuntimeReducer(EMPTY, { type: 'loggingSet', paneId: 'p1', logging: true })
    expect(state.p1.logging).toBe(true)
    state = paneRuntimeReducer(state, { type: 'loggingSet', paneId: 'p1', logging: true })
    expect(state.p1.logging).toBe(true)
  })

  it('loggingToggled flips from the implicit false default', () => {
    let state = paneRuntimeReducer(EMPTY, { type: 'loggingToggled', paneId: 'p1' })
    expect(state.p1.logging).toBe(true)
    state = paneRuntimeReducer(state, { type: 'loggingToggled', paneId: 'p1' })
    expect(state.p1.logging).toBe(false)
  })
})

describe('panelToggled / panelSet', () => {
  it('toggles only the named panel, leaving the other untouched', () => {
    let state = paneRuntimeReducer(EMPTY, { type: 'panelToggled', paneId: 'p1', panel: 'forwards' })
    expect(state.p1.forwardsOpen).toBe(true)
    expect(state.p1.filesOpen).toBe(false)
    state = paneRuntimeReducer(state, { type: 'panelToggled', paneId: 'p1', panel: 'files' })
    expect(state.p1.forwardsOpen).toBe(true)
    expect(state.p1.filesOpen).toBe(true)
  })

  it('panelSet is idempotent (no state change) when already at the target value', () => {
    const state = paneRuntimeReducer(EMPTY, { type: 'panelSet', paneId: 'p1', panel: 'forwards', open: false })
    expect(state).toBe(EMPTY)
  })

  it('panelSet forces the given value regardless of the current one', () => {
    let state = paneRuntimeReducer(EMPTY, { type: 'panelToggled', paneId: 'p1', panel: 'forwards' })
    state = paneRuntimeReducer(state, { type: 'panelSet', paneId: 'p1', panel: 'forwards', open: false })
    expect(state.p1.forwardsOpen).toBe(false)
  })
})

describe('activityChanged', () => {
  const running: CommandActivity = { state: 'running', startedAt: 1, command: 'ls' }

  it('records a running activity', () => {
    const state = paneRuntimeReducer(EMPTY, { type: 'activityChanged', paneId: 'p1', activity: running })
    expect(state.p1.activity).toEqual(running)
  })

  it('is a no-op when going idle on a pane with no existing record', () => {
    const state = paneRuntimeReducer(EMPTY, { type: 'activityChanged', paneId: 'p1', activity: IDLE })
    expect(state).toBe(EMPTY)
  })

  it('is a no-op when going idle on a pane whose activity is already idle', () => {
    let state = paneRuntimeReducer(EMPTY, { type: 'sessionIdSet', paneId: 'p1', sessionId: 's' })
    const beforeIdle = state
    state = paneRuntimeReducer(state, { type: 'activityChanged', paneId: 'p1', activity: IDLE })
    expect(state).toBe(beforeIdle)
  })

  it('records the transition from running back to idle when it was actually running', () => {
    let state = paneRuntimeReducer(EMPTY, { type: 'activityChanged', paneId: 'p1', activity: running })
    state = paneRuntimeReducer(state, { type: 'activityChanged', paneId: 'p1', activity: IDLE })
    expect(state.p1.activity).toEqual(IDLE)
  })
})

describe('attentionRaised / attentionCleared', () => {
  it('raises attention on a pane with no prior record', () => {
    const state = paneRuntimeReducer(EMPTY, { type: 'attentionRaised', paneId: 'p1' })
    expect(state.p1.attention).toBe(true)
  })

  it('clearing is a no-op (same reference) when attention was never raised', () => {
    const state = paneRuntimeReducer(EMPTY, { type: 'attentionCleared', paneId: 'p1' })
    expect(state).toBe(EMPTY)
  })

  it('clears a raised attention flag without disturbing the rest of the record', () => {
    let state = paneRuntimeReducer(EMPTY, { type: 'sessionIdSet', paneId: 'p1', sessionId: 's' })
    state = paneRuntimeReducer(state, { type: 'attentionRaised', paneId: 'p1' })
    state = paneRuntimeReducer(state, { type: 'attentionCleared', paneId: 'p1' })
    expect(state.p1.attention).toBe(false)
    expect(state.p1.sessionId).toBe('s')
  })
})

describe('derived views', () => {
  const state = paneRuntimeReducer(
    paneRuntimeReducer(
      paneRuntimeReducer(EMPTY, { type: 'statusChanged', paneId: 'p1', status: 'connected', now: 42 }),
      { type: 'sessionIdSet', paneId: 'p1', sessionId: 'sid' },
    ),
    { type: 'attentionRaised', paneId: 'p1' },
  )

  it('statusByPaneOf mirrors the status field for every pane', () => {
    expect(statusByPaneOf(state)).toEqual({ p1: 'connected' })
  })

  it('connectedAtByPaneOf omits panes with a null connectedAt', () => {
    const withDisconnected = paneRuntimeReducer(state, {
      type: 'statusChanged',
      paneId: 'p2',
      status: 'connecting',
      now: 1,
    })
    expect(connectedAtByPaneOf(withDisconnected)).toEqual({ p1: 42 })
  })

  it('loggingByPaneOf / forwardsOpenByPaneOf / filesOpenByPaneOf default every known pane to false', () => {
    expect(loggingByPaneOf(state)).toEqual({ p1: false })
    expect(forwardsOpenByPaneOf(state)).toEqual({ p1: false })
    expect(filesOpenByPaneOf(state)).toEqual({ p1: false })
  })

  it('sessionIdByPaneOf mirrors the session id', () => {
    expect(sessionIdByPaneOf(state)).toEqual({ p1: 'sid' })
  })

  it('activityByPaneOf mirrors the activity, defaulting to IDLE', () => {
    expect(activityByPaneOf(state)).toEqual({ p1: IDLE })
  })

  it('attentionPanesOf includes only panes with attention raised', () => {
    expect(attentionPanesOf(state)).toEqual({ p1: true })
  })
})
