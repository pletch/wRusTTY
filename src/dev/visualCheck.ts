/**
 * A pane, on screen, showing the attributes the tests only assert as bits.
 *
 * `gridSnapshot.test.ts` proves overline, the five underline styles and the
 * DECSCUSR shapes reach the renderer per cell. It cannot tell whether a curly
 * underline is drawn curly, or whether a bar cursor is a bar — a renderer that
 * drew every underline as the same straight rule would pass all of it.
 *
 * Served by vite at /visual.html. Not reachable from the app and not bundled
 * into it: nothing imports this, so it only exists when something asks for that
 * URL.
 */
import { GhosttyEngine } from '../lib/ghostty/GhosttyEngine'
import type { TextBlending } from '../lib/settings'
import { buildFontSelection } from '../lib/fontStack'

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
  ['curly, coloured', `${ESC}[4:3m${fg(203)}`],
  ['bold + double under', `${ESC}[1;4:2m`],
  ['plain, for reference', ''],
]

const engine = new GhosttyEngine()
const pane = document.getElementById('pane')!
const err = document.getElementById('err')!
engine.onInitError((m) => {
  err.textContent = `engine failed to start: ${m}`
})
engine.mount(pane)

// The core is fetched and compiled asynchronously; writes before it lands are
// buffered by the engine, so this does not have to wait for it.
let out = `${ESC}[H${ESC}[2J`
for (const [label, sgr] of rows) out += `  ${sgr}${label.padEnd(24)}${RESET}\r\n`
out += `\r\n  cursor shapes — press 1..6 to switch (DECSCUSR)\r\n`
out += `  1 blink block  2 steady block  3 blink under  4 steady under  5 blink bar  6 steady bar\r\n`
// Links: the hover underline and the hint labels are drawn, not set, so they
// belong here for the same reason the underline styles do. The second one is
// long enough to wrap at this width, which is the case the join exists for.
out += `\r\n  links — hold Ctrl and hover, or press h for hint labels\r\n`
out += `  see https://example.com/a for details, or (https://example.org/b).\r\n`
out += `  https://example.com/a/rather/long/path/that/has/to/wrap/at/this/width/to/be/interesting\r\n`
out += `\r\n  text blending — press b to cycle, 0 for the physically correct end\r\n`
out += `  The quick brown fox jumps over the lazy dog. 0123456789 il1 O0 =>\r\n`
out += `  ${ESC}[1mbold${RESET} ${fg(203)}red${RESET} ${fg(114)}green${RESET} ${fg(75)}blue${RESET} ${ESC}[2mdim${RESET} — mixed weights\r\n`
// Box drawing is the other thing only a screenshot can settle. The characters
// are drawn as geometry against the cell rather than taken from the font (see
// boxDrawing.ts), and the whole point of doing that is seams: whether the
// vertical rules of a border meet the row beneath, and whether a weight change
// or an arc lands on the same axis as the straight rule above it. No per-cell
// assertion can see any of that.
out += `\r\n  box drawing — geometry, not glyphs. Look for seams between rows.\r\n`
out += `  ┌─┬─┐ ┏━┳━┓ ╔═╦═╗ ╭───╮   ┌─────┐\r\n`
out += `  ├─┼─┤ ┣━╋━┫ ╠═╬═╣ │   │   │     │\r\n`
out += `  └─┴─┘ ┗━┻━┛ ╚═╩═╝ ╰───╯   └─────┘\r\n`
out += `  mixed ╞═╡ ╤╥╧╨ ╪╫   dashed ┄┈╌ ┆┊╎   weights ╼╾ ╴╵╶╷\r\n`
out += `  blocks █▇▆▅▄▃▂▁ ▉▊▋▌▍▎▏  shades ░▒▓  quads ▖▗▘▝▞▟\r\n`
out += `  powerline \u{e0b0}\u{e0b1}\u{e0b2}\u{e0b3}\u{e0b4}\u{e0b5}\u{e0b6}\u{e0b7}   diagonals ╱╲╳\r\n`
out += `  angled \u{e0b8}\u{e0b9}\u{e0ba}\u{e0bb}\u{e0bc}\u{e0bd}\u{e0be}\u{e0bf}   eighths \u{1fb70}\u{1fb71}\u{1fb72}\u{1fb73}\u{1fb74}\u{1fb75} \u{1fb76}\u{1fb77}\u{1fb78}\u{1fb79}\u{1fb7a}\u{1fb7b}\r\n`
// A 2x3 mosaic, so a row of them reads as one picture rather than as a row of
// characters — which is the only way to see whether the subcells tile.
out += `  sextants \u{1fb00}\u{1fb01}\u{1fb02}\u{1fb03}\u{1fb04}\u{1fb05}\u{1fb06}\u{1fb07}\u{1fb08}\u{1fb09}\u{1fb0a}\u{1fb0b}\u{1fb0c}\u{1fb0d}\u{1fb0e}\u{1fb0f}\r\n`
// The three rows of the mosaic, four cells of each: they should read as three
// unbroken bars at three heights, which is the tiling claim made visible.
out += `           \u{1fb02}\u{1fb02}\u{1fb02}\u{1fb02} \u{1fb0b}\u{1fb0b}\u{1fb0b}\u{1fb0b} \u{1fb2d}\u{1fb2d}\u{1fb2d}\u{1fb2d}  corners \u{1fb7c}\u{1fb7d}\u{1fb7e}\u{1fb7f}\r\n`

