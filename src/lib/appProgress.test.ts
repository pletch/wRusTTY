import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseOsc9, parseOsc777, ProgressTracker } from './appProgress'
import type { AppProgress } from './appProgress'

describe('parseOsc9 — progress', () => {
  it('reads an indeterminate report, which is what a busy tool sends', () => {
    // Claude Code's own signal, and the case the whole feature exists for.
    expect(parseOsc9('4;3')).toEqual({
      kind: 'progress',
      progress: { state: 'active', percent: null },
    })
  })

  it('drops a percent sent alongside an indeterminate state', () => {
    // Meaningless by definition — showing it would invent precision the
    // sender explicitly disclaimed.
    expect(parseOsc9('4;3;40')).toEqual({
      kind: 'progress',
      progress: { state: 'active', percent: null },
    })
  })

  it('reads determinate, error and paused states with their percent', () => {
    expect(parseOsc9('4;1;40')).toEqual({
      kind: 'progress',
      progress: { state: 'active', percent: 40 },
    })
    expect(parseOsc9('4;2;70')).toEqual({
      kind: 'progress',
      progress: { state: 'error', percent: 70 },
    })
    expect(parseOsc9('4;4;10')).toEqual({
      kind: 'progress',
      progress: { state: 'paused', percent: 10 },
    })
  })

  it('clears on state 0', () => {
    expect(parseOsc9('4;0')).toEqual({ kind: 'progress', progress: null })
    expect(parseOsc9('4;0;0')).toEqual({ kind: 'progress', progress: null })
  })

  it('tolerates a missing or unparseable percent', () => {
    for (const payload of ['4;1', '4;1;', '4;1;abc']) {
      expect(parseOsc9(payload)).toEqual({
        kind: 'progress',
        progress: { state: 'active', percent: null },
      })
    }
  })

  it('clamps a percent to 0-100', () => {
    expect(parseOsc9('4;1;500')).toEqual({
      kind: 'progress',
      progress: { state: 'active', percent: 100 },
    })
    expect(parseOsc9('4;1;-5')).toEqual({
      kind: 'progress',
      progress: { state: 'active', percent: 0 },
    })
  })

  it('ignores an unknown or absent state rather than treating it as a clear', () => {
    // The distinction that matters: a malformed report must not be able to
    // stop an indicator that is legitimately running.
    expect(parseOsc9('4;7')).toEqual({ kind: 'ignore' })
    expect(parseOsc9('4')).toEqual({ kind: 'ignore' })
    expect(parseOsc9('4;')).toEqual({ kind: 'ignore' })
  })
})

describe('parseOsc9 — notifications', () => {
  it('takes a bare payload as iTerm2 notification text', () => {
    expect(parseOsc9('build finished')).toEqual({
      kind: 'notify',
      notification: { title: null, body: 'build finished' },
    })
  })

  it('ignores ConEmu cwd reports rather than announcing them', () => {
    expect(parseOsc9('9;/home/tim')).toEqual({ kind: 'ignore' })
  })

  it('ignores an empty payload', () => {
    expect(parseOsc9('')).toEqual({ kind: 'ignore' })
    expect(parseOsc9('   ')).toEqual({ kind: 'ignore' })
  })

  it('strips control characters out of remote text', () => {
    // This text reaches a native notification, where a newline is a
    // formatting primitive rather than a character.
    const esc = String.fromCharCode(0x1b)
    expect(parseOsc9(`done${esc}[31mred\nnext`)).toEqual({
      kind: 'notify',
      notification: { title: null, body: 'done [31mred next' },
    })
  })

  it('bounds a long body', () => {
    const result = parseOsc9('x'.repeat(5000))
    expect(result.kind).toBe('notify')
    if (result.kind !== 'notify') return
    expect(result.notification.body).toHaveLength(200)
    expect(result.notification.body.endsWith('…')).toBe(true)
  })
})

