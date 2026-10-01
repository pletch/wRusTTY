import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

import { KeyEncoder } from './KeyEncoder'
import { sessionModeReset } from './sessionModes'
import { createTerminal, instantiateGhosttyWasm, writeString, type GhosttyWasm } from './wasmBindings'

/**
 * The reset against the binary that ships, because the whole question is
 * whether the core does what the sequence asks — a string comparison would
 * pass just as happily if the Kitty pop count were ignored or the alternate
 * screen kept its own stack after we left it.
 *
 * The far end's half is what Claude Code was doing when the link dropped:
 * any-motion SGR mouse reports and the Kitty protocol, on the alternate screen.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = join(here, 'vendor/ghostty-vt.wasm')

const TUI_ON = '\x1b[?1049h\x1b[>1u\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?1004h\x1b[?1h\x1b[?25l'

function escapeKey(): KeyboardEvent {
  return {
    code: 'Escape',
    key: 'Escape',
    type: 'keydown',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
    getModifierState: () => false,
  } as unknown as KeyboardEvent
}

describe('sessionModeReset', () => {
  let wasm: GhosttyWasm

  beforeAll(async () => {
    wasm = await instantiateGhosttyWasm(Uint8Array.from(readFileSync(WASM)).buffer as ArrayBuffer)
  })

  function boot() {
    const term = createTerminal(wasm, 80, 24, { scrollbackLimit: 1000, fgColor: 0, bgColor: 0, cursorColor: 0 })
    const encoder = KeyEncoder.create(wasm, term)
    if (!encoder) throw new Error('the shipped binary has no key encoder')
    const ex = wasm.exports
    const write = (s: string) => writeString(wasm, term, s)
    const escape = () => new TextDecoder().decode(encoder.encode(escapeKey()) ?? new Uint8Array())
    const mode = (m: number) => ex.ghostty_terminal_get_mode(term, m, 0) !== 0
    const cursor = () => {
      ex.ghostty_render_state_update(term)
      return { x: ex.ghostty_render_state_get_cursor_x(term), y: ex.ghostty_render_state_get_cursor_y(term) }
    }
    const state = () => ({
      alt: ex.ghostty_terminal_is_alternate_screen(term) !== 0,
      mouse: ex.ghostty_terminal_has_mouse_tracking(term) !== 0,
      escape: escape(),
      paste: mode(2004),
      focus: mode(1004),
      appCursor: mode(1),
      cursorVisible: mode(25),
    })
    return { write, state, cursor }
  }

  const CLEAN = {
    alt: false,
    mouse: false,
    escape: '\x1b',
    paste: false,
    focus: false,
    appCursor: false,
    cursorVisible: true,
  }

  it('undoes a full-screen program that died on the alternate screen', () => {
    const { write, state } = boot()
    write(TUI_ON)
    expect(state()).toMatchObject({ alt: true, mouse: true, escape: '\x1b[27u', paste: true })
    write(sessionModeReset(true))
    expect(state()).toEqual(CLEAN)
  })

  it('clears a Kitty stack pushed on the primary screen as well as the alternate one', () => {
    const { write, state } = boot()
    write('\x1b[>1u\x1b[>1u' + TUI_ON)
    write(sessionModeReset(true))
    expect(state().escape).toBe('\x1b')
  })

  it('undoes modes set on the primary screen without moving the cursor', () => {
    const { write, state, cursor } = boot()
    // The region first: setting it homes the cursor, and the point is a
    // cursor somewhere that homing again would visibly move.
    write('\x1b[5;10r\x1b[>1u\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?1016h')
    write('one\r\ntwo\r\nthree')
    const before = cursor()
    expect(before).toEqual({ x: 5, y: 2 })
    write(sessionModeReset(false))
    expect(state()).toEqual(CLEAN)
    expect(cursor()).toEqual(before)
  })
})