// Ligatures are off unless asked for, and need a face that has them — so this
// line says nothing on its own. It is here to be compared against itself with
// `l` pressed, which is the only way to see that the shaping happened.
out += `\r\n  ligatures — press l to toggle, ?font= to pick a face that has them\r\n`
out += `  -> => <- <= >= != == === !== <=> |> <| :: ++ // /* */ ~= |= &&\r\n`
out += `  ${ESC}[1m-> => != ===${RESET} bold  ${fg(203)}-> => != ===${RESET} coloured\r\n`

out += `\r\n  cursor is here ->${ESC}[5 q `
engine.write(out)

// A face with ligatures in it, for the line above. Named in the URL rather
// than hardcoded because which ones are installed varies per machine, and the
// point of the line is to compare one face against another.
const wantedFont = new URLSearchParams(location.search).get('font')
// ?features= rides along with it, so the OpenType descriptor path can be
// looked at too -- try `?font=Cascadia Code&features="calt" 0`, which should
// render the ligature line unligated even with ligatures switched on.
const wantedFeatures = new URLSearchParams(location.search).get('features') ?? ''
if (wantedFont || wantedFeatures) {
  const family = wantedFont ? `"${wantedFont}", ui-monospace, monospace` : 'Consolas, monospace'
  engine.setFont(
    buildFontSelection({
      fontFamily: family,
      fontFamilyBold: '',
      fontFamilyItalic: '',
      fontFamilyBoldItalic: '',
      fontFeatures: wantedFeatures,
      fontRanges: [],
    }),
    14,
  )
}

// Same argument as text blending below: run shaping changes only which glyphs
// come out of the atlas, so no per-cell assertion can see it and a screenshot
// of one state alone says nothing. Toggling it in place is what makes the
// difference legible.
let ligatures = new URLSearchParams(location.search).get('ligatures') === '1'
engine.setLigatures(ligatures)

// Text blending is the reason a file like this exists: it changes only how
// partially-covered pixels are drawn, so no per-cell assertion can see it and
// a screenshot of one mode alone says nothing. Cycling it in place is what
// makes the difference legible — same glyphs, same atlas, one uniform apart.
const BLENDS: [label: string, mode: TextBlending][] = [
  ['native — sRGB, the default', 'native'],
  ['linear — physically correct, changes weight', 'linear'],
  ['linear-corrected — linear at native weight', 'linear-corrected'],
]
// Also selectable as ?blend=N, so a screenshot of a given mode can be taken
// without a keystroke — which is the only way to capture one from a headless
// browser, and the only way two modes can be diffed as images.
const requested = Number(new URLSearchParams(location.search).get('blend'))
let blendIndex = Number.isInteger(requested) && BLENDS[requested] ? requested : 0
const blendLabel = document.getElementById('blend')
function applyBlend() {
  const [label, mode] = BLENDS[blendIndex]
  engine.setTextBlending(mode)
  if (blendLabel) blendLabel.textContent = label
}
applyBlend()

// Typing a digit re-issues the matching DECSCUSR so every shape can be seen
// without editing this file. `h` stands in for the app's Ctrl+Shift+U, which
// is bound in Terminal.tsx rather than in the engine.
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
