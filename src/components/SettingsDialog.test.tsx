// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DescriptorNote, FamilySelect, NamedFaceReport } from './SettingsDialog'
import { loadSettings, type TerminalSettings } from '../lib/settings'

/**
 * The one part of the font settings nobody can reach by hand.
 *
 * The face and range pickers only offer families this machine has, so a name
 * that resolves to nothing arrives from a settings file written on another
 * machine — which means the warning about it can never be seen while working
 * on it, and would rot silently. Hence a test rather than a screenshot.
 */

/** Stands in for the CSS Font Loading API, which jsdom does not implement.
 *  `installed` is what this machine is pretending to have. */
function stubFontCheck(installed: string[] | null) {
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value:
      installed === null
        ? {}
        : {
            check: (font: string) => {
              const m = font.match(/"([^"]+)"/)
              return m ? installed.includes(m[1]) : false
            },
          },
  })
}

function settings(over: Partial<TerminalSettings> = {}): TerminalSettings {
  return { ...loadSettings(), ...over }
}

beforeEach(() => {
  stubFontCheck(['Consolas', 'Cascadia Code'])
})
afterEach(cleanup)

describe('DescriptorNote', () => {
  // The fallback for a string the parser rejects is to drop it whole, which is
  // what CSS does with any declaration it cannot read. The font still renders;
  // it just renders as though the setting were not there. From the outside
  // that is indistinguishable from the font not having the feature, which is
  // the reason to say something.
  function stubSupports(ok: boolean) {
    vi.stubGlobal('CSS', { supports: () => ok })
  }

  it('says nothing about a value the parser accepts', () => {
    stubSupports(true)
    const { container } = render(
      <DescriptorNote property="font-feature-settings" value={'"ss01" 1'} />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('says nothing about an empty field, which is unset rather than wrong', () => {
    stubSupports(false)
    const { container } = render(<DescriptorNote property="font-feature-settings" value="" />)
    expect(container.innerHTML).toBe('')
  })

  it('names the property and says the value is being ignored', () => {
    stubSupports(false)
    render(<DescriptorNote property="font-feature-settings" value="ss01 = on" />)
    expect(screen.getByText(/font-feature-settings/)).toBeTruthy()
    expect(screen.getByText(/all of it is/)).toBeTruthy()
  })

  it('speaks for the variation axes under their own name', () => {
    stubSupports(false)
    render(<DescriptorNote property="font-variation-settings" value="wdth 75" />)
    expect(screen.getByText(/font-variation-settings/)).toBeTruthy()
  })

  it('says nothing when there is no parser to ask', () => {
    vi.stubGlobal('CSS', undefined)
    const { container } = render(
      <DescriptorNote property="font-feature-settings" value="ss01 = on" />,
    )
    expect(container.innerHTML).toBe('')
  })
})

describe('FamilySelect without enumeration', () => {
  // list_fonts answers through DirectWrite and returns an empty list off
  // Windows. A select over nothing cannot express a family at all, so the
  // control has to become one that can -- storing exactly what the select
  // would have stored.
  const noop = () => {}

  it('offers a select when there are families to choose from', () => {
    const { container } = render(
      <FamilySelect value="" onPick={noop} families={['Consolas']} emptyLabel="Body font" />,
    )
    expect(container.querySelector('select')).toBeTruthy()
    expect(container.querySelector('input')).toBeNull()
  })

  it('falls back to a field when nothing could be enumerated', () => {
    const { container } = render(
      <FamilySelect value="" onPick={noop} families={[]} emptyLabel="Body font" />,
    )
    expect(container.querySelector('input')).toBeTruthy()
    expect(container.querySelector('select')).toBeNull()
  })

  it('shows a stored family unquoted, the way it is written', () => {
    render(
      <FamilySelect
        value={'"Iosevka Italic"'}
        onPick={noop}
        families={[]}
        emptyLabel="Body font"
      />,
    )
    expect(screen.getByLabelText('Body font').getAttribute('value')).toBe('Iosevka Italic')
  })

  it('stores a typed name quoted, exactly as the select would have', async () => {
    const picked: string[] = []
    render(
      <FamilySelect value="" onPick={(v) => picked.push(v)} families={[]} emptyLabel="Body font" />,
    )
    await userEvent.type(screen.getByLabelText('Body font'), 'A')
    expect(picked).toEqual(['"A"'])
  })

  it('stores nothing at all for a field cleared back to whitespace', async () => {
    const picked: string[] = []
    render(
      <FamilySelect
        value={'"X"'}
        onPick={(v) => picked.push(v)}
        families={[]}
        emptyLabel="Body font"
      />,
    )
    await userEvent.clear(screen.getByLabelText('Body font'))
    expect(picked).toEqual([''])
  })
})

describe('NamedFaceReport', () => {
  it('says nothing when no styled face or range family is named', () => {
    const { container } = render(<NamedFaceReport settings={settings()} />)
    expect(container.innerHTML).toBe('')
  })

  it('says nothing when every named family is installed', () => {
    const { container } = render(
      <NamedFaceReport
        settings={settings({
          fontFamilyItalic: '"Cascadia Code"',
          fontRanges: [{ lo: 0x30, hi: 0x39, family: '"Consolas"' }],
        })}
      />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('names a styled face this machine does not have', () => {
    render(<NamedFaceReport settings={settings({ fontFamilyItalic: '"Iosevka Italic"' })} />)
    expect(screen.getByText(/Iosevka Italic is not installed/)).toBeTruthy()
  })

  it('is explicit that the fallback is not the body font', () => {
    // The whole reason this warning exists: these slots name a single family
    // with no stack behind them, so a name nothing answers to leaves the
    // rasterizer on its own default rather than on the font you chose.
    render(<NamedFaceReport settings={settings({ fontFamilyBold: '"Berkeley Mono"' })} />)
    expect(screen.getByText(/rather than to your body font/)).toBeTruthy()
  })

  it('names a missing range family too, since that is where one arrives from', () => {
    render(
      <NamedFaceReport
        settings={settings({
          fontRanges: [{ lo: 0xe000, hi: 0xf8ff, family: '"Symbols Nerd Font"' }],
        })}
      />,
    )
    expect(screen.getByText(/Symbols Nerd Font is not installed/)).toBeTruthy()
  })

  it('lists several missing families once each, and reads as a plural', () => {
    render(
      <NamedFaceReport
        settings={settings({
          fontFamilyItalic: '"Iosevka Italic"',
          fontFamilyBoldItalic: '"Iosevka Italic"',
          fontRanges: [{ lo: 0xe000, hi: 0xf8ff, family: '"Maple Mono"' }],
        })}
      />,
    )
    expect(screen.getByText(/Iosevka Italic, Maple Mono are not installed/)).toBeTruthy()
  })

  // A guess dressed up as a report is worse than silence: the API being absent
  // is not the same answer as the font being absent.
  it('says nothing at all when the webview cannot answer', () => {
    stubFontCheck(null)
    const { container } = render(
      <NamedFaceReport settings={settings({ fontFamilyItalic: '"Iosevka Italic"' })} />,
    )
    expect(container.innerHTML).toBe('')
  })
})
