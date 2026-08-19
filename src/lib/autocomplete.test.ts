import { describe, it, expect, vi } from 'vitest'
import {
  AutocompleteController,
  placeSuggestions,
  suggestionKeyAction,
  type SuggestionView,
} from './autocomplete'
import type { PromptInput, PromptInputTracker } from './promptInput'

function key(k: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey', boolean>> = {}) {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods }
}

describe('suggestionKeyAction', () => {
  const open = { open: true, atLineEnd: true }

  it('claims nothing at all while no suggestion is showing', () => {
    // The whole safety property of taking Tab and the arrows: with nothing on
    // screen they belong entirely to the far end, so remote tab-completion and
    // shell history recall behave exactly as they always did.
    const closed = { open: false, atLineEnd: true }
    for (const k of ['Tab', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Escape']) {
      expect(suggestionKeyAction(key(k), closed)).toBe('ignore')
    }
  })

  it('takes Tab, Right and Escape while one is showing', () => {
    expect(suggestionKeyAction(key('Tab'), open)).toBe('accept')
    expect(suggestionKeyAction(key('ArrowRight'), open)).toBe('accept')
    expect(suggestionKeyAction(key('Escape'), open)).toBe('dismiss')
  })

  /**
   * The most common thing anyone does at a shell prompt is walk their own
   * history, and a completion list has no business interrupting it. Plain
   * Up/Down therefore always reach the far end, list open or not.
   */
  it('never claims a bare Up or Down, even with a list showing', () => {
    expect(suggestionKeyAction(key('ArrowUp'), open)).toBe('ignore')
    expect(suggestionKeyAction(key('ArrowDown'), open)).toBe('ignore')
  })

  it('navigates the list with Ctrl+Up and Ctrl+Down instead', () => {
    expect(suggestionKeyAction(key('ArrowDown', { ctrlKey: true }), open)).toBe('next')
    expect(suggestionKeyAction(key('ArrowUp', { ctrlKey: true }), open)).toBe('previous')
    // ...and only while a list is showing; otherwise they are the remote's.
    const closed = { open: false, atLineEnd: true }
    expect(suggestionKeyAction(key('ArrowDown', { ctrlKey: true }), closed)).toBe('ignore')
  })

  it('leaves Right alone when it is a real cursor move', () => {
    // Mid-line, Right means "move right". Only at the end of the line, where
    // it would otherwise do nothing, does it accept.
    expect(suggestionKeyAction(key('ArrowRight'), { open: true, atLineEnd: false })).toBe('ignore')
  })

  it('ignores every modified form of the accept keys', () => {
    for (const mod of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey'] as const) {
      expect(suggestionKeyAction(key('Tab', { [mod]: true }), open)).toBe('ignore')
      expect(suggestionKeyAction(key('ArrowRight', { [mod]: true }), open)).toBe('ignore')
    }
    // Alt and Shift do not navigate either — only Ctrl does.
    expect(suggestionKeyAction(key('ArrowUp', { altKey: true }), open)).toBe('ignore')
    expect(suggestionKeyAction(key('ArrowUp', { shiftKey: true }), open)).toBe('ignore')
  })

  it('ignores ordinary typing', () => {
    for (const k of ['a', 'Enter', 'Backspace', 'Home', 'F5']) {
      expect(suggestionKeyAction(key(k), open)).toBe('ignore')
    }
  })
})

/** A tracker stub whose read is set by the test. */
function fakeTracker(input: PromptInput | null) {
  const state = { input }
  const tracker = { read: () => state.input } as unknown as PromptInputTracker
  return { tracker, state }
}

/** Printable input, which is what arms the controller to open a list. */
const TYPING = new TextEncoder().encode('x')
/** An escape sequence, i.e. an arrow key — what disarms it. */
const ARROW_UP = Uint8Array.from([0x1b, 0x5b, 0x41])

function promptInput(text: string, atEnd = true): PromptInput {
  return {
    text,
    atEnd,
    origin: { row: 3, col: 12 },
    cursor: { row: 3, col: 12 + text.length },
  }
}

function makeController(
  input: PromptInput | null,
  items: string[],
  overrides: { enabled?: boolean } = {},
) {
  const { tracker, state } = fakeTracker(input)
  const views: (SuggestionView | null)[] = []
  const sent: string[] = []
  const accepted: string[] = []
  const controller = new AutocompleteController({
    tracker,
    suggest: async () => items,
    send: (text) => sent.push(text),
    noteAccepted: (command) => accepted.push(command),
    enabled: () => overrides.enabled ?? true,
    onChange: (view) => views.push(view),
  })
  // A list only opens in response to typing, so every test that expects one
  // has to have typed. See `noteInput`.
  controller.noteInput(TYPING)
  return { controller, state, views, sent, accepted }
}

describe('AutocompleteController', () => {
  it('offers what the store returns for what is typed', async () => {
    const { controller } = makeController(promptInput('git s'), ['git status', 'git stash'])
    controller.refresh()
    await vi.waitFor(() => expect(controller.current).not.toBeNull())
    expect(controller.current?.items).toEqual(['git status', 'git stash'])
    expect(controller.current?.index).toBe(0)
  })

  it('offers nothing mid-line, where accepting would splice', async () => {
    // The cursor is inside the line, so appending a completion would put text
    // in the middle of the command.
    const { controller } = makeController(promptInput('git s', false), ['git status'])
    controller.refresh()
    await new Promise((r) => setTimeout(r, 0))
    expect(controller.current).toBeNull()
  })

  it('offers nothing at an empty prompt', async () => {
    const { controller } = makeController(promptInput(''), ['git status'])
    controller.refresh()
    await new Promise((r) => setTimeout(r, 0))
    expect(controller.current).toBeNull()
  })

  it('offers nothing when the feature is off', async () => {
    const { controller } = makeController(promptInput('git s'), ['git status'], { enabled: false })
    controller.refresh()
    await new Promise((r) => setTimeout(r, 0))
    expect(controller.current).toBeNull()
  })

  it('sends only the missing suffix when a suggestion is taken', async () => {
    const { controller, sent, accepted } = makeController(promptInput('git s'), ['git status'])
    controller.refresh()
    await vi.waitFor(() => expect(controller.current).not.toBeNull())
    controller.accept()
    // Never the whole command: what the user typed stays on the line, and
    // there is no path here that deletes it and retypes it.
    expect(sent).toEqual(['tatus'])
    expect(accepted).toEqual(['git status'])
    expect(controller.current).toBeNull()
  })

  /**
   * The property that makes a wrong origin harmless. Between the list being
   * drawn and Tab being pressed, output can arrive and redraw the line — so
   * acceptance re-reads rather than trusting what it offered a moment ago.
   */
  it('sends nothing when the line moved under the suggestion', async () => {
    const { controller, state, sent } = makeController(promptInput('git s'), ['git status'])
    controller.refresh()
    await vi.waitFor(() => expect(controller.current).not.toBeNull())

    // The far end redrew the line as something else entirely.
    state.input = promptInput('sudo reboot')
    controller.accept()
    expect(sent).toEqual([])
    expect(controller.current).toBeNull()
  })

  it('sends nothing when the line vanished entirely', async () => {
    const { controller, state, sent } = makeController(promptInput('git s'), ['git status'])
    controller.refresh()
    await vi.waitFor(() => expect(controller.current).not.toBeNull())
    state.input = null
    controller.accept()
    expect(sent).toEqual([])
  })

  it('moves through the list and wraps', async () => {
    const { controller } = makeController(promptInput('g'), ['a', 'b', 'c'])
    controller.refresh()
    await vi.waitFor(() => expect(controller.current).not.toBeNull())
    controller.move(1)
    expect(controller.current?.index).toBe(1)
    controller.move(-1)
    expect(controller.current?.index).toBe(0)
    // Backwards off the front lands on the last, rather than doing nothing —
    // a key that silently does nothing reads as broken.
    controller.move(-1)
    expect(controller.current?.index).toBe(2)
    controller.move(1)
    expect(controller.current?.index).toBe(0)
  })

  it('consumes the keys it claims and passes the rest through', async () => {
    const { controller, sent } = makeController(promptInput('git s'), ['git status'])
    controller.refresh()
    await vi.waitFor(() => expect(controller.current).not.toBeNull())

    expect(controller.handleKey(key('a'))).toBe(false)
    // Bare Down goes to the shell; Ctrl+Down is the one this owns.
    expect(controller.handleKey(key('ArrowDown'))).toBe(false)
    expect(controller.handleKey(key('ArrowDown', { ctrlKey: true }))).toBe(true)
    expect(controller.handleKey(key('Escape'))).toBe(true)
    expect(controller.current).toBeNull()
    // Dismissed: Tab now belongs to the far end again.
    expect(controller.handleKey(key('Tab'))).toBe(false)
    expect(sent).toEqual([])
  })

  describe("walking the shell's own history", () => {
    /**
     * The reported bug, in sequence. Up recalls a command, which rewrites the
     * whole line — indistinguishable from a burst of typing when read off the
     * grid. That used to open a list, and the list then ate the *next* Up, so
     * history recall stopped working after one press.
     */
    it('does not open a list when the far end redraws the line', async () => {
      const { controller, state } = makeController(promptInput(''), ['git status'])
      // Up went to the shell, and the shell put a whole command on the line.
      controller.noteInput(ARROW_UP)
      state.input = promptInput('git status --short')
      controller.refresh()
      await new Promise((r) => setTimeout(r, 0))
      expect(controller.current).toBeNull()
    })

    it('closes a list already showing when an arrow is pressed', async () => {
      const { controller, state } = makeController(promptInput('git s'), ['git status'])
      controller.refresh()
      await vi.waitFor(() => expect(controller.current).not.toBeNull())

      // The user gave up typing and reached for history instead.
      controller.noteInput(ARROW_UP)
      expect(controller.current).toBeNull()

      // ...and the recalled line does not bring it back.
      state.input = promptInput('git stash pop')
      controller.refresh()
      await new Promise((r) => setTimeout(r, 0))
      expect(controller.current).toBeNull()
    })

    it('offers again as soon as the user resumes typing', async () => {
      const { controller, state } = makeController(promptInput('git s'), ['git status'])
      controller.noteInput(ARROW_UP)
      state.input = promptInput('git stash pop')
      controller.refresh()
      await new Promise((r) => setTimeout(r, 0))
      expect(controller.current).toBeNull()

      // A printable keystroke arms it again — the point is that the offer
      // follows intent, not the mere contents of the line.
      controller.noteInput(TYPING)
      state.input = promptInput('git s')
      controller.refresh()
      await vi.waitFor(() => expect(controller.current).not.toBeNull())
    })
  })

  it('drops a reply that arrives after the line has moved on', async () => {
    const { tracker, state } = fakeTracker(promptInput('git s'))
    const views: (SuggestionView | null)[] = []
    let release: (items: string[]) => void = () => {}
    const controller = new AutocompleteController({
      tracker,
      suggest: () => new Promise<string[]>((resolve) => (release = resolve)),
      send: () => {},
      noteAccepted: () => {},
      enabled: () => true,
      onChange: (v) => views.push(v),
    })
    controller.noteInput(TYPING)
    controller.refresh()
    // The user kept typing while the store was being asked.
    state.input = promptInput('git stash pop')
    controller.reset()
    release(['git status'])
    await new Promise((r) => setTimeout(r, 0))
    expect(controller.current).toBeNull()
  })

  it('goes quiet rather than erroring when the store is unreachable', async () => {
    const { tracker } = fakeTracker(promptInput('git s'))
    const controller = new AutocompleteController({
      tracker,
      suggest: async () => {
        throw new Error('no backend')
      },
      send: () => {},
      noteAccepted: () => {},
      enabled: () => true,
      onChange: () => {},
    })
    controller.noteInput(TYPING)
    controller.refresh()
    await new Promise((r) => setTimeout(r, 0))
    expect(controller.current).toBeNull()
  })

  it('does not re-ask the store for a line it has already asked about', async () => {
    const { tracker } = fakeTracker(promptInput('git s'))
    const asked: string[] = []
    const controller = new AutocompleteController({
      tracker,
      suggest: async (typed) => {
        asked.push(typed)
        return ['git status']
      },
      send: () => {},
      noteAccepted: () => {},
      enabled: () => true,
      onChange: () => {},
    })
    controller.noteInput(TYPING)
    // Called on every parsed write as well as every keystroke, so an idle
    // prompt must not turn into a stream of queries.
    controller.refresh()
    controller.refresh()
    controller.refresh()
    await new Promise((r) => setTimeout(r, 0))
    expect(asked).toEqual(['git s'])
  })
})

describe('placeSuggestions', () => {
  // A 24-row pane with 17px cells, viewport at the very top.
  const pane = { viewportY: 0, rows: 24, cellHeight: 17 }

  it('hangs below the line when there is room under it', () => {
    const place = placeSuggestions({ ...pane, cursorRow: 3 })
    expect(place).toEqual({ below: true, top: 4 * 17, maxHeight: 20 * 17 })
  })

  /**
   * The reported bug. With the prompt near the bottom, the list has to go
   * above — and it has to go above by *its own* height, not by a count of
   * terminal rows. A row of the list is a cell of text plus padding plus a
   * border, so reserving `items.length` cells left it overlapping the line
   * being typed.
   */
  it('sits above the line when the prompt is near the bottom', () => {
    const place = placeSuggestions({ ...pane, cursorRow: 22 })
    expect(place?.below).toBe(false)
    // Anchored to the cursor's own row; CSS then shifts it up by its own
    // height, so its bottom edge lands on the top edge of that row whatever
    // height it turns out to have.
    expect(place?.top).toBe(22 * 17)
    expect(place?.maxHeight).toBe(22 * 17)
  })

  it('flips at the halfway point, taking whichever side has more room', () => {
    expect(placeSuggestions({ ...pane, cursorRow: 11 })?.below).toBe(true)
    expect(placeSuggestions({ ...pane, cursorRow: 12 })?.below).toBe(false)
  })

  it('handles the very first and very last row', () => {
    // Nothing above row 0, so it can only go below...
    expect(placeSuggestions({ ...pane, cursorRow: 0 })?.below).toBe(true)
    // ...and nothing below the last row, so it can only go above.
    const last = placeSuggestions({ ...pane, cursorRow: 23 })
    expect(last?.below).toBe(false)
    expect(last?.maxHeight).toBe(23 * 17)
  })

  it('never reports a zero height, however cramped the pane', () => {
    const tiny = placeSuggestions({ viewportY: 0, rows: 1, cursorRow: 0, cellHeight: 17 })
    expect(tiny?.maxHeight).toBe(17)
  })

  it('accounts for scrollback, and gives up when the line is off screen', () => {
    // Viewport scrolled down: absolute row 105 is screen row 5.
    expect(placeSuggestions({ viewportY: 100, rows: 24, cursorRow: 105, cellHeight: 17 })).toEqual({
      below: true,
      top: 6 * 17,
      maxHeight: 18 * 17,
    })
    // Scrolled back through history with a list open: the line is above the
    // viewport, so there is nothing to anchor to.
    expect(placeSuggestions({ viewportY: 100, rows: 24, cursorRow: 40, cellHeight: 17 })).toBeNull()
    expect(placeSuggestions({ viewportY: 100, rows: 24, cursorRow: 900, cellHeight: 17 })).toBeNull()
  })
})
