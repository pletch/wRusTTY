import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CommandTracker, formatCommandDuration, IDLE } from './shellIntegration'
import type { CommandActivity, CommandResult } from './shellIntegration'

describe('formatCommandDuration', () => {
  it('formats sub-minute durations as seconds', () => {
    expect(formatCommandDuration(0)).toBe('0s')
    expect(formatCommandDuration(59_000)).toBe('59s')
  })

  it('formats the minute boundary', () => {
    expect(formatCommandDuration(60_000)).toBe('1m 0s')
    expect(formatCommandDuration(3_599_000)).toBe('59m 59s')
  })

  it('formats the hour boundary, dropping seconds', () => {
    expect(formatCommandDuration(3_600_000)).toBe('1h 0m')
    expect(formatCommandDuration(3_661_000)).toBe('1h 1m')
  })
})

describe('CommandTracker', () => {
  let onChange: ReturnType<typeof vi.fn<(a: CommandActivity) => void>>
  let onComplete: ReturnType<typeof vi.fn<(r: CommandResult) => void>>
  let tracker: CommandTracker

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    onChange = vi.fn()
    onComplete = vi.fn()
    tracker = new CommandTracker({ onChange, onComplete })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not show running until past the visibility delay', () => {
    tracker.handleOsc('C')
    expect(onChange).not.toHaveBeenCalled()
    vi.advanceTimersByTime(399)
    expect(onChange).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onChange).toHaveBeenCalledWith({ state: 'running', startedAt: 0, command: null })
  })

  it('runs the full A/B/C/D cycle and reports duration + exit code on completion', () => {
    tracker.handleOsc('A')
    tracker.handleOsc('B')
    tracker.handleOsc('C')
    vi.advanceTimersByTime(400) // past the visibility delay, so running is reported
    vi.setSystemTime(2500)
    tracker.handleOsc('D;7')
    expect(onComplete).toHaveBeenCalledWith({
      command: null,
      exitCode: 7,
      durationMs: 2500,
      interactive: false,
    })
    // idle emitted to undo the running state that was shown
    expect(onChange).toHaveBeenLastCalledWith(IDLE)
  })

  it('emits no idle transition on completion when running was never shown', () => {
    tracker.handleOsc('C')
    vi.setSystemTime(100)
    tracker.handleOsc('D;0') // finishes well under the visibility delay
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ durationMs: 100 }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('treats a bare D with no code as an unknown exit status', () => {
    tracker.handleOsc('C')
    tracker.handleOsc('D')
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ exitCode: null }),
    )
  })

  it('ignores D with no run in flight', () => {
    tracker.handleOsc('D;0')
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('treats a new prompt (A) while running as an implicit, status-unknown finish', () => {
    tracker.handleOsc('C')
    vi.setSystemTime(1000)
    tracker.handleOsc('A')
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ exitCode: null, durationMs: 1000 }))
  })

  it('ignores a repeated C while already running, so duration is measured from the first', () => {
    tracker.handleOsc('C')
    vi.setSystemTime(1000)
    tracker.handleOsc('C') // pipeline segment; must not restart the clock
    vi.setSystemTime(3000)
    tracker.handleOsc('D;0')
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ durationMs: 3000 }))
  })

  it('attaches a pendingCommand reported by E (OSC 633) before the C that starts it', () => {
    tracker.handleOsc('E;ls -la;nonce123')
    tracker.handleOsc('C')
    vi.advanceTimersByTime(400)
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'ls -la' }),
    )
  })

  it('drops a stale pendingCommand on the next prompt (B)', () => {
    tracker.handleOsc('E;ls -la;nonce')
    tracker.handleOsc('B')
    tracker.handleOsc('C')
    vi.advanceTimersByTime(400)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ command: null }))
  })

  it('suppresses the running indicator while the alternate screen is up, and marks the result interactive', () => {
    tracker.handleOsc('C')
    tracker.setAltScreen(true)
    vi.advanceTimersByTime(1000)
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'running' }))
    tracker.setAltScreen(false)
    vi.advanceTimersByTime(400)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ state: 'running' }))
    tracker.handleOsc('D;0')
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ interactive: true }))
  })

  it('hands the indicator to a program that reports its own progress, for the rest of the run', () => {
    // The inline case: Claude Code on a host where it never switches screen
    // buffers, so the alternate-screen suppression above never fires and the
    // shell's run would otherwise sweep for the whole session.
    tracker.handleOsc('C')
    vi.advanceTimersByTime(400)
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'running' }))
    tracker.noteProgress()
    expect(onChange).toHaveBeenLastCalledWith(IDLE)
    // Between turns the program clears its progress and the pane goes quiet.
    // The run is still open, and must not reclaim the indicator — that is the
    // "it never stops" this exists to fix.
    vi.advanceTimersByTime(10_000)
    expect(onChange).toHaveBeenLastCalledWith(IDLE)
  })

  it('still completes a run the program took over, with its exit code and duration', () => {
    tracker.handleOsc('C')
    tracker.noteProgress()
    vi.setSystemTime(5000)
    tracker.handleOsc('D;3')
    expect(onComplete).toHaveBeenCalledWith({
      command: null,
      exitCode: 3,
      durationMs: 5000,
      interactive: false,
    })
  })

  it('gives the indicator back to the shell on the next run', () => {
    tracker.handleOsc('C')
    tracker.noteProgress()
    tracker.handleOsc('D;0')
    // A different command, which reports nothing of its own.
    tracker.handleOsc('C')
    vi.advanceTimersByTime(400)
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'running' }))
  })

  it('changes nothing when the program reporting progress is on the alternate screen', () => {
    // The Linux case: the buffer switch has already stood the indicator down,
    // and progress arriving from inside the full-screen program leaves it
    // down — the same before and after the takeover exists.
    tracker.handleOsc('C')
    tracker.setAltScreen(true)
    tracker.noteProgress()
    vi.advanceTimersByTime(10_000)
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'running' }))
    tracker.setAltScreen(false)
    tracker.handleOsc('D;0')
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ interactive: true }))
  })

  it('reset drops an in-flight run without completing it, and emits idle if it was showing', () => {
    tracker.handleOsc('C')
    vi.advanceTimersByTime(400) // now showing as running
    tracker.reset()
    expect(onComplete).not.toHaveBeenCalled()
    expect(onChange).toHaveBeenLastCalledWith(IDLE)
    // a D arriving after reset has nothing in flight
    tracker.handleOsc('D;0')
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('reset is a no-op when nothing is running', () => {
    tracker.reset()
    expect(onChange).not.toHaveBeenCalled()
  })
})
