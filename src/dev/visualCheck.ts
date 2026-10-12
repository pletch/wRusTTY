/**
 * A pane on screen showing the attributes tests only assert as bits.
 * `gridSnapshot.test.ts` proves overline, the five underline styles and the
 * DECSCUSR shapes reach the renderer, but not that a curly underline is drawn
 * curly. Served by vite at /visual.html; nothing imports this.
 */
import { GhosttyEngine } from '../lib/ghostty/GhosttyEngine'
import type { TextBlending } from '../lib/settings'
import { buildFontSelection } from '../lib/fontStack'
import { registerBundledFonts } from '../lib/bundledFonts'

// This page is its own entry, so bundled families must be registered here too
// or `?font=Fira Code` compares the fallback against itself.
registerBundledFonts()

const ESC = '\x1b'
const RESET = `${ESC}[0m`
const fg = (n: number) => `${ESC}[38;5;${n}m`

const rows: [string, string][] = [
  ['underline  single', `${ESC}[4:1m`],
  ['underline  double', `${ESC}[4:2m`],
  ['underline  curly', `${ESC}[4:3m`],
  ['underline  dotted', `${ESC}[4:4m`],
  ['underline  dashed', `${ESC}[4:5m`],
  ['overline', `${ESC}[53m`],
  ['overline + curly', `${ESC}[53;4:3m`],
  ['curly, colored', `${ESC}[4:3m${fg(203)}`],
  ['bold + double under', `${ESC}[1;4:2m`],
  // With ?italic= set, these rows show whether the atlas picked that face.
  ['italic', `${ESC}[3m`],
  ['bold italic', `${ESC}[1;3m`],
  ['plain, for reference', ''],
]

const engine = new GhosttyEngine()
const pane = document.getElementById('pane')!
const err = document.getElementById('err')!
engine.onInitError((m) => {
  err.textContent = `engine failed to start: ${m}`
})
engine.mount(pane)

// Writes before the core loads are buffered by the engine.
let out = `${ESC}[H${ESC}[2J`
for (const [label, sgr] of rows) out += `  ${sgr}${label.padEnd(24)}${RESET}\r\n`
out += `\r\n  cursor shapes — press 1..6 to switch (DECSCUSR)\r\n`
out += `  1 blink block  2 steady block  3 blink under  4 steady under  5 blink bar  6 steady bar\r\n`
// The hover underline and hint labels are drawn, so they're checked here. The
// second link wraps at this width.
out += `\r\n  links — hold Ctrl and hover, or press h for hint labels\r\n`
out += `  see https://example.com/a for details, or (https://example.org/b).\r\n`
out += `  https://example.com/a/rather/long/path/that/has/to/wrap/at/this/width/to/be/interesting\r\n`
out += `\r\n  text blending — press b to cycle, 0 for the physically correct end\r\n`
out += `  The quick brown fox jumps over the lazy dog. 0123456789 il1 O0 =>\r\n`
out += `  ${ESC}[1mbold${RESET} ${fg(203)}red${RESET} ${fg(114)}green${RESET} ${fg(75)}blue${RESET} ${ESC}[2mdim${RESET} — mixed weights\r\n`
// Box drawing is geometry against the cell (boxDrawing.ts); look for seams
// between rows and for arcs and weight changes on the straight rule's axis.
out += `\r\n  box drawing — geometry, not glyphs. Look for seams between rows.\r\n`
out += `  ┌─┬─┐ ┏━┳━┓ ╔═╦═╗ ╭───╮   ┌─────┐\r\n`
out += `  ├─┼─┤ ┣━╋━┫ ╠═╬═╣ │   │   │     │\r\n`
out += `  └─┴─┘ ┗━┻━┛ ╚═╩═╝ ╰───╯   └─────┘\r\n`
out += `  mixed ╞═╡ ╤╥╧╨ ╪╫   dashed ┄┈╌ ┆┊╎   weights ╼╾ ╴╵╶╷\r\n`
out += `  blocks █▇▆▅▄▃▂▁ ▉▊▋▌▍▎▏  shades ░▒▓  quads ▖▗▘▝▞▟\r\n`
out += `  powerline \u{e0b0}\u{e0b1}\u{e0b2}\u{e0b3}\u{e0b4}\u{e0b5}\u{e0b6}\u{e0b7}   diagonals ╱╲╳\r\n`
out += `  angled \u{e0b8}\u{e0b9}\u{e0ba}\u{e0bb}\u{e0bc}\u{e0bd}\u{e0be}\u{e0bf}   eighths \u{1fb70}\u{1fb71}\u{1fb72}\u{1fb73}\u{1fb74}\u{1fb75} \u{1fb76}\u{1fb77}\u{1fb78}\u{1fb79}\u{1fb7a}\u{1fb7b}\r\n`
// A 2x3 mosaic: a row should read as one picture if the subcells tile.
out += `  sextants \u{1fb00}\u{1fb01}\u{1fb02}\u{1fb03}\u{1fb04}\u{1fb05}\u{1fb06}\u{1fb07}\u{1fb08}\u{1fb09}\u{1fb0a}\u{1fb0b}\u{1fb0c}\u{1fb0d}\u{1fb0e}\u{1fb0f}\r\n`
// Should read as three unbroken bars at three heights.
out += `           \u{1fb02}\u{1fb02}\u{1fb02}\u{1fb02} \u{1fb0b}\u{1fb0b}\u{1fb0b}\u{1fb0b} \u{1fb2d}\u{1fb2d}\u{1fb2d}\u{1fb2d}  corners \u{1fb7c}\u{1fb7d}\u{1fb7e}\u{1fb7f}\r\n`

