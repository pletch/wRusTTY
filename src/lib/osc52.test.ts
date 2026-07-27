import { describe, it, expect } from 'vitest'
import { parseOsc52, OSC52_MAX_BASE64 } from './osc52'

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')

describe('parseOsc52', () => {
  it('decodes a clipboard write', () => {
    expect(parseOsc52(`c;${b64('hello')}`)).toEqual({ kind: 'write', text: 'hello' })
  })

  it('decodes UTF-8 rather than latin-1', () => {
    expect(parseOsc52(`c;${b64('héllo → 世界')}`)).toEqual({
      kind: 'write',
      text: 'héllo → 世界',
    })
  })

  it('treats an empty target list as the clipboard', () => {
    expect(parseOsc52(`;${b64('hi')}`)).toEqual({ kind: 'write', text: 'hi' })
  })

  it('honours the select buffer, which apps use to mean the clipboard', () => {
    expect(parseOsc52(`s;${b64('hi')}`)).toEqual({ kind: 'write', text: 'hi' })
  })

  it('honours a target list that includes the clipboard among others', () => {
    expect(parseOsc52(`pc;${b64('hi')}`)).toEqual({ kind: 'write', text: 'hi' })
  })

  it('ignores a primary-selection-only write', () => {
    // Nothing on Windows to put it in, and folding it onto the clipboard would
    // let a selection sync clobber a real copy.
    expect(parseOsc52(`p;${b64('hi')}`)).toEqual({ kind: 'ignore' })
  })

  it('reports a read without answering it', () => {
    expect(parseOsc52('c;?')).toEqual({ kind: 'read' })
  })

  it('strips the wrapping a chunked sender adds', () => {
    const wrapped = b64('a longer thing to copy').replace(/(.{4})/g, '$1\n')
    expect(parseOsc52(`c;${wrapped}`)).toEqual({ kind: 'write', text: 'a longer thing to copy' })
  })

  it('treats an empty payload as clearing the clipboard', () => {
    expect(parseOsc52('c;')).toEqual({ kind: 'write', text: '' })
  })

  it('ignores a payload with no target separator', () => {
    expect(parseOsc52('nonsense')).toEqual({ kind: 'ignore' })
  })

  it('ignores payloads that are not base64', () => {
    expect(parseOsc52('c;not base64 at all!!')).toEqual({ kind: 'ignore' })
  })

  it('refuses a payload past the size bound', () => {
    expect(parseOsc52(`c;${'A'.repeat(OSC52_MAX_BASE64 + 4)}`)).toEqual({ kind: 'ignore' })
  })

  it('accepts a payload at the size bound', () => {
    const at = parseOsc52(`c;${'A'.repeat(OSC52_MAX_BASE64)}`)
    expect(at.kind).toBe('write')
  })
})
