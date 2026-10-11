import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ModeSnapshot } from './sessionModes'
import type { GhosttyWasm } from './wasmBindings'

/**
 * A program that dies with the connection still up, through a real engine and
 * a real core, with the OSC 133 wiring `Terminal.tsx` gives it.
 *
 * `sessionModes.test.ts` covers the reset a dropped link gets. This is the
 * other half: the shell survives, and the only sign the program is gone is the
 * shell's next prompt. What matters here is mostly what is *not* reset — the
 * shell's own modes, set before the command or after the prompt — and that the
 * reset lands at the marker even when the marker shares a chunk with what
 * follows it.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = readFileSync(join(here, 'vendor/ghostty-vt.wasm'))

interface Internals {
  termPtr: number
  wasm: GhosttyWasm
  keyEncoder: { probeProtocol(): string }
}

const C = '\x1b]133;C\x07'
const D = (code: number) => `\x1b]133;D;${code}\x07`
const PROMPT = '\x1b]133;A\x07$ \x1b]133;B\x07'
/** Bash around a command: bracketed paste on for the prompt, off to run it. */
const BASH_RUN = '\x1b[?2004l' + C
const BASH_PROMPT = PROMPT + '\x1b[?2004h'
/** What Claude Code had on when it was killed in the screenshot. */
const CLAUDE = '\x1b[?1049h\x1b[>1u\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?1004h\x1b[?25l'

describe('a program that dies under a live shell', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.byteLength),
    }))
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })
  })
  afterEach(() => vi.unstubAllGlobals())

  async function boot() {
    const { GhosttyEngine } = await import('./GhosttyEngine')
    const engine = new GhosttyEngine()
    const inner = engine as unknown as Internals
    for (let i = 0; i < 200 && !inner.termPtr; i++) await new Promise((r) => setTimeout(r, 5))
    if (!inner.termPtr) throw new Error('core did not load')

    // Terminal.tsx's handler, minus everything else it feeds.
    let atStart: ModeSnapshot | null = null
    engine.registerOscHandler(133, (data) => {
      const kind = data.split(';')[0]
      if (kind === 'C') atStart ??= engine.captureModes()
      else if ((kind === 'A' || kind === 'D') && atStart) {
        engine.resetLeftoverModes(atStart)
        atStart = null
      }
      return true
    })

    const legacy = inner.keyEncoder.probeProtocol()
    const ex = inner.wasm.exports
    const mode = (m: number) => ex.ghostty_terminal_get_mode(inner.termPtr, m, 0) !== 0
    const state = () => ({
      alt: ex.ghostty_terminal_is_alternate_screen(inner.termPtr) !== 0,
      mouse: ex.ghostty_terminal_has_mouse_tracking(inner.termPtr) !== 0,
      keyboard: inner.keyEncoder.probeProtocol() === legacy ? 'legacy' : 'other',
      paste: mode(2004),
      focus: mode(1004),
      appCursor: mode(1),
      keypad: mode(66),
      cursorVisible: mode(25),
    })
    return { engine, state }
  }

  /** A bash prompt, waiting for input, with nothing left over. */
  const AT_PROMPT = {
    alt: false,
    mouse: false,
    keyboard: 'legacy',
    paste: true,
    focus: false,
    appCursor: false,
    keypad: false,
    cursorVisible: true,
  }

  it('undoes what a killed full-screen program left on, at the next prompt', async () => {
    const { engine, state } = await boot()
    engine.write(BASH_PROMPT)
    engine.write(BASH_RUN + CLAUDE + 'thinking...')
    expect(state()).toMatchObject({ alt: true, mouse: true, keyboard: 'other' })
    engine.write('Killed\r\n' + D(137) + BASH_PROMPT)
    expect(state()).toEqual(AT_PROMPT)
    engine.dispose()
  })

  it('resets at the marker, not at the end of the chunk it arrived in', async () => {
    const { engine, state } = await boot()
    engine.write(BASH_PROMPT)
    // One delivery from command to the next prompt, which is how a quick
    // crash arrives — and a shell like fish turns on the Kitty protocol and
    // focus reports for its own prompt right after drawing it.
    engine.write(BASH_RUN + '\x1b[?1000h\x1b[?1006h\x1b[>1u' + D(1) + PROMPT + '\x1b[>5u\x1b[?1004h')
    expect(state()).toMatchObject({ mouse: false, keyboard: 'other', focus: true })
    engine.dispose()
  })

  it("leaves a mode the shell had on through the command", async () => {
    const { engine, state } = await boot()
    // A shell that keeps bracketed paste and application cursor keys on while
    // its command runs. Neither was the command's to turn off.
    engine.write(PROMPT + '\x1b[?2004h\x1b[?1h' + C + 'output\r\n' + D(0) + PROMPT)
    expect(state()).toMatchObject({ paste: true, appCursor: true })
    engine.dispose()
  })

  it("puts back modifyOtherKeys, the keypad and the cursor a killed editor leaves", async () => {
    const { engine, state } = await boot()
    engine.write(BASH_PROMPT)
    // Vim's own startup, short of the alternate screen.
    engine.write(BASH_RUN + '\x1b[>4;2m\x1b[?1h\x1b=\x1b[?25l')
    expect(state()).toMatchObject({ keyboard: 'other', appCursor: true, keypad: true, cursorVisible: false })
    engine.write(D(137) + BASH_PROMPT)
    expect(state()).toEqual(AT_PROMPT)
    engine.dispose()
  })

  it('does nothing without a command start to compare against', async () => {
    const { engine, state } = await boot()
    // A shell that only marks prompts, or Enter on an empty line: a `D` and an
    // `A` with no `C`. With nothing to say which modes were the shell's,
    // nothing is touched.
    engine.write('\x1b[?1000h' + D(0) + PROMPT)
    expect(state().mouse).toBe(true)
    engine.dispose()
  })

  it('leaves a program that exits cleanly exactly as it left things', async () => {
    const { engine, state } = await boot()
    engine.write(BASH_PROMPT)
    engine.write(BASH_RUN + CLAUDE + 'bye')
    engine.write('\x1b[?1004l\x1b[?2004l\x1b[?1006l\x1b[?1003l\x1b[<u\x1b[?1049l\x1b[?25h' + D(0) + BASH_PROMPT)
    expect(state()).toEqual(AT_PROMPT)
    engine.dispose()
  })
})
