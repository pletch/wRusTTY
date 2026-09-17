import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  HistoryRepeatWatcher,
  isHistoryKey,
  MAX_DEADLINE_MS,
  MAX_WAIT_MS,
  MIN_DEADLINE_MS,
  SETTLE_MS,
  type HistoryRepeat,
} from './historyRepeat'
import type { PromptInput } from './promptInput'

/**
 * Written as sequences of presses and replies rather than as unit calls: what
 * matters is which presses produce a pulse and which stay quiet, and that only
 * shows up over a run.
 *
 * The load-bearing case is the one with no reply at all. Measured against a
 * live host, recalling a duplicate often puts nothing on the wire — readline
 * writes only the difference between the old line and the new one, and there
 * isn't one — so a version of this that waited for a write could not see the
 * very thing it exists for.
 */

const esc = (text: string) => new TextEncoder().encode(text)

/** A readable prompt line holding `text`, with geometry good enough to place
 * a band. Column arithmetic is the overlay's business, not this module's. */
const line = (text: string): PromptInput => ({
  text,
  origin: { row: 10, col: 12 },
  cursor: { row: 10, col: 12 + text.length },
  atEnd: true,
})

describe('isHistoryKey', () => {
  it('accepts a bare Up and Down in both cursor modes', () => {
    // Legacy, and what readline sees most of the time.
    expect(isHistoryKey(esc('\x1b[A'))).toBe(true)
    expect(isHistoryKey(esc('\x1b[B'))).toBe(true)
    // Application cursor mode (DECCKM), which readline itself turns on.
    expect(isHistoryKey(esc('\x1bOA'))).toBe(true)
    expect(isHistoryKey(esc('\x1bOB'))).toBe(true)
  })

  it('accepts the Kitty protocol spellings of an unmodified arrow', () => {
    expect(isHistoryKey(esc('\x1b[1A'))).toBe(true)
    expect(isHistoryKey(esc('\x1b[1;1A'))).toBe(true)
    // Event type 1 is a press, 2 a repeat — both are someone holding the key.
    expect(isHistoryKey(esc('\x1b[1;1:1A'))).toBe(true)
    expect(isHistoryKey(esc('\x1b[1;1:2A'))).toBe(true)
  })

  it('rejects a release event, which would double-count one press', () => {
    expect(isHistoryKey(esc('\x1b[1;1:3A'))).toBe(false)
  })

  it('rejects modified arrows, which walk no history', () => {
    // Ctrl+Up: moves between panes in tmux.
    expect(isHistoryKey(esc('\x1b[1;5A'))).toBe(false)
    // Shift+Up: a selection gesture in plenty of TUIs.
    expect(isHistoryKey(esc('\x1b[1;2A'))).toBe(false)
    // Alt+Down.
    expect(isHistoryKey(esc('\x1b[1;3B'))).toBe(false)
  })

  it('rejects everything that is not an arrow', () => {
    expect(isHistoryKey(esc('\x1b[C'))).toBe(false)
    expect(isHistoryKey(esc('\x1b[D'))).toBe(false)
    expect(isHistoryKey(esc('ls -la'))).toBe(false)
    expect(isHistoryKey(esc('\r'))).toBe(false)
    expect(isHistoryKey(new Uint8Array())).toBe(false)
    // A paste that happens to contain one is still a paste, not a keypress.
    expect(isHistoryKey(esc('echo \x1b[A done'))).toBe(false)
  })
})

