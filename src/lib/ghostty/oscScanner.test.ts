import { describe, it, expect } from 'vitest'
import { scanOsc, OSC_PENDING_MAX } from './oscScanner'

const dec = new TextDecoder()
const enc = new TextEncoder()
const B = (s: string) => enc.encode(s)

/**
 * Replays chunks exactly as GhosttyEngine.parseAndDispatch does, recording the
 * interleaving of parsed segments and dispatched events.
 *
 * The ordering is the whole point of the scanner: a handler has to run only
 * after everything preceding it in the stream — including its own sequence —
 * has reached the parser. Asserting on this log is what pins that down, since
 * the events alone would look identical whatever order the parser saw.
 */
function replay(chunks: string[]) {
  let pending: Uint8Array | null = null
  const log: string[] = []
  for (const c of chunks) {
    const bytes = B(c)
    const { events, pending: next } = scanOsc(bytes, pending, dec)
    pending = next
    let cursor = 0
    for (const ev of events) {
      if (ev.segEnd > cursor) {
        log.push(`parse:${dec.decode(bytes.subarray(cursor, ev.segEnd))}`)
        cursor = ev.segEnd
      }
      log.push(ev.kind === 'bell' ? 'bell' : `osc:${ev.ident}:${ev.payload}`)
    }
    if (cursor < bytes.length) log.push(`parse:${dec.decode(bytes.subarray(cursor))}`)
  }
  return { log, pending }
}

/** Everything handed to the parser, concatenated — must equal the input
 *  exactly: every byte parsed once, in order, whatever the segmentation. */
const parsedText = (log: string[]) =>
  log.filter((l) => l.startsWith('parse:')).map((l) => l.slice(6)).join('')

