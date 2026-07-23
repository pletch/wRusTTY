import { getCurrentWindow } from '@tauri-apps/api/window'
import { Minus, Square, Copy, X } from 'lucide-react'


const buttonClass =
  'flex w-11 items-center justify-center text-white/60 transition-colors duration-100 hover:bg-white/10 hover:text-white'

interface Props {
  maximized: boolean
}

/** Custom minimize/maximize/close buttons — the window ships with native
 * decorations turned off (tauri.conf.json) to match Tabby's borderless
 * look, so these replace what the OS title bar would otherwise provide.
 * `maximized` is owned by App.tsx since it also needs it to decide
 * whether to round the window's corners. */
export function WindowControls({ maximized }: Props) {
  let win: any
  try {
    win = getCurrentWindow()
  } catch {
    // Fallback for browser testing
    win = { minimize: () => {}, toggleMaximize: () => {}, close: () => {} }
  }

  return (
    <div className="flex shrink-0 items-stretch">
      <button className={buttonClass} onClick={() => win.minimize()} title="Minimize">
        <Minus size={15} />
      </button>
      <button
        className={buttonClass}
        onClick={() => win.toggleMaximize()}
        title={maximized ? 'Restore' : 'Maximize'}
      >
        {maximized ? <Copy size={13} /> : <Square size={12} />}
      </button>
      <button
        className={`${buttonClass} hover:bg-red-500 hover:text-white`}
        onClick={() => win.close()}
        title="Close"
      >
        <X size={15} />
      </button>
    </div>
  )
}
