// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { BUNDLED_FONTS, bundledFaces, bundledLacksItalic, weightDescriptor } from './bundledFonts'

interface RecordedFace {
  family: string
  source: string
  descriptors: Record<string, string>
}

let declared: RecordedFace[]
let loaded: string[]

class FontFaceStub {
  family: string
  constructor(family: string, source: string, descriptors: Record<string, string>) {
    this.family = family
    declared.push({ family, source, descriptors })
  }
}

beforeEach(() => {
  declared = []
  loaded = []
  vi.resetModules()
  vi.stubGlobal('FontFace', FontFaceStub)
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: {
      add: () => {},
      load: (shorthand: string) => {
        loaded.push(shorthand)
        return Promise.resolve([])
      },
    },
  })
})

/** A fresh copy of the module, since both the registration and the
 *  already-fetched set are module-scope and once-only by design. */
async function fresh() {
  return await import('./bundledFonts')
}

describe('what is shipped', () => {
  it('carries both italics for JetBrains Mono and neither for Fira Code', () => {
    // Not a gap in the selection: Fira Code's authors ship uprights only.
    expect(BUNDLED_FONTS['JetBrains Mono']?.filter((f) => f.style === 'italic')).toHaveLength(2)
    expect(BUNDLED_FONTS['Fira Code']?.every((f) => f.style === 'normal')).toBe(true)
  })

  it('ships one file per face, with no two claiming the same weight and slant', () => {
    for (const faces of Object.values(BUNDLED_FONTS)) {
      const keys = faces.map((f) => `${f.weight}/${f.style}`)
      expect(new Set(keys).size).toBe(keys.length)
      expect(new Set(faces.map((f) => f.url)).size).toBe(faces.length)
    }
  })

  it('covers the two weights the terminal draws, by a file or by an axis', () => {
    for (const [family, faces] of Object.entries(BUNDLED_FONTS)) {
      const upright = faces.filter((f) => f.style === 'normal')
      for (const wanted of [400, 700]) {
        const covered = upright.some((f) => {
          if (f.weight === wanted) return true
          const range = f.weightRange?.split(/\s+/).map(Number)
          return !!range && wanted >= range[0] && wanted <= range[1]
        })
        expect(covered, `${family} at ${wanted}`).toBe(true)
      }
    }
  })

  it('spends one file on the variable family and one per weight on the static ones', () => {
    // The reason Monaspace is affordable at all: ~500 KB for every weight,
    // against ~450 KB for each single static cut of it.
    expect(BUNDLED_FONTS['Monaspace Neon']).toHaveLength(1)
    expect(weightDescriptor(BUNDLED_FONTS['Monaspace Neon']![0]!)).toBe('200 800')
    expect(weightDescriptor(BUNDLED_FONTS['Fira Code']![0]!)).toBe('400')
  })

  it('has no italic to offer for either family that ships none', () => {
    // Monaspace has italics, but through the `slnt` axis rather than a file,
    // and axes are not configured per style slot.
    expect(bundledLacksItalic('Monaspace Neon')).toBe(true)
    expect(bundledLacksItalic('Fira Code')).toBe(true)
  })
})

describe('looking a family up', () => {
  it('matches however a CSS stack happened to spell it', () => {
    expect(bundledFaces('JetBrains Mono')).not.toBeNull()
    expect(bundledFaces('jetbrains mono')).not.toBeNull()
    expect(bundledFaces('"Fira Code"')).not.toBeNull()
    expect(bundledFaces('  Fira Code  ')).not.toBeNull()
  })

  it('says nothing about a family the machine is expected to supply', () => {
    expect(bundledFaces('Cascadia Code')).toBeNull()
    expect(bundledFaces('monospace')).toBeNull()
  })

  it('reports the missing italic only for the family that has none', () => {
    expect(bundledLacksItalic('Fira Code')).toBe(true)
    expect(bundledLacksItalic('JetBrains Mono')).toBe(false)
    // A family we do not ship is not something this can answer for — the
    // machine's own copy may well have an italic.
    expect(bundledLacksItalic('Consolas')).toBe(false)
  })
})

describe('registering', () => {
  it('declares every shipped face under its real family name', async () => {
    const m = await fresh()
    m.registerBundledFonts()
    const count = Object.values(BUNDLED_FONTS).reduce((n, faces) => n + faces.length, 0)
    expect(declared).toHaveLength(count)
    expect(new Set(declared.map((d) => d.family))).toEqual(new Set(Object.keys(BUNDLED_FONTS)))
    expect(declared.every((d) => d.source.startsWith('url('))).toBe(true)
  })

  it('declares once however often it is called', async () => {
    const m = await fresh()
    m.registerBundledFonts()
    const first = declared.length
    m.registerBundledFonts()
    expect(declared).toHaveLength(first)
  })

  it('says nothing at all in a webview without FontFace', async () => {
    vi.stubGlobal('FontFace', undefined)
    const m = await fresh()
    m.registerBundledFonts()
    expect(declared).toEqual([])
  })
})

describe('starting the fetch', () => {
  it('asks for each shipped face of the family, since a declared face loads on use', async () => {
    const m = await fresh()
    m.ensureBundledLoaded('Fira Code')
    expect(loaded).toEqual(['400 16px "Fira Code"', '700 16px "Fira Code"'])
  })

  it('spells the slant into the shorthand, so the italic file is fetched too', async () => {
    const m = await fresh()
    m.ensureBundledLoaded('JetBrains Mono')
    expect(loaded).toContain('italic 400 16px "JetBrains Mono"')
  })

  it('asks for the variable family once, since one file answers every weight', async () => {
    const m = await fresh()
    m.ensureBundledLoaded('Monaspace Neon')
    expect(loaded).toEqual(['400 16px "Monaspace Neon"'])
  })

  it('asks once per family, not once per settings change', async () => {
    const m = await fresh()
    m.ensureBundledLoaded('Fira Code')
    m.ensureBundledLoaded('fira code')
    expect(loaded).toHaveLength(2)
  })

  it('ignores a family that was never ours to fetch', async () => {
    const m = await fresh()
    m.ensureBundledLoaded('Cascadia Mono')
    expect(loaded).toEqual([])
  })
})

describe('waiting for a shipped face to arrive', () => {
  // The point of the wait: a cell measured before the bytes land is a cell
  // measured against the fallback face, and the glyphs that fill it will not
  // be that face. The caller re-measures on a true.
  it('reports that the caller measured too early, then that it did not', async () => {
    const m = await fresh()
    expect(await m.bundledSettled(['"JetBrains Mono"', 'monospace'])).toBe(true)
    // Second time round the face is here, so there is nothing to re-measure
    // for — which is what keeps a re-measuring caller from re-measuring
    // forever.
    expect(await m.bundledSettled(['"JetBrains Mono"'])).toBe(false)
  })

  it('starts the fetch itself rather than trusting someone else to have', async () => {
    const m = await fresh()
    await m.bundledSettled(['Fira Code'])
    expect(loaded).toEqual(['400 16px "Fira Code"', '700 16px "Fira Code"'])
  })

  it('answers false for a configuration naming nothing we ship', async () => {
    const m = await fresh()
    expect(await m.bundledSettled(['Consolas', 'ui-monospace', ''])).toBe(false)
  })

  it('waits for every family named, not just the first', async () => {
    const m = await fresh()
    expect(await m.bundledSettled(['Fira Code', 'JetBrains Mono'])).toBe(true)
    expect(loaded).toHaveLength(6)
  })
})