describe('scanOsc', () => {
  describe('dispatch', () => {
    it('recognises a BEL-terminated OSC', () => {
      expect(replay(['\x1b]133;A\x07']).log).toEqual(['parse:\x1b]133;A\x07', 'osc:133:A'])
    })

    it('recognises an ST-terminated OSC', () => {
      expect(replay(['\x1b]133;D;0\x1b\\']).log).toEqual([
        'parse:\x1b]133;D;0\x1b\\',
        'osc:133:D;0',
      ])
    })

    it('treats a bare BEL as the bell', () => {
      expect(replay(['\x07']).log).toEqual(['parse:\x07', 'bell'])
    })

    it('keeps the payload intact when it contains semicolons', () => {
      expect(replay(['\x1b]52;c;SGVsbG8=\x07']).log).toEqual([
        'parse:\x1b]52;c;SGVsbG8=\x07',
        'osc:52:c;SGVsbG8=',
      ])
    })
  })

  describe('ordering', () => {
    it('parses everything before a sequence before dispatching it', () => {
      const src = 'hello\x1b]133;C\x07world'
      const { log } = replay([src])
      expect(log).toEqual(['parse:hello\x1b]133;C\x07', 'osc:133:C', 'parse:world'])
      expect(parsedText(log)).toBe(src)
    })

    it('parses a screen-buffer change before a marker in the same chunk', () => {
      // The tmux/nano regression: leaving the alternate screen and the marker
      // that ends the run arrive together. Dispatching before ESC[?1049l was
      // parsed made handlers read a stale screen state, which stranded the run
      // open and left the activity indicator stuck on.
      const src = '\x1b[?1049l\x1b]133;D;0\x07$ '
      const { log } = replay([src])
      expect(log).toEqual(['parse:\x1b[?1049l\x1b]133;D;0\x07', 'osc:133:D;0', 'parse:$ '])
      expect(parsedText(log)).toBe(src)
    })

    it('keeps multiple events in stream order', () => {
      const src = 'a\x1b]133;A\x07b\x07c\x1b]0;title\x07d'
      const { log } = replay([src])
      expect(log).toEqual([
        'parse:a\x1b]133;A\x07',
        'osc:133:A',
        'parse:b\x07',
        'bell',
        'parse:c\x1b]0;title\x07',
        'osc:0:title',
        'parse:d',
      ])
      expect(parsedText(log)).toBe(src)
    })
  })

  describe('sequences split across chunks', () => {
    it('dispatches once, on the chunk that completes it', () => {
      const { log, pending } = replay(['x\x1b]133', ';A\x07y'])
      expect(log).toEqual(['parse:x\x1b]133', 'parse:;A\x07', 'osc:133:A', 'parse:y'])
      expect(pending).toBeNull()
      expect(parsedText(log)).toBe('x\x1b]133;A\x07y')
    })

    it('handles a split immediately after ESC', () => {
      expect(replay(['\x1b', ']133;A\x07']).log).toEqual([
        'parse:\x1b',
        'parse:]133;A\x07',
        'osc:133:A',
      ])
    })

    it('handles a split inside the ST terminator', () => {
      expect(replay(['\x1b]133;D;0\x1b', '\\rest']).log).toEqual([
        'parse:\x1b]133;D;0\x1b',
        'parse:\\',
        'osc:133:D;0',
        'parse:rest',
      ])
    })

    it('handles a three-way split', () => {
      expect(replay(['\x1b]13', '3;A', '\x07']).log).toEqual([
        'parse:\x1b]13',
        'parse:3;A',
        'parse:\x07',
        'osc:133:A',
      ])
    })
  })

  describe('input that is not a recognised OSC', () => {
    it('leaves CSI entirely to the parser', () => {
      const src = '\x1b[31mred\x1b[0m'
      expect(replay([src]).log).toEqual([`parse:${src}`])
    })

    it('emits nothing for an ESC that does not terminate the string', () => {
      const src = '\x1b]133;A\x1bXtail'
      expect(replay([src]).log).toEqual([`parse:${src}`])
    })

    // These two guard a bug the old regex scanner had: an unrecognised OSC let
    // scanning resume *inside* the sequence, so its own terminating BEL was
    // reported as the bell. Any OSC form we do not parse would ring it.
    it('does not ring the bell on an OSC with no ident', () => {
      const src = '\x1b];nodigits\x07'
      expect(replay([src]).log).toEqual([`parse:${src}`])
    })

    it('does not ring the bell on an OSC with no semicolon', () => {
      const src = '\x1b]133noSemi\x07'
      expect(replay([src]).log).toEqual([`parse:${src}`])
    })
  })

  describe('the carried-over buffer', () => {
    it('retains an unterminated sequence', () => {
      const { pending } = replay(['\x1b]133;' + 'x'.repeat(10)])
      expect(pending).not.toBeNull()
      expect(pending!.length).toBeGreaterThan(0)
    })

    it('drops a runaway sequence rather than growing without bound', () => {
      const { pending } = replay(['\x1b]133;' + 'x'.repeat(OSC_PENDING_MAX + 100)])
      expect(pending).toBeNull()
    })

    it('parses plain text in one segment and carries nothing', () => {
      const { log, pending } = replay(['plain text with no sequences'])
      expect(log).toEqual(['parse:plain text with no sequences'])
      expect(pending).toBeNull()
    })
  })

  describe('UTF-8 integrity', () => {
    it('decodes a multi-byte payload and preserves surrounding bytes', () => {
      const src = '世界 ✓\x1b]0;タイトル\x07more 世界'
      const { log } = replay([src])
      expect(log[1]).toBe('osc:0:タイトル')
      expect(parsedText(log)).toBe(src)
    })

    it('passes a multi-byte character split across chunks through byte-identical', () => {
      // Scanning bytes rather than a decoded string is what makes this safe:
      // chunk bodies are never decoded, so a character split at the boundary
      // cannot become replacement characters on the way to the parser.
      const full = enc.encode('世')
      let pending: Uint8Array | null = null
      const out: number[] = []
      for (const part of [full.subarray(0, 1), full.subarray(1)]) {
        const { events, pending: next } = scanOsc(part, pending, dec)
        pending = next
        expect(events).toHaveLength(0)
        out.push(...part)
      }
      expect(out).toEqual(Array.from(full))
    })
  })
})
