import { PRESET_THEMES, THEME_COLOR_KEYS, type TerminalTheme, type ThemeColorKey } from './theme'

/**
 * Reading a colour scheme written for iTerm2 or VS Code.
 *
 * Pure text in, palette out — no file dialog, no IPC. That is what lets the
 * awkward half of this be tested against real files' shapes rather than
 * driven through a window, and the awkward half is all of it: both formats
 * are things other programs write for their own purposes, and neither owes
 * this app a complete palette.
 *
 * The rule throughout is to take what is there and fill the rest from the
 * default theme, reporting which ones were filled. A scheme that names
 * fourteen of the nineteen colours is a scheme worth importing; refusing it
 * would be refusing most of what people actually have.
 */

/** The formats this understands, as named in messages to the user. */
export type ThemeFormat = 'iTerm2' | 'VS Code'

export interface ParsedTheme {
  /** Complete and ready to use — see `missing` for what came from the file. */
  theme: TerminalTheme
  /** Colours the file did not name, filled from the default theme. */
  missing: ThemeColorKey[]
  format: ThemeFormat
}

/** Which theme fills a gap. The default, for the same reason
 *  `sanitizeCustomThemes` uses it: it is the one palette known to be
 *  complete and known to work. */
const FALLBACK = PRESET_THEMES[0]

type PartialPalette = Partial<Record<ThemeColorKey, string>>

/**
 * Reads `text` as whichever of the two formats it turns out to be.
 *
 * Sniffed from the content rather than taken from the extension, because a
 * file that has been renamed, downloaded as `.txt`, or saved out of a
 * browser is still perfectly readable and the extension is the thing most
 * likely to be wrong about it.
 *
 * `fallbackName` is used when the file carries no name of its own, which is
 * every `.itermcolors` and many VS Code themes — the file name is the only
 * name those have ever had.
 *
 * Throws with a message meant for a toast: this is driven by someone
 * choosing a file, so every failure is a thing they can act on.
 */
export function parseThemeFile(text: string, fallbackName: string): ParsedTheme {
  const trimmed = text.trim()
  if (trimmed === '') throw new Error('that file is empty')

  const { name, colors, format } = trimmed.startsWith('<')
    ? { ...parseItermColors(trimmed), format: 'iTerm2' as const }
    : { ...parseVsCodeTheme(trimmed), format: 'VS Code' as const }

  const named = THEME_COLOR_KEYS.filter((key) => colors[key] !== undefined)
  // A file can parse perfectly and still not be a colour scheme -- any XML
  // is a plist to the parser, and any object is a VS Code theme. Having
  // named no colour at all is what distinguishes the two, and it is worth a
  // clearer message than nineteen silent fallbacks.
  if (named.length === 0) {
    throw new Error(`that ${format} file doesn't contain any terminal colours`)
  }

  const theme = { name: name?.trim() || fallbackName } as TerminalTheme
  for (const key of THEME_COLOR_KEYS) theme[key] = colors[key] ?? FALLBACK[key]
  return {
    theme,
    missing: THEME_COLOR_KEYS.filter((key) => colors[key] === undefined),
    format,
  }
}

/**
 * A path's file name without its extension — the name an imported theme
 * takes when the file does not carry one of its own, which is every
 * `.itermcolors`.
 *
 * Split on both separators: the path comes back from the OS dialog, so on
 * Windows it arrives with backslashes, and a scheme dragged in from a WSL
 * or network path can carry forward ones in the same string.
 */
export function fileStem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  return base.replace(/\.[^.]*$/, '') || base
}

// --- iTerm2 -----------------------------------------------------------------

/**
 * Which plist key feeds which slot.
 *
 * `Ansi 0`–`15` are the palette in the order every terminal numbers it, so
 * the eight normal slots then the eight bright ones. iTerm files carry a
 * good deal more than this — selection, badge, bold and link colours, and
 * a second set for light mode — none of which this app has anywhere to put.
 */
const ITERM_KEYS: ReadonlyArray<readonly [plistKey: string, slot: ThemeColorKey]> = [
  ['Background Color', 'background'],
  ['Foreground Color', 'foreground'],
  ['Cursor Color', 'cursor'],
  ['Ansi 0 Color', 'black'],
  ['Ansi 1 Color', 'red'],
  ['Ansi 2 Color', 'green'],
  ['Ansi 3 Color', 'yellow'],
  ['Ansi 4 Color', 'blue'],
  ['Ansi 5 Color', 'magenta'],
  ['Ansi 6 Color', 'cyan'],
  ['Ansi 7 Color', 'white'],
  ['Ansi 8 Color', 'brightBlack'],
  ['Ansi 9 Color', 'brightRed'],
  ['Ansi 10 Color', 'brightGreen'],
  ['Ansi 11 Color', 'brightYellow'],
  ['Ansi 12 Color', 'brightBlue'],
  ['Ansi 13 Color', 'brightMagenta'],
  ['Ansi 14 Color', 'brightCyan'],
  ['Ansi 15 Color', 'brightWhite'],
]

