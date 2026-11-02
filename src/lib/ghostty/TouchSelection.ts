import type { Point, Selection } from './SelectionController'

/**
 * What a touch selection needs beyond what the terminal draws: a handle at each
 * end to drag, and a bar with Copy and Paste. Plain DOM over the canvas, and
 * repositioned from the render loop, so the handles stay on their text as it
 * scrolls.
 */

/** The target a finger gets, around a much smaller visible handle. */
const HANDLE_HIT_PX = 44
const HANDLE_DOT_PX = 14
const HANDLE_COLOR = '#38bdf8'
/** Clear space between the bar and the selection, or the container's edge. */
const BAR_GAP_PX = 6

export interface TouchSelectionHost {
  cellSize(): { width: number; height: number }
  /** Visible rows, and the absolute row at the top of them. */
  rows(): number
  topRow(): number
  selection(): Selection | null
  /** A handle's drag begins, with the other end staying put. */
  dragFrom(fixed: Point): void
  dragTo(clientX: number, clientY: number): void
  dragEnd(): void
  copy(): void
  paste(): void
  /** Drops the selection. */
  clear(): void
}

export class TouchSelection {
  private readonly host: TouchSelectionHost
  private readonly container: HTMLElement
  private readonly startHandle: HTMLElement
  private readonly endHandle: HTMLElement
  private readonly bar: HTMLElement
  private readonly copyButton: HTMLButtonElement
  /** A Paste bar with nothing selected, at this point in the container. */
  private pasteAt: { x: number; y: number } | null = null
  private dragging = false

