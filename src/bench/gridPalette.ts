/**
 * The palette both engines are pinned to for grid-parity snapshots.
 *
 * Ghostty returns colors already resolved to RGB (see wasmBindings' header);
 * xterm.js's headless buffer reports palette indices. Fixing the palette on
 * both (`PALETTE_16` at Ghostty creation, the same table for xterm's indices)
 * makes them comparable, so a mismatch means the engines disagree about a
 * cell's color.
 *
 * Every value has a channel outside the 6x6x6 cube's levels and none is gray,
 * so no index 16-255 can collide with one (`gridPalette.test.ts` asserts
 * this).
 */

export const PALETTE_16 = [
  0x112233, 0x445566, 0x778899, 0xaabbcc,
  0xddee11, 0x214365, 0x658729, 0x9a3b1c,
  0x1c9a3b, 0x3b1c9a, 0xc1d2e3, 0xe3c1d2,
  0x2b4d6e, 0x6e2b4d, 0x4d6e2b, 0xb1c2d3,
] as const

/** Default fg/bg given to Ghostty and used for xterm's default cells; also
 * outside the cube and gray ramp. */
export const DEFAULT_FG = 0xabcdef
export const DEFAULT_BG = 0x123456

/** The cube's per-channel levels (the xterm-256 formula both engines are
 * assumed to share; the parity test would expose otherwise). */
const CUBE_LEVELS = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff]

/** Full 256-entry table: the 16 configured above, then the color cube, then
 * the 24-step gray ramp. */
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
