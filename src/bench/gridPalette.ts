/**
 * The palette both engines are pinned to for grid-parity snapshots.
 *
 * Colour parity is only testable if the two sides can be compared in the same
 * units, and they natively cannot be. Ghostty's ABI hands back colours
 * **already resolved to RGB** against whatever palette the terminal was
 * created with, and deliberately drops the "which slot did this come from"
 * information (see wasmBindings' header). xterm.js does the opposite: its
 * headless buffer reports a *palette index* and resolves to RGB only in a
 * renderer we never construct.
 *
 * So neither side can be converted to the other's units after the fact. What
 * makes them comparable is fixing the palette on both: ghostty is configured
 * with `PALETTE_16` at terminal creation, and xterm's indices are resolved
 * through the same table here. A disagreement then means the engines disagree
 * about which colour a cell *is* — which is the thing worth testing — rather
 * than about what their respective built-in themes happen to be.
 *
 * The values are chosen to be mutually distinct and, more importantly, to be
 * unreachable by indices 16-255: every one has at least one channel outside
 * the 6x6x6 cube's {00,5f,87,af,d7,ff} and none is a pure grey. Without that,
 * a cell wrongly reported as (say) index 22 could collide with the intended
 * index 2 and the test would pass on a real divergence. `gridPalette.test.ts`
 * asserts that property rather than leaving it to the eye.
 */

export const PALETTE_16 = [
  0x112233, 0x445566, 0x778899, 0xaabbcc,
  0xddee11, 0x214365, 0x658729, 0x9a3b1c,
  0x1c9a3b, 0x3b1c9a, 0xc1d2e3, 0xe3c1d2,
  0x2b4d6e, 0x6e2b4d, 0x4d6e2b, 0xb1c2d3,
] as const

/** Default fg/bg handed to ghostty at creation, and what xterm's
 * `isFgDefault()` / `isBgDefault()` resolve to on this side. Both are outside
 * the cube and the grey ramp for the same reason the palette entries are. */
export const DEFAULT_FG = 0xabcdef
export const DEFAULT_BG = 0x123456

/** The 6 levels each channel of the 6x6x6 colour cube takes — the universal
 * xterm-256 formula, which both engines are assumed to implement. If that
 * assumption is wrong the parity test is exactly what surfaces it. */
const CUBE_LEVELS = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff]

/** Full 256-entry table: the 16 configured above, then the colour cube, then
 * the 24-step grey ramp. */
export const PALETTE_256: number[] = (() => {
  const out: number[] = [...PALETTE_16]
  for (let i = 0; i < 216; i++) {
    const r = CUBE_LEVELS[Math.floor(i / 36) % 6]
    const g = CUBE_LEVELS[Math.floor(i / 6) % 6]
    const b = CUBE_LEVELS[i % 6]
    out.push((r << 16) | (g << 8) | b)
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10
    out.push((v << 16) | (v << 8) | v)
  }
  return out
})()

export function rgbHex(color: number): string {
  return color.toString(16).padStart(6, '0')
}
