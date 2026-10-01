import {
  currentMonitor,
  getCurrentWindow,
  PhysicalPosition,
  PhysicalSize,
  primaryMonitor,
} from '@tauri-apps/api/window'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Where a window has to go to be wholly inside the work area, or null when it
 * already is.
 *
 * Shrinks before it moves: a window taller than the work area cannot be moved
 * onto it, which is the case that prompted this — geometry saved on a larger
 * display came back 1091px tall on a 1032px work area with its top at y=780,
 * and the dialog in the middle of it landed below the bottom of the screen.
 */
export function fitToWorkArea(win: Rect, work: Rect): Rect | null {
  const width = Math.min(win.width, work.width)
  const height = Math.min(win.height, work.height)
  const x = Math.min(Math.max(win.x, work.x), work.x + work.width - width)
  const y = Math.min(Math.max(win.y, work.y), work.y + work.height - height)
  if (x === win.x && y === win.y && width === win.width && height === win.height) return null
  return { x, y, width, height }
}

/**
 * Pulls the window back onto the monitor it was restored to.
 *
 * tauri-plugin-window-state only makes sure a restored window is on *some*
 * monitor, not that it fits — so a layout saved on another display, or before
 * the scale changed, can come back mostly off the bottom of the screen.
 *
 * Works on the inner rectangle: on Windows an undecorated window's outer one
 * includes invisible resize borders, which may hang off the edge harmlessly
 * and would otherwise leave an 8px gap the user never asked for.
 *
 * Maximized and fullscreen windows are the OS's to place, and are left alone.
 */
export async function keepWindowOnScreen(): Promise<void> {
  const win = getCurrentWindow()
  if ((await win.isMaximized()) || (await win.isFullscreen())) return
  const monitor = (await currentMonitor()) ?? (await primaryMonitor())
  if (!monitor) return

  const [inner, outer, size] = await Promise.all([win.innerPosition(), win.outerPosition(), win.innerSize()])
  const work = monitor.workArea
  const fit = fitToWorkArea(
    { x: inner.x, y: inner.y, width: size.width, height: size.height },
    { x: work.position.x, y: work.position.y, width: work.size.width, height: work.size.height },
  )
  if (!fit) return

  if (fit.width !== size.width || fit.height !== size.height) {
    await win.setSize(new PhysicalSize(fit.width, fit.height))
  }
  // setPosition places the outer rectangle, so carry the border offset over.
  await win.setPosition(new PhysicalPosition(fit.x - (inner.x - outer.x), fit.y - (inner.y - outer.y)))
}