describe('ProgressTracker', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function tracker() {
    const changes: (AppProgress | null)[] = []
    const completions: number[] = []
    const t = new ProgressTracker({
      onChange: (p) => changes.push(p),
      onComplete: (ms) => completions.push(ms),
    })
    return { t, changes, completions }
  }

  const busy: AppProgress = { state: 'active', percent: null }

  it('reports a run ending, with how long it lasted', () => {
    const { t, changes, completions } = tracker()
    t.set(busy)
    vi.advanceTimersByTime(90_000)
    t.set(null)
    expect(changes).toEqual([busy, null])
    expect(completions).toEqual([90_000])
  })

  it('drops repeats of the same state', () => {
    // A busy program re-sends this for as long as it runs; each one reaching
    // the tab strip would re-render it to say nothing had changed.
    const { t, changes } = tracker()
    for (let i = 0; i < 50; i++) t.set({ state: 'active', percent: null })
    expect(changes).toEqual([busy])
  })

  it('times the whole run, not the last step', () => {
    const { t, completions } = tracker()
    t.set({ state: 'active', percent: 10 })
    vi.advanceTimersByTime(30_000)
    t.set({ state: 'active', percent: 90 })
    vi.advanceTimersByTime(1_000)
    t.set(null)
    expect(completions).toEqual([31_000])
  })

  it('treats a state change mid-run as the same run', () => {
    // An app that hits an error and then clears has still been working the
    // whole time — the clock must not restart at the error.
    const { t, completions } = tracker()
    t.set(busy)
    vi.advanceTimersByTime(20_000)
    t.set({ state: 'error', percent: null })
    vi.advanceTimersByTime(5_000)
    t.set(null)
    expect(completions).toEqual([25_000])
  })

  it('reports nothing for a clear that was never preceded by progress', () => {
    const { t, changes, completions } = tracker()
    t.set(null)
    expect(changes).toEqual([])
    expect(completions).toEqual([])
  })

  it('takes the indicator down on reset without claiming the work finished', () => {
    // A dropped connection knows nothing about whether the program finished,
    // so marking the pane as "something happened here" would be a lie — but
    // the indicator still has to come down.
    const { t, changes, completions } = tracker()
    t.set(busy)
    vi.advanceTimersByTime(60_000)
    t.reset()
    expect(changes).toEqual([busy, null])
    expect(completions).toEqual([])
  })

  it('resets silently when nothing was running', () => {
    const { t, changes } = tracker()
    t.reset()
    expect(changes).toEqual([])
  })

  it('starts a fresh clock after a reset', () => {
    // The stale `since` from the abandoned run would otherwise be counted
    // into the next one, which after a reconnect could be hours.
    const { t, completions } = tracker()
    t.set(busy)
    vi.advanceTimersByTime(60_000)
    t.reset()
    vi.advanceTimersByTime(3_600_000)
    t.set(busy)
    vi.advanceTimersByTime(2_000)
    t.set(null)
    expect(completions).toEqual([2_000])
  })
})

describe('parseOsc777', () => {
  it('reads title and body', () => {
    expect(parseOsc777('notify;Build;succeeded in 4s')).toEqual({
      title: 'Build',
      body: 'succeeded in 4s',
    })
  })

  it('keeps semicolons in the body, which the format cannot escape', () => {
    expect(parseOsc777('notify;Build;a; then b')).toEqual({ title: 'Build', body: 'a; then b' })
  })

  it('demotes a title-only notification to a body', () => {
    // It reads better under the pane's name than as a heading with nothing
    // beneath it, and one-liners are the common shape.
    expect(parseOsc777('notify;All done')).toEqual({ title: null, body: 'All done' })
  })

  it('rejects other subcommands and empty payloads, leaving them for anyone else', () => {
    expect(parseOsc777('other;thing')).toBeNull()
    expect(parseOsc777('notify')).toBeNull()
    expect(parseOsc777('notify;;')).toBeNull()
  })
})
