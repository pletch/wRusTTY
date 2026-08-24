// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { fileStem, parseThemeFile } from './themeImport'
import { PRESET_THEMES, THEME_COLOR_KEYS, hexToRgb } from './theme'

/** One iTerm colour dict, in the shape and key order iTerm writes. */
function itermColor(r: number, g: number, b: number, space = 'sRGB') {
  return `
	<dict>
		<key>Alpha Component</key>
		<real>1</real>
		<key>Blue Component</key>
		<real>${b}</real>
		<key>Color Space</key>
		<string>${space}</string>
		<key>Green Component</key>
		<real>${g}</real>
		<key>Red Component</key>
		<real>${r}</real>
	</dict>`
}

function itermFile(entries: Record<string, string>) {
  const body = Object.entries(entries)
    .map(([key, value]) => `\t<key>${key}</key>${value}`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>`
}

/** A full sixteen-colour plist, so tests that care about one thing do not
 *  each have to write out the other eighteen. */
function fullItermFile(space = 'sRGB') {
  const entries: Record<string, string> = {
    'Background Color': itermColor(0, 0, 0, space),
    'Foreground Color': itermColor(1, 1, 1, space),
    'Cursor Color': itermColor(1, 1, 1, space),
  }
  for (let i = 0; i < 16; i++) {
    entries[`Ansi ${i} Color`] = itermColor(i / 15, 0.5, 0.25, space)
  }
  return itermFile(entries)
}

describe('parseThemeFile, iTerm2', () => {
  it('reads the palette into the slots every terminal numbers them by', () => {
    const { theme, format } = parseThemeFile(fullItermFile(), 'Scheme')
    expect(format).toBe('iTerm2')
    // Ansi 0-7 are the normal slots, 8-15 the bright ones. Red channel is
    // i/15 in the fixture, so each slot pins which index it came from.
    expect(hexToRgb(theme.black)[0]).toBe(0)
    expect(hexToRgb(theme.white)[0]).toBe(Math.round((7 / 15) * 255))
    expect(hexToRgb(theme.brightBlack)[0]).toBe(Math.round((8 / 15) * 255))
    expect(hexToRgb(theme.brightWhite)[0]).toBe(255)
  })

  it('converts 0-1 components to hex', () => {
    const file = itermFile({ 'Background Color': itermColor(1, 0.5, 0) })
    expect(parseThemeFile(file, 'Scheme').theme.background).toBe('#ff8000')
  })

  it('takes the file name, since an itermcolors file carries none', () => {
    const file = itermFile({ 'Background Color': itermColor(0, 0, 0) })
    expect(parseThemeFile(file, 'Solarized Dark').theme.name).toBe('Solarized Dark')
  })

  it('fills the colours the file leaves out, and says which', () => {
    // Real schemes routinely omit the cursor, and iTerm files never carry a
    // slot for anything this app calls a surface.
    const file = itermFile({ 'Background Color': itermColor(0, 0, 0) })
    const { theme, missing } = parseThemeFile(file, 'Scheme')
    expect(theme.background).toBe('#000000')
    expect(theme.red).toBe(PRESET_THEMES[0].red)
    expect(missing).toContain('red')
    expect(missing).not.toContain('background')
    expect(missing).toHaveLength(THEME_COLOR_KEYS.length - 1)
  })

  it('leaves a neutral grey exactly itself when converting from P3', () => {
    // The one conversion result checkable without a colorimeter: the two
    // spaces share a white point, so the matrix rows sum to 1 and the greys
    // are invariant. A transposed or mistyped matrix breaks this.
    //
    // 0.6 rather than 0.5 deliberately. Half lands on 127.5 exactly, where
    // the last bit of float error in a row that sums to 0.9999999999999997
    // decides which way the channel rounds -- so a correct matrix fails, for
    // a reason that has nothing to do with colour.
    const file = itermFile({ 'Background Color': itermColor(0.6, 0.6, 0.6, 'P3') })
    const [r, g, b] = hexToRgb(parseThemeFile(file, 'Scheme').theme.background)
    expect(r).toBe(g)
    expect(g).toBe(b)
    expect(r).toBe(153)
  })

  it('pushes an in-gamut P3 colour outward rather than passing the numbers through', () => {
    // The same components read as sRGB would be a flatter green. sRGB has
    // the smaller gamut, so expressing the same colour in it takes more
    // extreme coordinates -- red down, green up. Checking the direction is
    // what catches a matrix applied backwards, which a single value cannot.
    const asP3 = hexToRgb(
      parseThemeFile(itermFile({ 'Background Color': itermColor(0.5, 0.7, 0.5, 'P3') }), 'S').theme
        .background,
    )
    const asSrgb = hexToRgb(
      parseThemeFile(itermFile({ 'Background Color': itermColor(0.5, 0.7, 0.5) }), 'S').theme
        .background,
    )
    expect(asP3).not.toEqual(asSrgb)
    expect(asP3[0]).toBeLessThan(asSrgb[0])
    expect(asP3[1]).toBeGreaterThan(asSrgb[1])
  })

  it('clamps a P3 primary to the sRGB one it has no room for', () => {
    // Pure P3 green is outside sRGB entirely, so there is no answer except
    // the nearest edge -- which lands exactly on sRGB's own green. Pinned
    // because it looks like the conversion did nothing, and it is worth
    // knowing that is the clamp rather than a missed colour space.
    const file = itermFile({ 'Background Color': itermColor(0, 1, 0, 'P3') })
    expect(parseThemeFile(file, 'S').theme.background).toBe('#00ff00')
  })

  it('treats an unmarked or Calibrated colour as sRGB', () => {
    const unmarked = itermFile({
      'Background Color': `<dict><key>Red Component</key><real>0.5</real><key>Green Component</key><real>0.5</real><key>Blue Component</key><real>0.5</real></dict>`,
    })
    const calibrated = itermFile({ 'Background Color': itermColor(0.5, 0.5, 0.5, 'Calibrated') })
    expect(parseThemeFile(unmarked, 'S').theme.background).toBe('#808080')
    expect(parseThemeFile(calibrated, 'S').theme.background).toBe('#808080')
  })

  it('accepts an integer component', () => {
    const file = itermFile({
      'Background Color': `<dict><key>Red Component</key><integer>1</integer><key>Green Component</key><integer>0</integer><key>Blue Component</key><integer>0</integer></dict>`,
    })
    expect(parseThemeFile(file, 'S').theme.background).toBe('#ff0000')
  })

  it('skips a colour whose components are missing rather than importing NaN', () => {
    const file = itermFile({
      'Background Color': `<dict><key>Red Component</key><real>1</real></dict>`,
      'Foreground Color': itermColor(1, 1, 1),
    })
    const { theme, missing } = parseThemeFile(file, 'S')
    expect(theme.background).toBe(PRESET_THEMES[0].background)
    expect(missing).toContain('background')
  })

  it('rejects XML that is not a plist', () => {
    expect(() => parseThemeFile('<html><body>hi</body></html>', 'S')).toThrow(
      /isn't an iTerm colour scheme/,
    )
  })

  it('rejects malformed XML by name', () => {
    expect(() => parseThemeFile('<plist><dict>', 'S')).toThrow(/valid XML/)
  })

  it('rejects a plist that names no terminal colours', () => {
    const file = itermFile({ 'Selection Color': itermColor(1, 1, 1) })
    expect(() => parseThemeFile(file, 'S')).toThrow(/doesn't contain any terminal colours/)
  })
})

describe('parseThemeFile, VS Code', () => {
  const colors = {
    'terminal.background': '#1e1e1e',
    'terminal.foreground': '#cccccc',
    'terminalCursor.foreground': '#ffffff',
    'terminal.ansiBlack': '#000000',
    'terminal.ansiRed': '#cd3131',
    'terminal.ansiBrightRed': '#f14c4c',
  }

  it('reads a published theme, which puts them under `colors`', () => {
    const file = JSON.stringify({ name: 'Dark+', colors })
    const { theme, format } = parseThemeFile(file, 'file-name')
    expect(format).toBe('VS Code')
    expect(theme.background).toBe('#1e1e1e')
    expect(theme.red).toBe('#cd3131')
    expect(theme.brightRed).toBe('#f14c4c')
    expect(theme.cursor).toBe('#ffffff')
  })

  it("prefers the theme's own name over the file name", () => {
    const file = JSON.stringify({ name: 'Dark+', colors })
    expect(parseThemeFile(file, 'file-name').theme.name).toBe('Dark+')
  })

  it('falls back to the file name when the theme is unnamed', () => {
    expect(parseThemeFile(JSON.stringify({ colors }), 'file-name').theme.name).toBe('file-name')
  })

  it('reads a settings.json, which puts them under workbench.colorCustomizations', () => {
    const file = JSON.stringify({
      'editor.fontSize': 14,
      'workbench.colorCustomizations': colors,
    })
    expect(parseThemeFile(file, 'settings').theme.red).toBe('#cd3131')
  })

  it('reads a bare map of colours', () => {
    expect(parseThemeFile(JSON.stringify(colors), 'pasted').theme.red).toBe('#cd3131')
  })

  it('skips an empty `colors` in favour of the customizations that hold something', () => {
    // A settings.json can carry both; taking the first key that *exists*
    // rather than the first that holds a colour would import nothing.
    const file = JSON.stringify({ colors: {}, 'workbench.colorCustomizations': colors })
    expect(parseThemeFile(file, 'settings').theme.red).toBe('#cd3131')
  })

  it("takes the editor's colours when the theme leaves the terminal's out", () => {
    // Most themes do. Without this the import comes back with the default
    // theme's background and looks nothing like the theme it claims to be.
    const file = JSON.stringify({
      colors: {
        'editor.background': '#282c34',
        'editor.foreground': '#abb2bf',
        'editorCursor.foreground': '#528bff',
        'terminal.ansiRed': '#e06c75',
      },
    })
    const { theme } = parseThemeFile(file, 'One Dark')
    expect(theme.background).toBe('#282c34')
    expect(theme.foreground).toBe('#abb2bf')
    expect(theme.cursor).toBe('#528bff')
  })

  it('prefers an explicit terminal colour over the editor fallback', () => {
    const file = JSON.stringify({
      colors: { 'editor.background': '#282c34', 'terminal.background': '#1e1e1e' },
    })
    expect(parseThemeFile(file, 'T').theme.background).toBe('#1e1e1e')
  })

  it('expands the short hex forms and drops alpha', () => {
    const file = JSON.stringify({
      colors: {
        'terminal.ansiRed': '#F00',
        'terminal.ansiGreen': '#0f08',
        'terminal.ansiBlue': '#0000FFCC',
        'terminal.background': '#ABCDEF',
      },
    })
    const { theme } = parseThemeFile(file, 'T')
    expect(theme.red).toBe('#ff0000')
    expect(theme.green).toBe('#00ff00')
    expect(theme.blue).toBe('#0000ff')
    expect(theme.background).toBe('#abcdef')
  })

  it('ignores a colour that is not a hex string', () => {
    const file = JSON.stringify({
      colors: { 'terminal.ansiRed': 'red', 'terminal.ansiGreen': 42, 'terminal.ansiBlue': '#00f' },
    })
    const { theme, missing } = parseThemeFile(file, 'T')
    expect(theme.red).toBe(PRESET_THEMES[0].red)
    expect(missing).toContain('red')
    expect(missing).toContain('green')
    expect(theme.blue).toBe('#0000ff')
  })

  it('reads the JSONC that VS Code actually writes', () => {
    const file = `{
      // the theme's name
      "name": "Commented",
      "colors": {
        /* block comment */
        "terminal.ansiRed": "#cd3131",
        "terminal.ansiBlue": "#2472c8",
      },
    }`
    const { theme } = parseThemeFile(file, 'T')
    expect(theme.name).toBe('Commented')
    expect(theme.red).toBe('#cd3131')
    expect(theme.blue).toBe('#2472c8')
  })

  it('leaves comment markers inside strings alone', () => {
    // The reason the stripper tracks strings instead of using a regex: a
    // theme carrying a URL is entirely ordinary.
    const file = JSON.stringify({
      name: 'See https://example.com/theme, or not',
      colors: { 'terminal.ansiRed': '#cd3131' },
    })
    const { theme } = parseThemeFile(file, 'T')
    expect(theme.name).toBe('See https://example.com/theme, or not')
    expect(theme.red).toBe('#cd3131')
  })

  it('rejects invalid JSON with the parser’s own complaint', () => {
    expect(() => parseThemeFile('{ "colors": ', 'T')).toThrow(/isn't valid JSON/)
  })

  it('rejects JSON that is not an object', () => {
    expect(() => parseThemeFile('[1, 2, 3]', 'T')).toThrow(/isn't a VS Code theme/)
  })

  it('rejects an object naming no terminal colours', () => {
    const file = JSON.stringify({ name: 'Nothing', colors: { 'statusBar.background': '#000000' } })
    expect(() => parseThemeFile(file, 'T')).toThrow(/doesn't contain any terminal colours/)
  })
})

describe('parseThemeFile', () => {
  it('rejects an empty file', () => {
    expect(() => parseThemeFile('   \n  ', 'T')).toThrow(/empty/)
  })

  it('picks the format from the content, not the file name', () => {
    // A scheme downloaded as .txt, or renamed, is still readable.
    const plist = itermFile({ 'Background Color': itermColor(0, 0, 0) })
    expect(parseThemeFile(plist, 'theme.json').format).toBe('iTerm2')
    expect(parseThemeFile(JSON.stringify({ colors: { 'terminal.ansiRed': '#f00' } }), 'x.itermcolors').format).toBe(
      'VS Code',
    )
  })

  it('always returns a complete palette', () => {
    // Whatever the file held, what comes out has to be renderable -- the
    // importer feeds the same editor and the same storage as everything else.
    const file = itermFile({ 'Background Color': itermColor(0.1, 0.2, 0.3) })
    const { theme } = parseThemeFile(file, 'Sparse')
    for (const key of THEME_COLOR_KEYS) {
      expect(theme[key]).toMatch(/^#[0-9a-f]{6}$/)
    }
    expect(theme.name).toBe('Sparse')
  })
})

describe('fileStem', () => {
  it('takes the name out of a Windows path', () => {
    // The only platform this app ships on, and the separator an OS file
    // dialog hands back here. A character class that had lost its backslash
    // returned the whole path as the theme name, which is the sort of wrong
    // that looks like it works until you read the picker.
    expect(fileStem(String.raw`C:\Users\Tim\Downloads\Solarized Dark.itermcolors`)).toBe(
      'Solarized Dark',
    )
  })

  it('takes the name out of a forward-slash path', () => {
    expect(fileStem('/home/tim/themes/Nord.json')).toBe('Nord')
  })

  it('handles a bare file name', () => {
    expect(fileStem('Dracula.itermcolors')).toBe('Dracula')
  })

  it('keeps a name that has no extension', () => {
    expect(fileStem(String.raw`C:\themes\Dracula`)).toBe('Dracula')
  })

  it('keeps everything before the last dot', () => {
    expect(fileStem('Tokyo Night.storm.json')).toBe('Tokyo Night.storm')
  })

  it('keeps a dotfile name rather than emptying it', () => {
    // `.itermcolors` with no stem at all: stripping the extension leaves
    // nothing, and a nameless theme is one findTheme can never resolve.
    expect(fileStem('/themes/.itermcolors')).toBe('.itermcolors')
  })
})