  constructor(container: HTMLElement, host: TouchSelectionHost) {
    this.container = container
    this.host = host
    this.startHandle = this.makeHandle('start')
    this.endHandle = this.makeHandle('end')

    this.bar = document.createElement('div')
    Object.assign(this.bar.style, {
      position: 'absolute',
      zIndex: '40',
      display: 'none',
      gap: '2px',
      padding: '2px',
      borderRadius: '8px',
      background: '#1f2937',
      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.5)',
    })
    this.copyButton = this.makeButton('Copy', () => {
      this.host.copy()
      this.host.clear()
      this.update()
    })
    this.bar.append(
      this.copyButton,
      this.makeButton('Paste', () => {
        this.dismiss()
        this.host.paste()
      }),
    )
    this.stopEvents(this.bar)
    container.append(this.startHandle, this.endHandle, this.bar)
  }

  dispose(): void {
    this.startHandle.remove()
    this.endHandle.remove()
    this.bar.remove()
  }

  /** Whether a tap should go to clearing this rather than to the terminal. */
  showing(): boolean {
    return this.pasteAt !== null || this.host.selection() !== null
  }

  /** Offers Paste with nothing selected, at a point in client coordinates. */
  offerPaste(clientX: number, clientY: number): void {
    const rect = this.container.getBoundingClientRect()
    this.pasteAt = { x: clientX - rect.left, y: clientY - rect.top }
    this.update()
  }

  dismiss(): void {
    this.pasteAt = null
    this.host.clear()
    this.update()
  }

  /** Puts everything where it belongs for what's selected now. */
  update(): void {
    const sel = this.host.selection()
    // A handle dragged onto the other end briefly selects nothing. Hiding it then
    // would release its pointer capture and end the drag.
    if (this.dragging && !sel) return
    if (sel) this.pasteAt = null
    this.copyButton.style.display = sel ? '' : 'none'
    if (!sel) {
      this.startHandle.style.display = 'none'
      this.endHandle.style.display = 'none'
      if (this.pasteAt) this.placeBar(this.pasteAt.y, this.pasteAt.y, this.pasteAt.x)
      else this.bar.style.display = 'none'
      return
    }

    const [first, last] = ordered(sel)
    const cell = this.host.cellSize()
    const firstRow = first.y - this.host.topRow()
    const lastRow = last.y - this.host.topRow()
    this.placeHandle(this.startHandle, first.x * cell.width, firstRow, cell.height)
    this.placeHandle(this.endHandle, (last.x + 1) * cell.width, lastRow, cell.height)
    this.placeBar(
      firstRow * cell.height,
      (lastRow + 1) * cell.height + HANDLE_HIT_PX,
      ((first.x + last.x) / 2) * cell.width,
    )
  }

  private placeHandle(el: HTMLElement, x: number, row: number, height: number): void {
    const visible = row >= 0 && row < this.host.rows()
    el.style.display = visible ? 'block' : 'none'
    if (visible) {
      el.style.left = `${x - HANDLE_HIT_PX / 2}px`
      el.style.top = `${(row + 1) * height}px`
    }
  }

  /** Above `top` if there's room, else below `bottom`, centered near `x`. */
  private placeBar(top: number, bottom: number, x: number): void {
    const { bar, container } = this
    bar.style.display = 'flex'
    const above = top - bar.offsetHeight - BAR_GAP_PX
    const y = above >= 0 ? above : bottom + BAR_GAP_PX
    const maxY = container.clientHeight - bar.offsetHeight - BAR_GAP_PX
    const left = x - bar.offsetWidth / 2
    const maxLeft = container.clientWidth - bar.offsetWidth - BAR_GAP_PX
    bar.style.top = `${Math.max(BAR_GAP_PX, Math.min(y, maxY))}px`
    bar.style.left = `${Math.max(BAR_GAP_PX, Math.min(left, maxLeft))}px`
  }

  private makeButton(label: string, onPress: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.tabIndex = -1
    button.textContent = label
    Object.assign(button.style, {
      minHeight: '40px',
      padding: '0 16px',
      borderRadius: '6px',
      color: '#f3f4f6',
      fontSize: '14px',
      touchAction: 'manipulation',
    })
    button.addEventListener('click', onPress)
    return button
  }

  /** Keeps a press out of the terminal, and focus (and the keyboard) where it is. */
  private stopEvents(el: HTMLElement): void {
    for (const type of ['pointerdown', 'mousedown', 'contextmenu'] as const) {
      el.addEventListener(type, (e) => {
        e.preventDefault()
        e.stopPropagation()
      })
    }
    for (const type of ['mouseup', 'click', 'touchstart', 'touchend'] as const) {
      el.addEventListener(type, (e) => e.stopPropagation())
    }
  }

  private makeHandle(which: 'start' | 'end'): HTMLElement {
    const el = document.createElement('div')
    Object.assign(el.style, {
      position: 'absolute',
      zIndex: '40',
      display: 'none',
      width: `${HANDLE_HIT_PX}px`,
      height: `${HANDLE_HIT_PX}px`,
      touchAction: 'none',
    })
    const dot = document.createElement('div')
    Object.assign(dot.style, {
      width: `${HANDLE_DOT_PX}px`,
      height: `${HANDLE_DOT_PX}px`,
      margin: '0 auto',
      background: HANDLE_COLOR,
      borderRadius: which === 'start' ? '50% 0 50% 50%' : '0 50% 50% 50%',
    })
    el.append(dot)
    this.stopEvents(el)

    // The grabbed text is the row above the handle. Dragging by the handle's own
    // position, rather than the finger's, keeps it visible above the finger.
    let grabOffsetY = 0
    el.addEventListener('pointerdown', (e) => {
      const sel = this.host.selection()
      if (!sel) return
      const [first, last] = ordered(sel)
      this.dragging = true
      grabOffsetY = e.clientY - el.getBoundingClientRect().top + this.host.cellSize().height / 2
      el.setPointerCapture?.(e.pointerId)
      this.host.dragFrom(which === 'start' ? last : first)
    })
    el.addEventListener('pointermove', (e) => {
      if (this.dragging) this.host.dragTo(e.clientX, e.clientY - grabOffsetY)
    })
    const finish = () => {
      if (!this.dragging) return
      this.dragging = false
      this.host.dragEnd()
      this.update()
    }
    el.addEventListener('pointerup', finish)
    el.addEventListener('pointercancel', finish)
    return el
  }
}

function ordered(sel: Selection): [Point, Point] {
  const { start, end } = sel
  return start.y < end.y || (start.y === end.y && start.x <= end.x) ? [start, end] : [end, start]
}