function parseItermColors(text: string): { name?: string; colors: PartialPalette } {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  // How every DOM XML parser reports a syntax error: no exception, a
  // document containing this element instead.
  if (doc.querySelector('parsererror')) {
    throw new Error("that file isn't valid XML, so it isn't an iTerm colour scheme")
  }
  const root = doc.querySelector('plist > dict')
  if (!root) throw new Error("that XML file isn't an iTerm colour scheme")

  const entries = plistEntries(root)
  const colors: PartialPalette = {}
  for (const [plistKey, slot] of ITERM_KEYS) {
    const value = entries.get(plistKey)
    const rgb = value ? plistColor(value) : null
    if (rgb) colors[slot] = rgb
  }
  // `.itermcolors` files carry no name of their own -- iTerm names a scheme
  // by its file name, and so does this.
  return { colors }
}

/**
 * A plist `<dict>`'s children as a map.
 *
 * A plist dict is a *flat* run of alternating key and value elements rather
 * than anything nested, so the value for a key is simply the element after
 * it. Walking the pairs is the whole of reading one.
 */
function plistEntries(dict: Element): Map<string, Element> {
  const out = new Map<string, Element>()
  const children = Array.from(dict.children)
  for (let i = 0; i < children.length; i++) {
    if (children[i].tagName !== 'key') continue
    const value = children[i + 1]
    const key = children[i].textContent?.trim()
    // A trailing `<key>` with nothing after it is malformed rather than
    // fatal: skip the pair and let the caller find the colour missing.
    if (key && value) out.set(key, value)
  }
  return out
}

/** One iTerm colour dict as `#rrggbb`, or null if it is not one. */
function plistColor(value: Element): string | null {
  const parts = plistEntries(value)
  const channels = ['Red Component', 'Green Component', 'Blue Component'].map((key) => {
    const el = parts.get(key)
    // `<real>` in every file seen, but `<integer>` is legal plist for an
    // exact 0 or 1 and costs nothing to accept.
    if (!el || (el.tagName !== 'real' && el.tagName !== 'integer')) return NaN
    return Number(el.textContent)
  })
  if (channels.some((c) => !Number.isFinite(c))) return null

  // iTerm records the space each colour was authored in. Display P3 numbers
  // read as sRGB would come out visibly desaturated -- the same coordinates
  // cover more colour in the wider space -- so they are converted. Anything
  // else, including the older "Calibrated" (Apple's generic RGB, gamma 1.8),
  // is taken as sRGB: converting that properly needs a different transfer
  // curve and the files that carry it are decades of terminal schemes
  // authored as hex anyway, where sRGB is what the author meant.
  const space = parts.get('Color Space')?.textContent?.trim()
  const [r, g, b] = space === 'P3' ? p3ToSrgb(channels as [number, number, number]) : channels
  return rgbToHex(r, g, b)
}

/**
 * Display P3 to sRGB, both as 0–1 components with the sRGB transfer curve
 * (which P3 shares — only the primaries differ).
 *
 * Linearize, apply the standard matrix, re-encode. Out-of-gamut results are
 * clamped: P3 is the wider space, so its saturated corners have no sRGB
 * equivalent and the nearest edge is the only answer available.
 *
 * Each row of the matrix sums to 1, which is why a neutral grey stays
 * exactly itself — the two spaces share a white point. `themeImport.test.ts`
 * pins that, since it is the one result checkable without a colorimeter.
 */
function p3ToSrgb([r, g, b]: [number, number, number]): [number, number, number] {
  const [lr, lg, lb] = [r, g, b].map(srgbToLinear)
  // Nine significant figures, not the fifteen the matrix is usually quoted
  // to: a double cannot hold those exactly, and the digits past here are
  // several orders of magnitude below one step of an 8-bit channel. Rounding
  // them also makes the first two rows sum to exactly 1, which is what keeps
  // a grey a grey rather than a grey plus float dust.
  return [
    1.22494018 * lr - 0.22494018 * lg,
    -0.04205695 * lr + 1.04205695 * lg,
    -0.01963766 * lr - 0.07863611 * lg + 1.09827378 * lb,
  ].map((channel) => linearToSrgb(Math.min(1, Math.max(0, channel)))) as [number, number, number]
}

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

function linearToSrgb(channel: number): number {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055
}

/** 0–1 components as `#rrggbb`, clamped and rounded. */
function rgbToHex(r: number, g: number, b: number): string {
  const byte = (channel: number) =>
    Math.min(255, Math.max(0, Math.round(channel * 255)))
      .toString(16)
      .padStart(2, '0')
  return `#${byte(r)}${byte(g)}${byte(b)}`
}

// --- VS Code ----------------------------------------------------------------

