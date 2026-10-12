/**
 * Feature-parity ledger against the xterm.js baseline.
 *
 * ## What the xterm engine is for
 *
 * A test oracle and benchmark reference, not a renderer a pane can use;
 * Ghostty is the only engine, and `xtermEngine.ts` lives here rather than in
 * `src/lib/` to say so. `gridSnapshot.test.ts` feeds the same bytes through
 * both cores headlessly and asserts glyphs, layout, cursor, per-cell colors
 * and attributes agree.
 *
 * Without a second renderer, a pane whose GL context dies recovers it
 * (WebGLRenderer's `onContextRestored`), and a core that never loads shows
 * Terminal.tsx's renderer-failed overlay. If a fallback is ever needed, make
 * it automatic on failure rather than a user setting.
 *
 * ## The ledger
 *
 * Kept as data so the harness can render and export it. Status is one of:
 *   - 'parity' : behaves the same as the xterm path
 *   - 'better' : the Ghostty path does something the xterm path did not
 *   - 'gap'    : xterm does it and Ghostty does not yet
 *
 * `upstream` marks a gap needing a change to the WASM build rather than this
 * side of the ABI. None is currently blocked on it.
 */

export type ParityStatus = 'parity' | 'better' | 'gap'

export interface ParityItem {
  area: string
  item: string
  status: ParityStatus
  note?: string
  upstream?: boolean
}

export const PARITY: ParityItem[] = [
  // Asserted per cell by gridSnapshot.test.ts over the four workloads plus
  // directed SGR cases (16 ANSI colors, the 256 cube and gray ramp, 24-bit,
  // attribute run boundaries, erase-with-background), with both engines on one
  // palette (gridPalette.ts).
  { area: 'Render', item: 'Glyphs, colors, layout', status: 'parity' },
  { area: 'Render', item: 'Background opacity / transparency', status: 'better', note: 'reaches the clear color; the xterm WebGL path could not' },
  { area: 'Render', item: 'Wide (CJK / emoji) characters', status: 'parity' },
  { area: 'Render', item: 'Grapheme clusters (combining marks, ZWJ emoji)', status: 'parity' },
  { area: 'Render', item: 'Text attrs: bold, italic, underline, strikethrough', status: 'parity' },
  { area: 'Render', item: 'Text attrs: inverse, faint, invisible, blink', status: 'parity' },
  // Carried in the former GhosttyCell padding byte, so cells stay 16 bytes.
  // Overline is compared against xterm; the underline style has no oracle
  // (xterm exposes only isOverline) and is asserted against the SGR that set it.
  { area: 'Render', item: 'Overline, double / curly underline', status: 'parity', note: 'underline style has no xterm oracle; asserted against the SGR instead' },
  { area: 'Cursor', item: 'Block cursor, focused / unfocused outline', status: 'parity' },
  { area: 'Cursor', item: 'Blink (matched 530 ms period)', status: 'parity' },
  // `get_cursor_style` and `_get_cursor_blinking`, read off the cursor's
  // snapshot. Bar and underline draw as substituted glyphs, one quad per cell.
  { area: 'Cursor', item: 'DECSCUSR shapes, steady and blinking', status: 'parity' },
  { area: 'Input', item: 'Keyboard, control & named keys, app-cursor mode', status: 'parity' },
  { area: 'Input', item: 'IME / dead-key composition', status: 'parity', note: 'offscreen textarea path' },
  { area: 'Input', item: 'Per-pane backspace ^H / ^? preference', status: 'parity' },
  { area: 'Selection', item: 'Click-drag, word (dbl), line (triple)', status: 'parity' },
  { area: 'Selection', item: 'Rectangular (alt-drag), copy-on-select, autoscroll', status: 'parity' },
  { area: 'Selection', item: 'Right-click paste, bracketed paste', status: 'parity' },
  { area: 'Scrollback', item: 'Buffer + custom scrollbar, scroll pinning', status: 'parity', note: 'byte-budgeted rather than row-count' },
  { area: 'Mouse', item: 'Reporting 1000 / 1002 / 1003, SGR 1006', status: 'parity' },
  { area: 'Mouse', item: 'Focus reporting 1004, wheel as buttons', status: 'parity' },
  { area: 'Search', item: 'On-screen + scrollback, per-row scan', status: 'parity' },
  // Search joins a wrapped line before matching; a hit spanning the wrap
  // highlights on every row and counts once.
  { area: 'Search', item: 'Matches across a wrapped line in scrollback', status: 'parity' },
  { area: 'Events', item: 'Bell, title, OSC 133 activity, buffer change', status: 'parity', note: 'bell/OSC via a scan until the core exposes callbacks' },
  { area: 'Responses', item: 'DSR / cursor-position replies drained', status: 'parity' },
  // ESC[c returns ESC[?62;22c (handleDeviceAttributes in c/terminal.zig).
  { area: 'Responses', item: 'Primary Device Attributes (ESC[c)', status: 'parity', note: 'verified: replies ESC[?62;22c' },
  { area: 'Multi-pane', item: 'WebGL context budget, context-loss recovery', status: 'parity', note: 'recovers in-engine; the second-renderer fallback is gone — see the header' },
  { area: 'Theming', item: 'Theme + opacity onto clear color and blending', status: 'parity' },
]

export function parityTotals(items: ParityItem[] = PARITY) {
  return {
    parity: items.filter((i) => i.status === 'parity').length,
    better: items.filter((i) => i.status === 'better').length,
    gap: items.filter((i) => i.status === 'gap').length,
    upstreamGaps: items.filter((i) => i.status === 'gap' && i.upstream).length,
  }
}