// Color glyphs. The second copy has a red foreground: a red emoji means it was
// sampled as coverage and tinted.
out += `\r\n  color — an emoji font paints its own colors, so neither copy should be tinted\r\n`
out += `  \u{1f600} \u{1f389} \u{1f680} \u{1f41b} \u{1f4e6} \u{1f525}   ${fg(203)}\u{1f600} \u{1f389} \u{1f680} \u{1f41b} \u{1f4e6} \u{1f525}${RESET} on red\r\n`

// Ligatures need a face with them and are off by default; compare with `l`
// pressed.
out += `  ${ESC}[2mfaint \u{1f600} \u{1f525} and text${RESET}   — the emoji fades with it, not past it\r\n`
out += `  ${ESC}[5mblink \u{1f600} \u{1f525} and text${RESET}   — the emoji must blink with the text, not through it\r\n`

out += `\r\n  ligatures — press l to toggle, ?font= to pick a face that has them\r\n`
out += `  -> => <- <= >= != == === !== <=> |> <| :: ++ // /* */ ~= |= &&\r\n`
out += `  ... .. ?. ?? ?: ;; %% ^= $> \\\\ #? __ www   — the ones a wider alphabet reaches\r\n`
out += `  <==> <--> !=== ====  <---> ===== <===>   — the ones longer than three cells\r\n`
out += `  ${ESC}[1m-> => != ===${RESET} bold  ${fg(203)}-> => != ===${RESET} colored\r\n`

// Parked on a character (the `s` of `set`), since a cursor that erases its
// cell looks fine on a blank. Also selectable as ?cursor=N for headless
// screenshots.
const requestedCursor = new URLSearchParams(location.search).get('cursor')
const cursorShape = /^[1-6]$/.test(requestedCursor ?? '') ? requestedCursor : '5'
out += `\r\n  cursor is here -> set${ESC}[3D${ESC}[${cursorShape} q`
engine.write(out)

/**
 * Font settings from the URL, since installed families vary per machine:
 *
 *   ?font=Cascadia Code                    the body face
 *   ?features="calt" 0                     OpenType tags, as font-feature-settings
 *   ?variations="wdth" 75                  variable axes, as font-variation-settings
 *   ?italic=Comic Sans MS                  a face for the italic slot; also
 *   ?bold=…  ?bolditalic=…                 the other two styled slots
 *   ?range=30-39:Comic Sans MS             pin a codepoint range, hex, repeatable
 *   ?weight=300  ?boldweight=600           the two numeric weights
 *   ?lineheight=150  ?spacing=2            cell height percent, and cell widening
 *
 * `?font=Cascadia Code&features="calt" 0` should leave the ligature line
 * unligated even with ligatures on; `?italic=` with an obviously different
 * face shows italics come from a face, not a slant.
 */
