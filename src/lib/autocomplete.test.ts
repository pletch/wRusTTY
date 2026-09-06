import { describe, it, expect, vi } from 'vitest'
import {
  AutocompleteController,
  placeSuggestions,
  suggestionKeyAction,
  suggestionSuffix,
  firstWordOfSuffix,
  type SuggestionView,
} from './autocomplete'
import type { PromptInput, PromptInputTracker } from './promptInput'

function key(k: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey', boolean>> = {}) {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods }
}

describe('suggestionKeyAction', () => {
  /** A suggestion showing inline, which is the default view. */
  const open = { open: true, atLineEnd: true, mode: 'inline' } as const
  /** The same offer, opened out into the list with Ctrl+Space. */
  const list = { open: true, atLineEnd: true, mode: 'list' } as const

  it('claims nothing at all while no suggestion is showing', () => {
    // The whole safety property of taking the arrows: with nothing on screen
    // they belong entirely to the far end, so shell history recall behaves
    // exactly as it always did.
    const closed = { open: false, atLineEnd: true, mode: 'inline' } as const
    for (const k of ['Tab', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Escape']) {
      expect(suggestionKeyAction(key(k), closed)).toBe('ignore')
    }
  })

  it('takes Right and Escape while one is showing', () => {
    expect(suggestionKeyAction(key('ArrowRight'), open)).toBe('accept')
    expect(suggestionKeyAction(key('Escape'), open)).toBe('dismiss')
  })

  /**
   * Alt is the word-wise modifier wherever a line is edited, and fish binds
   * exactly this. Gated on the end of the line for the same reason plain Right
   * is: anywhere else Alt+Right is `forward-word`, which the user meant.
   */
  it('takes one word with Alt+Right, at the end of the line', () => {
    expect(suggestionKeyAction(key('ArrowRight', { altKey: true }), open)).toBe('accept-word')
    expect(suggestionKeyAction(key('ArrowRight', { altKey: true }), list)).toBe('accept-word')
    expect(
      suggestionKeyAction(key('ArrowRight', { altKey: true }), {
        open: true,
        atLineEnd: false,
        mode: 'inline',
      } as const),
    ).toBe('ignore')
    const closed = { open: false, atLineEnd: true, mode: 'inline' } as const
    expect(suggestionKeyAction(key('ArrowRight', { altKey: true }), closed)).toBe('ignore')
  })

  it('claims no other Alt key', () => {
    for (const k of ['ArrowLeft', 'ArrowUp', 'ArrowDown', 'Tab', 'f', 'Escape']) {
      expect(suggestionKeyAction(key(k, { altKey: true }), open)).toBe('ignore')
    }
  })

  /**
   * Tab is the remote's completion key and stays the remote's in every state.
   * Two completions cannot share one key: pressing it while a remembered
   * command happened to be showing took the remembered command instead of the
   * directory name being typed, which is never what Tab was pressed for.
   */
  it('never takes Tab, in any state', () => {
    expect(suggestionKeyAction(key('Tab'), open)).toBe('ignore')
    expect(suggestionKeyAction(key('Tab'), list)).toBe('ignore')
    expect(
      suggestionKeyAction(key('Tab'), { open: true, atLineEnd: false, mode: 'inline' } as const),
    ).toBe('ignore')
  })

  /**
   * The most common thing anyone does at a shell prompt is walk their own
   * history, and an offer that appeared on its own has no business
   * interrupting it. The inline view therefore leaves the arrows alone.
   */
  it('leaves the arrows to the shell while the suggestion is inline', () => {
    expect(suggestionKeyAction(key('ArrowUp'), open)).toBe('ignore')
    expect(suggestionKeyAction(key('ArrowDown'), open)).toBe('ignore')
  })

  /**
   * The list is the one state the user asked for by name, with Ctrl+Space.
   * Having summoned a list of candidates they want to move through it, and
   * Escape hands the keys straight back.
   */
  it('navigates with the bare arrows once the list has been summoned', () => {
    expect(suggestionKeyAction(key('ArrowDown'), list)).toBe('next')
    expect(suggestionKeyAction(key('ArrowUp'), list)).toBe('previous')
  })

  /**
   * The convention for a list that was opened on purpose: fish's completion
   * pager and zsh's `menu-select` both confirm the highlighted row on Enter
   * and leave running it to a second press.
   */
  it('accepts the highlighted row on Enter, but only in the list', () => {
    expect(suggestionKeyAction(key('Enter'), list)).toBe('accept')
    // Inline there is no highlighted row, and Enter is the one key at a prompt
    // that must never be swallowed: it runs the command.
    expect(suggestionKeyAction(key('Enter'), open)).toBe('ignore')
    const closed = { open: false, atLineEnd: true, mode: 'list' } as const
    expect(suggestionKeyAction(key('Enter'), closed)).toBe('ignore')
    for (const mod of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey'] as const) {
      expect(suggestionKeyAction(key('Enter', { [mod]: true }), list)).toBe('ignore')
    }
  })

  it('accepts Ctrl+arrows too, since Ctrl+Space is often still held', () => {
    expect(suggestionKeyAction(key('ArrowDown', { ctrlKey: true }), list)).toBe('next')
    expect(suggestionKeyAction(key('ArrowUp', { ctrlKey: true }), list)).toBe('previous')
    // Not in the inline view, where there is nothing to move through — the
    // keys stay the remote's until the user asks for the list.
    expect(suggestionKeyAction(key('ArrowDown', { ctrlKey: true }), open)).toBe('ignore')
    const closed = { open: false, atLineEnd: true, mode: 'list' } as const
    expect(suggestionKeyAction(key('ArrowDown', { ctrlKey: true }), closed)).toBe('ignore')
  })

  it('opens the list with Ctrl+Space, and only while something is showing', () => {
    expect(suggestionKeyAction(key(' ', { ctrlKey: true }), open)).toBe('expand')
    const closed = { open: false, atLineEnd: true, mode: 'inline' } as const
    expect(suggestionKeyAction(key(' ', { ctrlKey: true }), closed)).toBe('ignore')
  })

  it('leaves Right alone when it is a real cursor move', () => {
    // Mid-line, Right means "move right". Only at the end of the line, where
    // it would otherwise do nothing, does it accept.
    expect(suggestionKeyAction(key('ArrowRight'), { open: true, atLineEnd: false, mode: 'inline' } as const)).toBe('ignore')
  })

  it('ignores every modified form of the accept key', () => {
    // Alt is the exception, and means the word-wise take rather than nothing.
    for (const mod of ['ctrlKey', 'metaKey', 'shiftKey'] as const) {
      expect(suggestionKeyAction(key('ArrowRight', { [mod]: true }), open)).toBe('ignore')
    }
    expect(suggestionKeyAction(key('ArrowRight', { altKey: true, shiftKey: true }), open)).toBe(
      'ignore',
    )
    // Alt and Shift do not navigate either — only Ctrl does.
    expect(suggestionKeyAction(key('ArrowUp', { altKey: true }), list)).toBe('ignore')
    expect(suggestionKeyAction(key('ArrowUp', { shiftKey: true }), list)).toBe('ignore')
  })

  it('ignores ordinary typing', () => {
    for (const k of ['a', 'Enter', 'Backspace', 'Home', 'F5']) {
      expect(suggestionKeyAction(key(k), open)).toBe('ignore')
    }
  })
})

/**
 * A tracker stub whose read is set by the test.
 *
 * `exact` defaults to true — a host with shell integration — because that is
 * the case with no extra rules attached, and the tests below are about the
 * controller rather than about inference. The inferred case has its own tests.
 */
function fakeTracker(input: PromptInput | null, exact = true) {
  const state = { input, exact }
  const tracker = {
    read: () => state.input,
    get exact() {
      return state.exact
    },
  } as unknown as PromptInputTracker
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
  overrides: { enabled?: boolean; exact?: boolean } = {},
) {
  const { tracker, state } = fakeTracker(input, overrides.exact ?? true)
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

  it('offers nothing for a single key at an inferred prompt', async () => {
    // What `n` at apt's `Do you want to continue? [Y/n]` looks like from here:
    // output stopped, a printable character was typed, and there are no
    // markers to say a program is running. Answering that with every command
    // beginning with `n` is the fault this guards.
    const { controller } = makeController(promptInput('n'), ['nmap -sV host', 'nano notes.md'], {
      exact: false,
    })
    controller.refresh()
    await new Promise((r) => setTimeout(r, 0))
    expect(controller.current).toBeNull()
  })

  it('offers on the second character of an inferred line', async () => {
    // The floor is one key, not a general reluctance — two characters is a
    // command being typed.
    const { controller } = makeController(promptInput('nm'), ['nmap -sV host'], { exact: false })
    controller.refresh()
    await vi.waitFor(() => expect(controller.current).not.toBeNull())
    expect(controller.current?.items).toEqual(['nmap -sV host'])
  })

  it('still offers on a single character when the prompt was marked', async () => {
    // An integrated shell said where the line begins, so there is nothing to
    // confuse a command with and no reason to hold back.
    const { controller } = makeController(promptInput('n'), ['nmap -sV host'])
    controller.refresh()
    await vi.waitFor(() => expect(controller.current).not.toBeNull())
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
   * drawn and the key being pressed, output can arrive and redraw the line — so
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

  describe('taking one word at a time', () => {
    it('sends the next word of the suffix and nothing after it', async () => {
      const { controller, sent, accepted } = makeController(promptInput('git '), [
        'git commit -m "wip"',
      ])
      controller.refresh()
      await vi.waitFor(() => expect(controller.current).not.toBeNull())

      controller.acceptWord()
      expect(sent).toEqual(['commit'])
      // A word is not an endorsement of the whole line, so nothing is ranked up.
      expect(accepted).toEqual([])
      expect(controller.current).toBeNull()
    })

    it('includes the space before the word, so words do not run together', async () => {
      const { controller, sent } = makeController(promptInput('git commit'), [
        'git commit -m "wip"',
      ])
      controller.refresh()
      await vi.waitFor(() => expect(controller.current).not.toBeNull())
      controller.acceptWord()
      expect(sent).toEqual([' -m'])
    })

    /**
     * The word only reaches the line when the far end echoes it. That echo is
     * an ordinary refresh on a longer prefix, which re-offers the rest — and
     * is what makes a second Alt+Right take a second word.
     */
    it('re-offers the rest once the echo lands', async () => {
      const { controller, state, sent } = makeController(promptInput('git '), [
        'git commit -m "wip"',
      ])
      controller.refresh()
      await vi.waitFor(() => expect(controller.current).not.toBeNull())
      controller.acceptWord()

      state.input = promptInput('git commit')
      controller.refresh()
      await vi.waitFor(() => expect(controller.current).not.toBeNull())
      expect(suggestionSuffix(controller.current!)).toBe(' -m "wip"')

      controller.acceptWord()
      expect(sent).toEqual(['commit', ' -m'])
    })

    it('is a full accept when one word is all that is left', async () => {
      const { controller, sent, accepted } = makeController(promptInput('git s'), ['git status'])
      controller.refresh()
      await vi.waitFor(() => expect(controller.current).not.toBeNull())
      controller.acceptWord()
      expect(sent).toEqual(['tatus'])
      expect(accepted).toEqual(['git status'])
    })

    it('sends nothing when the line moved under the suggestion', async () => {
      const { controller, state, sent } = makeController(promptInput('git '), ['git commit -m x'])
      controller.refresh()
      await vi.waitFor(() => expect(controller.current).not.toBeNull())
      state.input = promptInput('sudo reboot')
      controller.acceptWord()
      expect(sent).toEqual([])
    })
  })

  it('takes the highlighted row on Enter once the list is open', async () => {
    const { controller, sent } = makeController(promptInput('git s'), ['git status', 'git stash'])
    controller.refresh()
    await vi.waitFor(() => expect(controller.current).not.toBeNull())

    // Inline, Enter is the shell's — it runs what is on the line.
    expect(controller.handleKey(key('Enter'))).toBe(false)
    expect(sent).toEqual([])

    expect(controller.handleKey(key(' ', { ctrlKey: true }))).toBe(true)
    expect(controller.handleKey(key('ArrowDown'))).toBe(true)
    expect(controller.handleKey(key('Enter'))).toBe(true)
    // The selection, not the first row — and appended, not run: a second Enter
    // does that, and by then nothing is showing to swallow it.
    expect(sent).toEqual(['tash'])
    expect(controller.current).toBeNull()
    expect(controller.handleKey(key('Enter'))).toBe(false)
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
    // Inline: both arrows go to the shell.
    expect(controller.handleKey(key('ArrowDown'))).toBe(false)
    expect(controller.handleKey(key('ArrowDown', { ctrlKey: true }))).toBe(false)
    // Summon the list, and they become the list's.
    expect(controller.handleKey(key(' ', { ctrlKey: true }))).toBe(true)
    expect(controller.handleKey(key('ArrowDown'))).toBe(true)
    expect(controller.handleKey(key('ArrowDown', { ctrlKey: true }))).toBe(true)
    expect(controller.handleKey(key('Escape'))).toBe(true)
    expect(controller.current).toBeNull()
    // Tab belongs to the far end whether or not anything is showing.
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

describe('the inline view and opening it out', () => {
  it('starts inline, which is what a fresh offer always is', async () => {
    const { controller } = makeController(promptInput('git s'), ['git status', 'git stash'])
    controller.refresh()
    await vi.waitFor(() => expect(controller.current).not.toBeNull())
    expect(controller.current?.mode).toBe('inline')
  })

  it('opens out into the list on request, and stays there for that offer', async () => {
    const { controller } = makeController(promptInput('git s'), ['git status', 'git stash'])
    controller.refresh()
    await vi.waitFor(() => expect(controller.current).not.toBeNull())
    controller.expand()
    expect(controller.current?.mode).toBe('list')
    // Moving through it does not close it again.
    controller.move(1)
    expect(controller.current?.mode).toBe('list')
    expect(controller.current?.index).toBe(1)
  })

  /**
   * Opening the list is a decision about one ambiguous prefix, not a mode to
   * be stuck in. The next thing typed gets the quiet view back.
   */
  it('returns to inline for the next offer', async () => {
    const { controller, state } = makeController(promptInput('git s'), ['git status'])
    controller.refresh()
    await vi.waitFor(() => expect(controller.current).not.toBeNull())
    controller.expand()
    expect(controller.current?.mode).toBe('list')

    controller.noteInput(TYPING)
    state.input = promptInput('git st')
    controller.refresh()
    await vi.waitFor(() => expect(controller.current?.mode).toBe('inline'))
  })

  it('does nothing when asked to expand with nothing showing', () => {
    const { controller } = makeController(promptInput('git s'), ['git status'])
    controller.expand()
    expect(controller.current).toBeNull()
  })
})

describe('suggestionSuffix', () => {
  function view(items: string[], typed: string, index = 0): SuggestionView {
    return { items, index, typed, origin: { row: 0, col: 0 }, cursor: { row: 0, col: 0 }, mode: 'inline' }
  }

  it('is the part not yet typed — what inline shows and accepting sends', () => {
    expect(suggestionSuffix(view(['git status'], 'git s'))).toBe('tatus')
  })

  it('follows the highlighted item, not always the first', () => {
    expect(suggestionSuffix(view(['git status', 'git stash'], 'git s', 1))).toBe('tash')
  })

  /**
   * Belt and braces against drawing something misleading. A view whose
   * candidate no longer extends what is on the line would otherwise render
   * ghost text that does not continue the command under it.
   */
  it('is empty when the candidate does not extend what was typed', () => {
    expect(suggestionSuffix(view(['sudo reboot'], 'git s'))).toBe('')
    expect(suggestionSuffix(view([], 'git s'))).toBe('')
  })
})

describe('firstWordOfSuffix', () => {
  it('takes the leading space with the word, so nothing runs together', () => {
    expect(firstWordOfSuffix(' -m "wip"')).toBe(' -m')
    expect(firstWordOfSuffix('commit -m "wip"')).toBe('commit')
  })

  it('crosses a path in one press rather than one segment at a time', () => {
    // Not readline's `forward-word`: the unit someone changes their mind about
    // on a command line is the argument, not the path segment.
    expect(firstWordOfSuffix(' /etc/nginx/nginx.conf && reload')).toBe(' /etc/nginx/nginx.conf')
  })

  it('is the whole remainder when there is no boundary left in it', () => {
    // Which is what makes the last word-accept of a line a full accept.
    expect(firstWordOfSuffix('tatus')).toBe('tatus')
    expect(firstWordOfSuffix('')).toBe('')
    expect(firstWordOfSuffix('   ')).toBe('   ')
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
