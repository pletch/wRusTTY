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
 * Where a window must go to be wholly inside the work area, or null when it
 * already is. Shrinks before moving, since a window taller than the work
 * area can't be moved onto it.
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
 * tauri-plugin-window-state only ensures it's on some monitor, not that it
 * fits. Uses the inner rectangle: an undecorated window's outer one includes
 * invisible resize borders that may harmlessly hang off the edge. Maximized
 * and fullscreen windows are left to the OS.
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
