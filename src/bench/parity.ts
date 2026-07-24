/**
 * Feature-parity ledger vs the xterm.js baseline — Phase 7's fourth checkbox.
 *
 * This is the written comparison the decision rests on, kept as data so the
 * harness can render it and the same list can be exported into the findings.
 * Status is one of:
 *   - 'parity' : behaves the same as the xterm path
 *   - 'better' : the Ghostty path does something the xterm path did not
 *   - 'gap'    : xterm does it and Ghostty does not yet
 *
 * A gap marked `upstream` is not a renderer bug — it needs a newer
 * `libghostty-vt` WASM build than the pinned `ghostty-web@0.4.0`, so it cannot
 * be closed on this side of the ABI.
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
  { area: 'Render', item: 'Glyphs, colours, layout', status: 'parity' },
  { area: 'Render', item: 'Background opacity / transparency', status: 'better', note: 'reaches the clear colour; the xterm WebGL path could not' },
  { area: 'Render', item: 'Wide (CJK / emoji) characters', status: 'parity' },
  { area: 'Render', item: 'Grapheme clusters (combining marks, ZWJ emoji)', status: 'parity' },
  { area: 'Render', item: 'Text attrs: bold, italic, underline, strikethrough', status: 'parity' },
  { area: 'Render', item: 'Text attrs: inverse, faint, invisible, blink', status: 'parity' },
  { area: 'Render', item: 'Overline, double / curly underline', status: 'gap', upstream: true, note: 'core does not surface these attrs yet' },
  { area: 'Cursor', item: 'Block cursor, focused / unfocused outline', status: 'parity' },
  { area: 'Cursor', item: 'Blink (matched 530 ms period)', status: 'parity' },
  { area: 'Cursor', item: 'DECSCUSR bar / underline shapes', status: 'gap', upstream: true },
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
  { area: 'Search', item: 'Matches across a wrapped line in scrollback', status: 'gap', upstream: true, note: 'is_row_wrapped unavailable for scrollback' },
  { area: 'Events', item: 'Bell, title, OSC 133 activity, buffer change', status: 'parity', note: 'bell/OSC via a scan until the core exposes callbacks' },
  { area: 'Responses', item: 'DSR / cursor-position replies drained', status: 'parity' },
  { area: 'Responses', item: 'Primary Device Attributes (ESC[c)', status: 'gap', upstream: true },
  { area: 'Multi-pane', item: 'WebGL context budget, context-loss recovery', status: 'parity' },
  { area: 'Theming', item: 'Theme + opacity onto clear colour and blending', status: 'parity' },
]

export function parityTotals(items: ParityItem[] = PARITY) {
  return {
    parity: items.filter((i) => i.status === 'parity').length,
    better: items.filter((i) => i.status === 'better').length,
    gap: items.filter((i) => i.status === 'gap').length,
    upstreamGaps: items.filter((i) => i.status === 'gap' && i.upstream).length,
  }
}
