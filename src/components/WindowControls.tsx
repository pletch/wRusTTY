import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Minus, Square, Copy, X } from 'lucide-react'

const win = getCurrentWindow()

const buttonClass =
  'flex w-11 items-center justify-center text-white/60 transition-colors duration-100 hover:bg-white/10 hover:text-white'

/** Custom minimize/maximize/close buttons — the window ships with native
 * decorations turned off (tauri.conf.json) to match Tabby's borderless
 * look, so these replace what the OS title bar would otherwise provide. */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    win.isMaximized().then(setMaximized)
    const unlisten = win.onResized(() => {
      win.isMaximized().then(setMaximized)
    })
    return () => {
      unlisten.then((f) => f())
    }
  }, [])

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
