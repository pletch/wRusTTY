import { describe, it, expect, vi } from 'vitest'
import { LineEditor, parseHexLine } from './lineEditor'

function makeEditor(onSubmit = vi.fn()) {
  const writes: string[] = []
  const term = { write: (data: string) => writes.push(data) }
  const editor = new LineEditor(term, onSubmit)
  return { editor, writes, onSubmit }
}

describe('LineEditor', () => {
  it('starts with an empty prompt', () => {
    const { editor, writes } = makeEditor()
    editor.start()
    expect(writes).toEqual(['> '])
  })

  it('inserts typed characters at the cursor', () => {
    const { editor, onSubmit } = makeEditor()
    editor.start()
    editor.handleData('a')
    editor.handleData('b')
    editor.handleData('\r')
    expect(onSubmit).toHaveBeenCalledWith('ab')
  })

  it('backspace removes the character before the cursor', () => {
    const { editor, onSubmit } = makeEditor()
    editor.start()
    editor.handleData('a')
    editor.handleData('b')
    editor.handleData('\x7f')
    editor.handleData('\r')
    expect(onSubmit).toHaveBeenCalledWith('a')
  })

  it('backspace at cursor 0 is a no-op', () => {
    const { editor, onSubmit } = makeEditor()
    editor.start()
    editor.handleData('\x7f')
    editor.handleData('\r')
    expect(onSubmit).toHaveBeenCalledWith('')
  })

  it('left/right movement plus insert lands the character mid-line', () => {
    const { editor, onSubmit } = makeEditor()
    editor.start()
    editor.handleData('a')
    editor.handleData('c')
    editor.handleData('\x1b[D') // left, cursor now between a and c
    editor.handleData('b')
    editor.handleData('\r')
    expect(onSubmit).toHaveBeenCalledWith('abc')
  })

  it('deleteForward (Del key) removes the character at the cursor', () => {
    const { editor, onSubmit } = makeEditor()
    editor.start()
    editor.handleData('a')
    editor.handleData('b')
    editor.handleData('\x1b[D') // cursor between a and b
    editor.handleData('\x1b[3~') // delete forward removes 'b'
    editor.handleData('\r')
    expect(onSubmit).toHaveBeenCalledWith('a')
  })

  it('home/end move the cursor to the line boundaries', () => {
    const { editor, onSubmit } = makeEditor()
    editor.start()
    editor.handleData('bc')
    editor.handleData('\x1b[H') // home
    editor.handleData('a')
    editor.handleData('\x1b[F') // end
    editor.handleData('d')
    editor.handleData('\r')
    expect(onSubmit).toHaveBeenCalledWith('abcd')
  })

  it('recalls history with up/down and restores the stashed draft', () => {
    const { editor, onSubmit } = makeEditor()
    editor.start()
    editor.handleData('first')
    editor.handleData('\r')
    editor.handleData('second')
    editor.handleData('\r')

    editor.handleData('draft')
    editor.handleData('\x1b[A') // up -> most recent history ('second')
    editor.handleData('\x1b[A') // up -> older history ('first')
    editor.handleData('\x1b[B') // down -> back to 'second'
    editor.handleData('\x1b[B') // down -> past the end, restores the stash
    editor.handleData('\r')

    expect(onSubmit).toHaveBeenNthCalledWith(1, 'first')
    expect(onSubmit).toHaveBeenNthCalledWith(2, 'second')
    expect(onSubmit).toHaveBeenNthCalledWith(3, 'draft')
  })

  it('caps history at 200 entries', () => {
    const { editor, onSubmit } = makeEditor()
    editor.start()
    for (let i = 0; i < 201; i++) {
      editor.handleData(String(i))
      editor.handleData('\r')
    }
    for (let i = 0; i < 200; i++) editor.handleData('\x1b[A')
    editor.handleData('\r')
    // the oldest reachable history entry is '1' — '0' was evicted to stay
    // at the 200-entry cap
    expect(onSubmit).toHaveBeenLastCalledWith('1')
  })

  it('cancel (Ctrl+C) clears the buffer without submitting', () => {
    const { editor, onSubmit } = makeEditor()
    editor.start()
    editor.handleData('abc')
    editor.handleData('\x03')
    editor.handleData('\r')
    expect(onSubmit).toHaveBeenCalledWith('')
  })

  it('does not record an empty submission in history', () => {
    const { editor, onSubmit } = makeEditor()
    editor.start()
    editor.handleData('\r')
    editor.handleData('\x1b[A') // up with empty history is a no-op
    editor.handleData('\r')
    expect(onSubmit).toHaveBeenNthCalledWith(2, '')
  })
})

describe('parseHexLine', () => {
  it('parses whitespace-separated hex tokens, with optional 0x prefix', () => {
    expect(parseHexLine('AA 0x1B FF')).toEqual(new Uint8Array([0xaa, 0x1b, 0xff]))
  })

  it('tolerates leading/trailing/repeated whitespace', () => {
    expect(parseHexLine('  AA   BB  ')).toEqual(new Uint8Array([0xaa, 0xbb]))
  })

  it('accepts single-digit tokens', () => {
    expect(parseHexLine('A B')).toEqual(new Uint8Array([0x0a, 0x0b]))
  })

  it('returns an empty array for a blank line', () => {
    expect(parseHexLine('   ')).toEqual(new Uint8Array([]))
  })

  it('returns null for a token longer than 2 hex digits', () => {
    expect(parseHexLine('ABC')).toBeNull()
  })

  it('returns null for a non-hex token', () => {
    expect(parseHexLine('ZZ')).toBeNull()
  })

  it('rejects the whole line if any single token is invalid', () => {
    expect(parseHexLine('AA ZZ BB')).toBeNull()
  })
})
