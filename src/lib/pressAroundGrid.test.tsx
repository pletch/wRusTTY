// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { pressAroundGrid } from './pressAroundGrid'

/** The shape of the terminal's pane: padding around a container, which holds the
 *  grid's canvas, the hidden input, and overlays such as buttons. */
function Pane() {
  const containerRef = useRef<HTMLDivElement>(null)
  return (
    <div
      data-testid="pane"
      style={{ padding: 12 }}
      onMouseDown={(e) =>
        pressAroundGrid(e, containerRef.current, () =>
          (document.querySelector('[data-testid="input"]') as HTMLTextAreaElement).focus(),
        )
      }
    >
      <div ref={containerRef} data-testid="container">
        <canvas data-testid="canvas" />
        <textarea data-testid="input" />
        <button type="button" data-testid="overlay">
          Copy
        </button>
      </div>
    </div>
  )
}

describe('pressAroundGrid', () => {
  afterEach(cleanup)

  it.each(['pane', 'container'])('keeps the input focused on a press on the %s', (where) => {
    const { getByTestId } = render(<Pane />)
    const input = getByTestId('input')
    input.focus()
    const notCanceled = fireEvent.mouseDown(getByTestId(where))
    // Canceled, so the browser doesn't move focus to the body.
    expect(notCanceled).toBe(false)
    expect(document.activeElement).toBe(input)
  })

  it('brings focus back to the input when it had gone', () => {
    const { getByTestId } = render(<Pane />)
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.mouseDown(getByTestId('container'))
    expect(document.activeElement).toBe(getByTestId('input'))
  })

  it.each(['canvas', 'overlay'])('leaves a press on the %s to its own handlers', (where) => {
    const { getByTestId } = render(<Pane />)
    ;(document.activeElement as HTMLElement | null)?.blur()
    const notCanceled = fireEvent.mouseDown(getByTestId(where))
    expect(notCanceled).toBe(true)
    expect(document.activeElement).not.toBe(getByTestId('input'))
  })
})