const params = new URLSearchParams(location.search)
const wantedFont = params.get('font')
/** A numeric knob from the URL, or the default when it is absent or nonsense. */
const num = (name: string, fallback: number) => {
  const n = Number(params.get(name))
  return Number.isFinite(n) && params.has(name) ? n : fallback
}
const wantedFeatures = params.get('features') ?? ''
const wantedAxes = params.get('variations') ?? ''
/** A styled slot: quoted, so a family with a space in it survives the CSS. */
const slot = (name: string | null) => (name ? JSON.stringify(name) : '')
/** `lo-hi:Family`, hex and inclusive, like the settings dialog's rows. */
const wantedRanges = params.getAll('range').flatMap((spec) => {
  const m = spec.match(/^([0-9a-f]+)-([0-9a-f]+):(.+)$/i)
  if (!m) return []
  return [{ lo: parseInt(m[1], 16), hi: parseInt(m[2], 16), family: JSON.stringify(m[3]) }]
})
const metricParams = ['weight', 'boldweight', 'lineheight', 'spacing', 'italic']
if (
  wantedFont ||
  wantedFeatures ||
  wantedAxes ||
  wantedRanges.length > 0 ||
  metricParams.some((p) => params.has(p))
) {
  const family = wantedFont ? `"${wantedFont}", ui-monospace, monospace` : 'Consolas, monospace'
  engine.setFont(
    buildFontSelection({
      fontFamily: family,
      fontFamilyBold: slot(params.get('bold')),
      fontFamilyItalic: slot(params.get('italic')),
      fontFamilyBoldItalic: slot(params.get('bolditalic')),
      fontFeatures: wantedFeatures,
      fontVariations: wantedAxes,
      fontRanges: wantedRanges,
      fontWeight: num('weight', 400),
      fontWeightBold: num('boldweight', 700),
      lineHeightPercent: num('lineheight', 120),
      letterSpacing: num('spacing', 0),
    }),
    14,
  )
}

// Shaping only changes which glyphs come out, so toggle it in place to see it.
let ligatures = new URLSearchParams(location.search).get('ligatures') === '1'
engine.setLigatures(ligatures)

// Blending only changes partially covered pixels, so cycle it in place: same
// glyphs, one uniform apart.
const BLENDS: [label: string, mode: TextBlending][] = [
  ['native — sRGB, the default', 'native'],
  ['linear — physically correct, changes weight', 'linear'],
  ['linear-corrected — linear at native weight', 'linear-corrected'],
]
// Also ?blend=N, so headless screenshots of each mode can be diffed.
const requested = Number(new URLSearchParams(location.search).get('blend'))
let blendIndex = Number.isInteger(requested) && BLENDS[requested] ? requested : 0
const blendLabel = document.getElementById('blend')
function applyBlend() {
  const [label, mode] = BLENDS[blendIndex]
  engine.setTextBlending(mode)
  if (blendLabel) blendLabel.textContent = label
}
applyBlend()

// Digits re-issue DECSCUSR; `h` stands in for the app's Ctrl+Shift+U (bound
// in Terminal.tsx).
window.addEventListener('keydown', (e) => {
  if (e.key >= '1' && e.key <= '6') engine.write(`${ESC}[${e.key} q`)
  if (e.key === 'h') engine.toggleHintMode()
  if (e.key === 'l') {
    ligatures = !ligatures
    engine.setLigatures(ligatures)
  }
  if (e.key === 'b') {
    blendIndex = (blendIndex + 1) % BLENDS.length
    applyBlend()
  }
  if (e.key === '0') {
    blendIndex = 0
    applyBlend()
  }
})
