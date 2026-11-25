// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { GhosttyInputHandler, isPasteLike } from './GhosttyInputHandler'

/**
 * Text that arrives in the input box as if typed, but is a paste: a keyboard's
 * clipboard panel commits it that way. It has to reach the host's paste guard,
 * or every newline in it is a Return the shell runs.
 */

describe('isPasteLike', () => {
  it('counts anything the browser calls a paste or drop', () => {
    expect(isPasteLike('ls', 'insertFromPaste')).toBe(true)
    expect(isPasteLike('ls', 'insertFromDrop')).toBe(true)
  })

  it('counts typed text with a line break inside it', () => {
    expect(isPasteLike('cd /tmp\nrm -rf build', 'insertText')).toBe(true)
    expect(isPasteLike('a\rb', null)).toBe(true)
  })

  it('leaves ordinary typing alone', () => {
    expect(isPasteLike('l', 'insertText')).toBe(false)
    expect(isPasteLike('hello world', null)).toBe(false)
  })

  it('leaves an Enter that a keyboard sends as text alone', () => {
    expect(isPasteLike('\n', 'insertText')).toBe(false)
    expect(isPasteLike('\r\n', 'insertLineBreak')).toBe(false)
    expect(isPasteLike('ls\n', 'insertText')).toBe(false)
  })
})

function harness(sink: ((text: string) => boolean) | null) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const sent: string[] = []
  const handler = new GhosttyInputHandler(container, (bytes) =>
    sent.push(new TextDecoder().decode(bytes)),
  )
  handler.pasteSink = sink
  const input = (data: string | null, inputType: string) => {
    handler.element.dispatchEvent(new InputEvent('input', { data, inputType, bubbles: true }))
  }
  return { handler, sent, input }
}

describe('the input box', () => {
  it('hands multi-line committed text to the paste sink instead of sending it', () => {
    const pasted: string[] = []
    const { sent, input } = harness((t) => (pasted.push(t), true))
    input('cd /tmp\nrm -rf build', 'insertText')
    expect(pasted).toEqual(['cd /tmp\nrm -rf build'])
    expect(sent).toEqual([])
  })

  it('still sends single characters as typed', () => {
    const pasted: string[] = []
    const { sent, input } = harness((t) => (pasted.push(t), true))
    input('x', 'insertText')
    expect(sent).toEqual(['x'])
    expect(pasted).toEqual([])
  })

  it('reads a native paste from the box when the event carries no data', () => {
    const pasted: string[] = []
    const { handler, input } = harness((t) => (pasted.push(t), true))
    handler.element.value = 'echo hi'
    input(null, 'insertFromPaste')
    expect(pasted).toEqual(['echo hi'])
  })

  it('sends the text as typed when no host claims it', () => {
    const { sent, input } = harness(() => false)
    input('a\nb', 'insertText')
    expect(sent).toEqual(['a\nb'])
  })

  it('sends the text as typed when there is no sink', () => {
    const { sent, input } = harness(null)
    input('a\nb', 'insertText')
    expect(sent).toEqual(['a\nb'])
  })
})
