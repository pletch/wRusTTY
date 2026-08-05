import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

import { MouseEncoder } from './MouseEncoder'
import {
  MOUSE_ACTION_MOTION,
  MOUSE_ACTION_PRESS,
  MOUSE_ACTION_RELEASE,
  MOUSE_BUTTON_FOUR,
  MOUSE_BUTTON_LEFT,
  MOUSE_BUTTON_MIDDLE,
  MOUSE_BUTTON_RIGHT,
  MOUSE_BUTTON_WHEEL_DOWN,
  MOUSE_BUTTON_WHEEL_UP,
  mouseButtonFor,
} from './main/mouseAbi'
import { createTerminal, instantiateGhosttyWasm, writeString, type GhosttyWasm } from './wasmBindings'

/**
 * The mouse encoder, against the binary that ships.
 *
 * This replaced hand-rolled reporting that covered two wire formats out of
 * five and three tracking modes out of five, and which had no test at all —
 * the suites that touch the mouse stub `mouseTracking` to steer the
 * report-versus-select decision and never look at the bytes, so every one of
 * them would have passed with reporting completely broken.
 *
 * As with `KeyEncoder.test.ts`, the modes are set the only way a real session
 * sets them: by writing the sequence to the terminal, not by configuring the
 * encoder.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = join(here, 'vendor/ghostty-vt.wasm')

const CELL_W = 10
const CELL_H = 20
const COLS = 80
const ROWS = 24

/** `GhosttyMods`, the same bits the key encoder uses. */
const SHIFT = 1
const CTRL = 2
const ALT = 4

