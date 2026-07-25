/**
 * Feature-parity ledger vs the xterm.js baseline — Phase 7's fourth checkbox.
 *
 * ## What the xterm engine is for
 *
 * It is a **test oracle and benchmark reference, not a renderer this app can
 * be asked to use.** Ghostty is the only engine a pane ever runs; there is no
 * engine picker and no per-pane `engine` field. `xtermEngine.ts` lives in this
 * directory rather than `src/lib/` to say so structurally.
 *
 * That is a change of role, not a demotion. As a user-selectable fallback it
 * was a second input path and a second bug surface behind a settings control
 * nobody could evaluate — "switch renderer" is not a choice a user has any
 * basis to make, and the four gaps it existed to escape are upstream ABI
 * limits (marked `upstream` below) that a user hitting them cannot recognise
 * as such. As an oracle it earns its keep on every test run: `gridSnapshot.
 * test.ts` feeds the same bytes through both cores headlessly and asserts they
 * agree on glyphs, layout, cursor, per-cell colours and text attributes.
 *
 * **What this cost.** The WebGL-context-loss fallback is gone. A pane whose GL
 * context dies no longer has a second renderer to fall back to; it recovers
 * the context (see WebGLRenderer's `onContextRestored`) or, if the WASM core
 * itself never loads, shows Terminal.tsx's renderer-failed overlay. That was
 * judged the right trade because context loss is recoverable in-engine and
 * core-load failure is not something a second renderer fixes — but it is a
 * real capability given up, and if it turns out to matter the answer is to
 * restore the fallback *automatically on failure*, not to put the picker back.
 *
 * Full removal of xterm.js was not taken: the parity test would lose its
 * reference and become a self-snapshot, asserting only that Ghostty still
 * agrees with itself. That is worth revisiting once Ghostty has been the sole
 * engine long enough that regressions surface through use.
 *
 * ## The ledger
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
  // Asserted by gridSnapshot.test.ts, per-cell, over the four workloads plus
  // directed SGR cases (the 16 ANSI colours, the whole 256 cube and grey ramp,
  // 24-bit, attribute run boundaries, erase-with-background). Both engines are
  // pinned to one palette to make the comparison meaningful — see
  // gridPalette.ts. Previously this line covered glyphs only and the "colours"
  // half of it was unenforced prose.
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
  { area: 'Multi-pane', item: 'WebGL context budget, context-loss recovery', status: 'parity', note: 'recovers in-engine; the second-renderer fallback is gone — see the header' },
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
