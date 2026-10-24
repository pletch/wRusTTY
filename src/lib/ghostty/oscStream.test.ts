import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { OSC_PENDING_MAX, parseOsc } from './oscStream'

/**
 * OSC, bell and reset handlers through a real engine and core.
 *
 * The core's parser finds the sequences now (`vt_write_until`), and these
 * cases hold it to what the JS scanner it replaced promised: a handler runs
 * after its sequence is parsed and before anything after it, events stay in
 * stream order, and splitting the stream anywhere changes nothing.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = readFileSync(join(here, 'vendor/ghostty-vt.wasm'))

interface Internals {
  termPtr: number
}

describe('OSC handlers on the core parser', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.byteLength),
    }))
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })
  })
  afterEach(() => vi.unstubAllGlobals())

  /** A loaded engine logging every event, with the cursor column at OSCs. */
  async function ready() {
    const { GhosttyEngine } = await import('./GhosttyEngine')
    const engine = new GhosttyEngine()
    const inner = engine as unknown as Internals
    for (let i = 0; i < 200 && !inner.termPtr; i++) await new Promise((r) => setTimeout(r, 5))
    if (!inner.termPtr) throw new Error('core did not load')

    const log: string[] = []
    for (const ident of [2, 133, 52]) {
      engine.registerOscHandler(ident, (data) => {
        engine.syncReadState()
        log.push(`osc:${ident}:${data}@${engine.cursorCell().x}`)
        return false
      })
    }
    engine.onBell(() => log.push('bell'))
    engine.registerResetHandler(() => log.push('reset'))
    engine.onBufferChange((alt) => log.push(alt ? 'buffer:alt' : 'buffer:main'))
    /** The text of row 0, as the core holds it. */
    const row0 = () => {
      engine.syncReadState()
      return engine.readRowText(0, 0)[0]?.text.trimEnd() ?? ''
    }
    return { engine, log, row0 }
  }

  describe('dispatch', () => {
    it('hands over a BEL-terminated OSC', async () => {
      const { engine, log } = await ready()
      engine.write('\x1b]2;title\x07')
      expect(log).toEqual(['osc:2:title@0'])
    })

    it('hands over an ST-terminated OSC', async () => {
      const { engine, log } = await ready()
      engine.write('\x1b]2;title\x1b\\')
      expect(log).toEqual(['osc:2:title@0'])
    })

    it('keeps semicolons in the payload', async () => {
      const { engine, log } = await ready()
      engine.write('\x1b]133;D;0;aid=1\x07')
      expect(log).toEqual(['osc:133:D;0;aid=1@0'])
    })

    it('treats a bare BEL as the bell, and an OSC terminator as not one', async () => {
      const { engine, log } = await ready()
      engine.write('\x07\x1b]2;t\x07')
      expect(log).toEqual(['bell', 'osc:2:t@0'])
    })
  })

  describe('ordering', () => {
    it('parses everything before a sequence, and nothing after it, before the handler', async () => {
      const { engine, log } = await ready()
      engine.write('ab\x1b]2;t\x07cd')
      expect(log).toEqual(['osc:2:t@2'])
    })

    it('reports a screen switch before a marker in the same chunk', async () => {
      const { engine, log } = await ready()
      engine.write('\x1b[?1049h\x1b]133;A\x07')
      expect(log).toEqual(['buffer:alt', 'osc:133:A@0'])
    })

    it('keeps bells, resets and OSCs in stream order', async () => {
      const { engine, log } = await ready()
      engine.write('\x07\x1b]2;one\x07\x1bc\x1b]2;two\x07\x07')
      expect(log).toEqual(['bell', 'osc:2:one@0', 'reset', 'osc:2:two@0', 'bell'])
    })

    it('keeps a reset before a progress report that follows it', async () => {
      // What the progress indicator relies on: RIS clears it, and a report
      // after the RIS in the same write sets it again.
      const { engine, log } = await ready()
      engine.write('\x1bc\x1b]133;A\x07')
      expect(log).toEqual(['reset', 'osc:133:A@0'])
    })
  })

  describe('a handler writing back into the terminal', () => {
    // The reason this runs on vt_write_until: the leftover-mode reset writes
    // at the marker, before the rest of the chunk.
    async function writer() {
      const { GhosttyEngine } = await import('./GhosttyEngine')
      const engine = new GhosttyEngine()
      const inner = engine as unknown as Internals & { parseSegment(b: Uint8Array): void }
      for (let i = 0; i < 200 && !inner.termPtr; i++) await new Promise((r) => setTimeout(r, 5))
      engine.registerOscHandler(2, () => {
        inner.parseSegment(new TextEncoder().encode('X'))
        return false
      })
      const row0 = () => {
        engine.syncReadState()
        return engine.readRowText(0, 0)[0]?.text.trimEnd() ?? ''
      }
      return { engine, row0 }
    }

    it('lands between the sequence and what follows it', async () => {
      const { engine, row0 } = await writer()
      engine.write('A\x1b]2;t\x07B')
      expect(row0()).toBe('AXB')
    })

    it('completes an ESC \\ terminator before writing, so no backslash is printed', async () => {
      const { engine, row0 } = await writer()
      engine.write('A\x1b]2;t\x1b\\B')
      expect(row0()).toBe('AXB')
    })

    it('does the same when the \\ arrives in the next chunk', async () => {
      const { engine, row0 } = await writer()
      engine.write('A\x1b]2;t\x1b')
      engine.write('\\B')
      expect(row0()).toBe('AXB')
    })
  })

  describe('sequences split across chunks', () => {
    for (const [name, parts] of [
      ['inside the payload', ['\x1b]2;ti', 'tle\x07']],
      ['right after ESC', ['\x1b', ']2;title\x07']],
      ['inside the ST terminator', ['\x1b]2;title\x1b', '\\']],
      ['three ways', ['\x1b]', '2;tit', 'le\x07']],
    ] as const) {
      it(`hands it over once, split ${name}`, async () => {
        const { engine, log } = await ready()
        for (const p of parts) engine.write(p)
        expect(log).toEqual(['osc:2:title@0'])
      })
    }

    it('reassembles a multi-byte character split across chunks', async () => {
      const { engine, log } = await ready()
      const bytes = new TextEncoder().encode('\x1b]2;café 世界\x07')
      // Split inside the two-byte é.
      const at = bytes.indexOf(0xc3) + 1
      engine.write(bytes.subarray(0, at))
      engine.write(bytes.subarray(at))
      expect(log).toEqual(['osc:2:café 世界@0'])
    })
  })

  describe('input that is not an OSC to hand over', () => {
    it('leaves CSI alone', async () => {
      const { engine, log, row0 } = await ready()
      engine.write('\x1b[31mred\x1b[0m')
      expect(log).toEqual([])
      expect(row0()).toBe('red')
    })

    it('drops an OSC that another escape sequence ends without terminating', async () => {
      const { engine, log } = await ready()
      engine.write('\x1b]133;A\x1b[0mtail\x1b]2;real\x07')
      expect(log).toEqual(['osc:2:real@4'])
    })

    it('drops one canceled with CAN or SUB, and prints what follows', async () => {
      const { engine, log, row0 } = await ready()
      engine.write('\x1b]2;evil\x18safe\x1b]52;c;aGk=\x1amore\x07')
      // The BEL after the SUB is an ordinary bell now.
      expect(log).toEqual(['bell'])
      expect(row0()).toBe('safemore')
    })

    it('ignores an OSC with no number or no semicolon', async () => {
      const { engine, log } = await ready()
      engine.write('\x1b];nonumber\x07\x1b]133nosemi\x07')
      expect(log).toEqual([])
    })

    it('does not see a reset in the letter c inside a payload', async () => {
      const { engine, log } = await ready()
      engine.write('\x1b]2;abc c\x07')
      expect(log).toEqual(['osc:2:abc c@0'])
    })

    it('treats ESC c inside an OSC as the end of the OSC and a real reset', async () => {
      const { engine, log } = await ready()
      engine.write('\x1b]2;a \x1bc b\x07')
      // The ESC ends the OSC without terminating it, so nothing is handed over;
      // `ESC c` is the reset the terminal performs, and the BEL is then a bell.
      expect(log).toEqual(['reset', 'bell'])
    })
  })

  describe('a runaway sequence', () => {
    it('is dropped, and the next one still arrives', async () => {
      const { engine, log } = await ready()
      engine.write(`\x1b]52;c;${'A'.repeat(OSC_PENDING_MAX + 1024)}\x07`)
      engine.write('\x1b]2;after\x07')
      expect(log).toEqual(['osc:2:after@0'])
    })
  })
})

describe('parseOsc', () => {
  const dec = new TextDecoder()
  const enc = (s: string) => new TextEncoder().encode(s)

  it('splits the number from the payload', () => {
    expect(parseOsc(enc('133;D;0'), dec)).toEqual({ ident: 133, payload: 'D;0' })
  })

  it('accepts an empty payload', () => {
    expect(parseOsc(enc('2;'), dec)).toEqual({ ident: 2, payload: '' })
  })

  it('refuses content with no number or no semicolon', () => {
    expect(parseOsc(enc(';x'), dec)).toBeNull()
    expect(parseOsc(enc('133'), dec)).toBeNull()
    expect(parseOsc(enc('133x;y'), dec)).toBeNull()
  })
})
