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
out += `\r\n  cursor is here ->${ESC}[5 q `
engine.write(out)

// Typing a digit re-issues the matching DECSCUSR so every shape can be seen
// without editing this file. `h` stands in for the app's Ctrl+Shift+U, which
// is bound in Terminal.tsx rather than in the engine.
window.addEventListener('keydown', (e) => {
  if (e.key >= '1' && e.key <= '6') engine.write(`${ESC}[${e.key} q`)
  if (e.key === 'h') engine.toggleHintMode()
})