describe('MouseEncoder', () => {
  let wasm: GhosttyWasm

  beforeAll(async () => {
    wasm = await instantiateGhosttyWasm(Uint8Array.from(readFileSync(WASM)).buffer as ArrayBuffer)
  })

  /** A fresh terminal and encoder per test: tracking mode and format are
   *  terminal state and would otherwise leak into the next case. */
  function boot(padding?: { top?: number; left?: number }) {
    const term = createTerminal(wasm, COLS, ROWS, {
      scrollbackLimit: 0,
      fgColor: 0,
      bgColor: 0,
      cursorColor: 0,
    })
    const encoder = MouseEncoder.create(wasm, term)
    if (!encoder) throw new Error('the shipped binary has no mouse encoder')
    encoder.setSurface({
      screenWidth: COLS * CELL_W + (padding?.left ?? 0),
      screenHeight: ROWS * CELL_H + (padding?.top ?? 0),
      cellWidth: CELL_W,
      cellHeight: CELL_H,
      paddingLeft: padding?.left ?? 0,
      paddingTop: padding?.top ?? 0,
    })
    const encode = (o: {
      action?: number
      button?: number | null
      x?: number
      y?: number
      mods?: number
      held?: boolean
    }) => {
      const bytes = encoder.encode({
        action: o.action ?? MOUSE_ACTION_PRESS,
        button: o.button === undefined ? MOUSE_BUTTON_LEFT : o.button,
        x: o.x ?? 15,
        y: o.y ?? 25,
        mods: o.mods ?? 0,
        anyButtonPressed: o.held ?? false,
      })
      return bytes === null ? null : new TextDecoder().decode(bytes)
    }
    return { encode, write: (s: string) => writeString(wasm, term, s) }
  }

  it('reports nothing at all until a program asks', () => {
    const { encode } = boot()
    // The default. A terminal that reported unasked would send escape
    // sequences into every shell that never enabled tracking.
    expect(encode({})).toBeNull()
  })

  describe('the legacy one-byte form, which is what 1000 gets by default', () => {
    it('numbers the buttons the way the protocol does, not the way the DOM does', () => {
      const { encode, write } = boot()
      write('\x1b[?1000h')
      // 32 is the bias every legacy field carries. Left is 0, middle is 1,
      // right is 2 — which is *not* the enum's order, and is the whole reason
      // `mouseButtonFor` exists.
      expect(encode({ button: MOUSE_BUTTON_LEFT })).toBe('\x1b[M \x22\x22')
      expect(encode({ button: MOUSE_BUTTON_MIDDLE })).toBe('\x1b[M!\x22\x22')
      expect(encode({ button: MOUSE_BUTTON_RIGHT })).toBe('\x1b[M\x22\x22\x22')
    })

    it('cannot say which button came up, so a release is always button 3', () => {
      const { encode, write } = boot()
      write('\x1b[?1000h')
      expect(encode({ action: MOUSE_ACTION_RELEASE, held: true })).toBe('\x1b[M#\x22\x22')
    })

    it('turns pixels into cells, biased by 32 and 1-based', () => {
      const { encode, write } = boot()
      write('\x1b[?1000h')
      // The top-left pixel is cell 1,1 — encoded as 33, not 32.
      expect(encode({ x: 0, y: 0 })).toBe('\x1b[M !!')
      // One pixel short of the second column is still the first.
      expect(encode({ x: 9, y: 19 })).toBe('\x1b[M !!')
      expect(encode({ x: 10, y: 20 })).toBe('\x1b[M \x22\x22')
    })

    it('carries the modifiers as their own bits', () => {
      const { encode, write } = boot()
      write('\x1b[?1000h')
      expect(encode({ mods: SHIFT })).toBe('\x1b[M$\x22\x22')
      expect(encode({ mods: ALT })).toBe('\x1b[M(\x22\x22')
      expect(encode({ mods: CTRL })).toBe('\x1b[M0\x22\x22')
    })

    it('reports the wheel as buttons 64 and 65', () => {
      const { encode, write } = boot()
      write('\x1b[?1000h')
      // ` is 96, a is 97 — 64 and 65 once the bias comes off. This is how
      // less and htop page without a scrollback of their own.
      expect(encode({ button: MOUSE_BUTTON_WHEEL_UP })).toBe('\x1b[M`\x22\x22')
      expect(encode({ button: MOUSE_BUTTON_WHEEL_DOWN })).toBe('\x1b[Ma\x22\x22')
    })
  })

  describe('which events each tracking mode wants', () => {
    it('reports presses only under X10 (mode 9)', () => {
      const { encode, write } = boot()
      write('\x1b[?9h')
      expect(encode({})).toBe('\x1b[M \x22\x22')
      // The old hand-rolled reporter sent both of these into X10, which is
      // exactly the kind of gap that made this a wrapper rather than a port.
      expect(encode({ action: MOUSE_ACTION_RELEASE, held: true })).toBeNull()
      expect(encode({ action: MOUSE_ACTION_MOTION, held: true })).toBeNull()
    })

    it('ignores motion under plain 1000', () => {
      const { encode, write } = boot()
      write('\x1b[?1000h')
      expect(encode({ action: MOUSE_ACTION_MOTION, button: null })).toBeNull()
    })

    it('reports motion only while a button is held under 1002', () => {
      const { encode, write } = boot()
      write('\x1b[?1002h')
      // 64 is the motion flag plus button 0.
      expect(encode({ action: MOUSE_ACTION_MOTION, x: 35, held: true })).toBe('\x1b[M@$\x22')
      expect(encode({ action: MOUSE_ACTION_MOTION, button: null, x: 55, held: false })).toBeNull()
    })

    it('reports bare motion under 1003', () => {
      const { encode, write } = boot()
      write('\x1b[?1003h')
      // 35 is the motion flag plus 3, which is the legacy form's "no button".
      expect(encode({ action: MOUSE_ACTION_MOTION, button: null, x: 55 })).toBe('\x1b[MC&\x22')
    })
  })

  describe('the wire formats a program can switch to', () => {
    it('encodes SGR, which is the one that survives a wide pane', () => {
      const { encode, write } = boot()
      write('\x1b[?1000h\x1b[?1006h')
      expect(encode({})).toBe('\x1b[<0;2;2M')
      // Lower-case m for a release, which is how SGR says *which* button.
      expect(encode({ action: MOUSE_ACTION_RELEASE, held: true })).toBe('\x1b[<0;2;2m')
      // Column 80. The legacy form biases each coordinate into one byte and
      // so cannot describe anything past 223 — the reason SGR exists.
      expect(encode({ x: 795 })).toBe('\x1b[<0;80;2M')
    })

    it('encodes SGR-pixels, which the cell-based reporter could not express', () => {
      const { encode, write } = boot()
      write('\x1b[?1000h\x1b[?1016h')
      // The position, not the cell — this is why the encoder takes pixels.
      expect(encode({ x: 15, y: 25 })).toBe('\x1b[<0;15;25M')
    })

    it('encodes urxvt, which was not implemented here at all', () => {
      const { encode, write } = boot()
      write('\x1b[?1000h\x1b[?1015h')
      expect(encode({})).toBe('\x1b[32;2;2M')
    })
  })

  describe('positions it will not encode', () => {
    it('declines a position outside the surface', () => {
      const { encode, write } = boot()
      write('\x1b[?1000h\x1b[?1006h')
      // Not clamped for us. A drag that leaves the pane would go silent, which
      // is why `GhosttyEngine.pointerAt` clamps before it gets here.
      expect(encode({ x: 5000 })).toBeNull()
      expect(encode({ x: -5, y: -5 })).toBeNull()
    })

    it('puts the padding outside the grid, not inside cell one', () => {
      const { encode, write } = boot({ left: 10 })
      write('\x1b[?1000h\x1b[?1006h')
      // x=10 is the first pixel of the grid proper.
      expect(encode({ x: 10 })).toBe('\x1b[<0;1;2M')
      expect(encode({ x: 25 })).toBe('\x1b[<0;2;2M')
    })
  })

  describe('mouseButtonFor', () => {
    it('translates the DOM numbering, which is not the protocol s', () => {
      // The one that matters: DOM 1 is the middle button and protocol 1 is
      // the left. Passing `MouseEvent.button` straight through reports a
      // middle click as a right click.
      expect(mouseButtonFor(0)).toBe(MOUSE_BUTTON_LEFT)
      expect(mouseButtonFor(1)).toBe(MOUSE_BUTTON_MIDDLE)
      expect(mouseButtonFor(2)).toBe(MOUSE_BUTTON_RIGHT)
      expect(mouseButtonFor(3)).toBe(MOUSE_BUTTON_FOUR)
    })

    it('declines a button it has no meaning for', () => {
      expect(mouseButtonFor(11)).toBeNull()
    })
  })
})