/** Which workbench colour feeds which slot. */
const VSCODE_KEYS: ReadonlyArray<readonly [colorKey: string, slot: ThemeColorKey]> = [
  ['terminal.background', 'background'],
  ['terminal.foreground', 'foreground'],
  ['terminalCursor.foreground', 'cursor'],
  ['terminal.ansiBlack', 'black'],
  ['terminal.ansiRed', 'red'],
  ['terminal.ansiGreen', 'green'],
  ['terminal.ansiYellow', 'yellow'],
  ['terminal.ansiBlue', 'blue'],
  ['terminal.ansiMagenta', 'magenta'],
  ['terminal.ansiCyan', 'cyan'],
  ['terminal.ansiWhite', 'white'],
  ['terminal.ansiBrightBlack', 'brightBlack'],
  ['terminal.ansiBrightRed', 'brightRed'],
  ['terminal.ansiBrightGreen', 'brightGreen'],
  ['terminal.ansiBrightYellow', 'brightYellow'],
  ['terminal.ansiBrightBlue', 'brightBlue'],
  ['terminal.ansiBrightMagenta', 'brightMagenta'],
  ['terminal.ansiBrightCyan', 'brightCyan'],
  ['terminal.ansiBrightWhite', 'brightWhite'],
]

/**
 * Where the terminal colours sit when the theme does not name them
 * directly. Most VS Code themes leave `terminal.background` out and let the
 * terminal take the editor's, which is what the editor itself does — so a
 * theme imported without this would come back with the default theme's
 * background rather than its own, and look nothing like the theme it says
 * it is.
 */
const VSCODE_FALLBACKS: ReadonlyArray<readonly [colorKey: string, slot: ThemeColorKey]> = [
  ['editor.background', 'background'],
  ['editor.foreground', 'foreground'],
  ['editorCursor.foreground', 'cursor'],
]

function parseVsCodeTheme(text: string): { name?: string; colors: PartialPalette } {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonComments(text))
  } catch (err) {
    throw new Error(`that file isn't valid JSON: ${err instanceof Error ? err.message : err}`, {
      cause: err,
    })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error("that JSON file isn't a VS Code theme")
  }
  const root = parsed as Record<string, unknown>

  // Three shapes reach this. A published theme puts them under `colors`; a
  // user's settings.json puts them under `workbench.colorCustomizations`;
  // and a snippet someone pasted into a file is just the map itself. Taking
  // the first that actually holds a colour, rather than the first that
  // exists, is what makes a settings.json with an empty `colors` key work.
  const candidates = [root.colors, root['workbench.colorCustomizations'], root]
  const source =
    candidates.find(
      (candidate): candidate is Record<string, unknown> =>
        typeof candidate === 'object' &&
        candidate !== null &&
        !Array.isArray(candidate) &&
        Object.keys(candidate).some((key) => key.startsWith('terminal') || key.startsWith('editor')),
    ) ?? {}

  const colors: PartialPalette = {}
  for (const [colorKey, slot] of VSCODE_KEYS) {
    const hex = normalizeHex(source[colorKey])
    if (hex) colors[slot] = hex
  }
  for (const [colorKey, slot] of VSCODE_FALLBACKS) {
    if (colors[slot] !== undefined) continue
    const hex = normalizeHex(source[colorKey])
    if (hex) colors[slot] = hex
  }
  return { name: typeof root.name === 'string' ? root.name : undefined, colors }
}

/**
 * A VS Code colour as `#rrggbb`.
 *
 * All four hex forms it allows, with any alpha dropped rather than blended:
 * these land in a palette slot that has no alpha, and a translucent ANSI red
 * is still red. The one place that loses something real is a translucent
 * `terminal.background`, where VS Code would be showing the editor through
 * it — there is nothing behind a terminal background here to show.
 */
function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const hex = value.trim()
  if (/^#[0-9a-fA-F]{3,4}$/.test(hex)) {
    const [r, g, b] = [hex[1], hex[2], hex[3]]
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }
  if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) return hex.slice(0, 7).toLowerCase()
  return null
}

/**
 * JSON with comments and trailing commas taken out — the dialect VS Code
 * actually writes, and the one every theme downloaded from a repository is
 * in. `JSON.parse` rejects both outright.
 *
 * One pass, tracking whether it is inside a string, because both of the
 * shortcuts here are wrong: a regex for `//` deletes the middle of
 * `"https://..."`, and a regex for `,\s*}` mangles a string that contains
 * one. Trailing commas are dropped on the way out rather than in a second
 * pass for that same reason.
 */
function stripJsonComments(text: string): string {
  const out: string[] = []
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]

    if (inString) {
      out.push(char)
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }

    if (char === '"') {
      inString = true
      out.push(char)
      continue
    }
    if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      // Keep the newline itself: it is what keeps reported error positions
      // on the line the mistake is actually on.
      out.push('\n')
      continue
    }
    if (char === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
      continue
    }
    if (char === '}' || char === ']') {
      // Walk back over whatever whitespace was emitted since the last real
      // character; if it was a comma, it was a trailing one.
      let last = out.length - 1
      while (last >= 0 && /\s/.test(out[last])) last--
      if (last >= 0 && out[last] === ',') out.splice(last, 1)
    }
    out.push(char)
  }
  return out.join('')
}