describe('HistoryRepeatWatcher', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const watch = () => {
    const found: HistoryRepeat[] = []
    let current: PromptInput | null = line('')
    const watcher = new HistoryRepeatWatcher({
      read: () => current,
      emit: (repeat) => found.push(repeat),
    })
    /** The far end redraws the line as `text`, then goes quiet. */
    const reply = (text: string | null) => {
      current = text === null ? null : line(text)
      watcher.noteParsed()
      vi.advanceTimersByTime(SETTLE_MS)
    }
    /** The far end says nothing whatever, which is what a recalled duplicate
     * usually costs on the wire. */
    const noReply = () => vi.advanceTimersByTime(MAX_DEADLINE_MS)
    const press = () => watcher.noteInput(esc('\x1b[A'))
    return {
      found,
      watcher,
      press,
      reply,
      noReply,
      showing: (text: string) => (current = line(text)),
      /** The line becomes unreadable: alt screen, a running command, no
       * origin yet. */
      hide: () => (current = null),
    }
  }

  it('says nothing when the recalled command is a different one', () => {
    const { found, press, reply } = watch()
    press()
    reply('git status')
    press()
    reply('cargo test')
    // The screen changed twice, which is its own feedback. Reporting here
    // would put a mark under every history key anyone ever pressed.
    expect(found).toEqual([])
  })

  it('found when the far end redraws the command already showing', () => {
    const { found, press, reply } = watch()
    press()
    reply('cargo fmt --all')
    press()
    reply('cargo fmt --all')
    expect(found).toHaveLength(1)
    expect(found[0].run).toBe(1)
  })

  it('found when the far end sends nothing at all', () => {
    const { found, press, reply, noReply } = watch()
    press()
    reply('cargo fmt --all')
    // The case the reply-driven version could not see: readline had no
    // difference to write, so not one byte came back. From where the user sits
    // that is the same event as a redraw of the same text, and it has to
    // produce the same answer.
    press()
    noReply()
    expect(found).toHaveLength(1)
    expect(found[0].run).toBe(1)
  })

  it('counts a run of duplicates, so a long stretch can read as one', () => {
    const { found, press, reply, noReply } = watch()
    press()
    reply('cargo fmt --all')
    for (let i = 0; i < 3; i++) {
      press()
      noReply()
    }
    expect(found.map((p) => p.run)).toEqual([1, 2, 3])
    // Each one has to be distinguishable from the last, or the renderer
    // reconciles them away and the fourth press shows nothing.
    expect(new Set(found.map((p) => p.seq)).size).toBe(3)
  })

  it('ends the run the moment the history moves on', () => {
    const { found, press, reply, noReply } = watch()
    press()
    reply('cargo fmt --all')
    press()
    noReply()
    press()
    reply('cargo test')
    press()
    noReply()
    // Not 3: the stretch of `fmt` ended, and the `test` one has just begun.
    expect(found.map((p) => p.run)).toEqual([1, 1])
  })

  it('ends the run when something is typed', () => {
    const { found, watcher, press, reply, noReply, showing } = watch()
    press()
    reply('cargo fmt --all')
    press()
    noReply()
    expect(found.map((p) => p.run)).toEqual([1])

    // Editing the recalled line: no longer walking history.
    watcher.noteInput(esc(' --check'))
    showing('cargo fmt --all --check')
    press()
    noReply()
    expect(found.map((p) => p.run)).toEqual([1, 1])
  })

  it('behaves the same walking back down through the repeats', () => {
    const { found, watcher, reply, noReply } = watch()
    const down = () => watcher.noteInput(esc('\x1b[B'))
    // Coming back down out of a stretch of duplicates is the same shape as
    // going up into it, and neither the key test nor the comparison cares
    // which direction was pressed.
    down()
    reply('cargo fmt --all')
    down()
    noReply()
    down()
    noReply()
    expect(found.map((p) => p.run)).toEqual([1, 2])
  })

  it('found at the bottom of the history, where the line goes empty', () => {
    const { found, watcher, reply, noReply } = watch()
    const down = () => watcher.noteInput(esc('\x1b[B'))
    down()
    reply('cargo test')
    // Past the newest entry readline clears the line, and every further Down
    // leaves it cleared — silently. Only Down reaches this, and it is the
    // press most in need of an answer: nothing on screen moves at all.
    down()
    reply('')
    down()
    noReply()
    expect(found.map((p) => p.run)).toEqual([1])
    // Zero columns of input, which is the overlay's MIN_PULSE_COLS case.
    expect(found[0].origin).toEqual(found[0].cursor)
  })

  it('keeps up with a fast hand, without waiting for any deadline', () => {
    const { found, press, reply } = watch()
    press()
    reply('journalctl -u rustguac --no-pager | grep sync_hold')
    // Someone hunting through history holds the key down. Each press resolves
    // the one before it — their own keystroke is the evidence that time has
    // passed — so nothing here waits on a timer at all. Before this, a burst
    // produced no feedback whatever until the hand stopped moving.
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(12)
      press()
    }
    // Three, not four: each press answers the one before it, so the last of a
    // burst has nothing after it to resolve it. That is the intended shape —
    // the alternative is holding the first press back until its own timer,
    // which is the lag this replaced. The straggler lands on the deadline.
    expect(found.map((f) => f.run)).toEqual([1, 2, 3])
    vi.advanceTimersByTime(MAX_DEADLINE_MS)
    expect(found.map((f) => f.run)).toEqual([1, 2, 3, 4])
  })

  it('takes its deadline from how fast this session actually answers', () => {
    const { watcher, press, reply } = watch()
    // Nothing measured yet: assume the worst, because assuming the best would
    // read a slow link's first press as a repeat that never happened.
    expect(watcher.deadlineMs).toBe(MAX_DEADLINE_MS)

    press()
    vi.advanceTimersByTime(4)
    reply('cargo test')
    // A host down the hall. The floor is what stops the comparison racing the
    // far end's own redraw.
    expect(watcher.deadlineMs).toBe(MIN_DEADLINE_MS)
  })

  it('backs off for a link that is genuinely slow', () => {
    const { watcher, press, reply } = watch()
    press()
    vi.advanceTimersByTime(180)
    reply('cargo test')
    expect(watcher.deadlineMs).toBeGreaterThan(MIN_DEADLINE_MS)
    // Clamped: past here the wait costs more than the answer is worth.
    expect(watcher.deadlineMs).toBeLessThanOrEqual(MAX_DEADLINE_MS)
  })

  it('believes a slowdown at once and a speed-up only gradually', () => {
    const { watcher, press, reply } = watch()
    press()
    vi.advanceTimersByTime(120)
    reply('one')
    const slow = watcher.deadlineMs
    press()
    vi.advanceTimersByTime(2)
    reply('two')
    // One fast reply mid-stall must not drag the deadline straight back down,
    // or the next press during the same stall is misread as a repeat.
    expect(watcher.deadlineMs).toBeGreaterThan(MIN_DEADLINE_MS)
    expect(watcher.deadlineMs).toBeLessThan(slow)
  })

  it('waits for a redraw in progress to finish before comparing', () => {
    const { found, press, watcher } = watch()
    press()
    // The shape a recall that *does* redraw arrives in: erase, then text,
    // split across chunks. The first of them leaves the line empty — which is
    // the text the press started from, so comparing there would report a
    // repeat that is really a redraw in progress.
    watcher.noteParsed()
    vi.advanceTimersByTime(SETTLE_MS - 10)
    watcher.noteParsed()
    vi.advanceTimersByTime(SETTLE_MS - 10)
    expect(found).toEqual([])
  })

  it('gives up at the backstop rather than comparing mid-sentence', () => {
    const { found, press, watcher } = watch()
    press()
    // A pane printing something unrelated — a tail, a progress bar — would
    // otherwise restart the settle timer for ever, so the backstop has to end
    // the press. What it must not do is *answer* it: the far end was still
    // talking when it fired, so the line is mid-redraw and "unchanged" would
    // be a claim about a snapshot taken too early.
    for (let elapsed = 0; elapsed < MAX_WAIT_MS * 2; elapsed += SETTLE_MS - 10) {
      watcher.noteParsed()
      vi.advanceTimersByTime(SETTLE_MS - 10)
    }
    expect(found).toEqual([])
    // Ended, not merely postponed — nothing is left ticking against the pane.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('says nothing on a link too slow for the deadline to mean anything', () => {
    const { found, press, reply, watcher } = watch()
    // A link whose round trip is past what MAX_DEADLINE_MS can wait out. The
    // deadline is then a ceiling rather than evidence: it fires while the far
    // end is still on its way, and every press would flicker — including the
    // ones that walked the history perfectly well.
    press()
    vi.advanceTimersByTime(600)
    reply('cargo test')
    expect(watcher.deadlineMs).toBe(MAX_DEADLINE_MS)

    press()
    vi.advanceTimersByTime(MAX_WAIT_MS)
    expect(found).toEqual([])
  })

  it('says nothing on the first press of a session that has never answered', () => {
    const { found, press, noReply } = watch()
    // Nothing measured, so silence could be a duplicate or could be a link
    // slower than the ceiling. Guessing here is how a slow session greets you
    // with a flicker under a press that did move the history.
    press()
    noReply()
    vi.advanceTimersByTime(MAX_WAIT_MS)
    expect(found).toEqual([])
  })

  it('says nothing where the line cannot be read', () => {
    const { found, press, noReply, hide } = watch()
    // The alternate screen, a running command, a prompt with no origin: the
    // tracker returns null and there is nothing honest to compare or to draw
    // on top of. Notably this is also what a wedged session looks like — and
    // it produces no claim either way, which is the point.
    hide()
    press()
    noReply()
    vi.advanceTimersByTime(MAX_WAIT_MS)
    expect(found).toEqual([])
  })

  it('drops a press whose line stopped being readable before the redraw', () => {
    const { found, press, reply } = watch()
    press()
    // A program painted over the prompt between the keypress and the reply.
    reply(null)
    expect(found).toEqual([])
  })

  it('holds no timer after a reset', () => {
    const { found, watcher, press } = watch()
    press()
    // What a disposed pane does. A surviving timer here would fire against a
    // freed engine.
    watcher.reset()
    vi.advanceTimersByTime(MAX_WAIT_MS * 2)
    expect(vi.getTimerCount()).toBe(0)
    expect(found).toEqual([])
  })
})
