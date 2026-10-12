import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ConfirmProvider } from './components/ConfirmProvider'
import { registerBundledFonts } from './lib/bundledFonts'

// Before anything renders, so the settings dialog and the atlas find the
// shipped families declared. Bytes are fetched only for a family in use.
registerBundledFonts()

// The measurement instruments, behind a build flag. They're on screen rather
// than console-only because attaching DevTools puts V8's WebAssembly in a
// debuggable tier (2.75x slower here), and statically importing them would
// ship ~1,000 lines and a pane-flooding hotkey in every installer.
//
//   - `__wrusttyDelivery` measures the real PTY delivery path in a live
//     session, the half the harness can't see.
//   - `__wrusttyPaneFlood.run()` feeds a real pane from inside the page, with
//     no transport.
//   - The overlay offers both from the keyboard: Ctrl+Alt+F floods the
//     visible pane, Ctrl+Alt+D arms and reports the real PTY path.
//
// `npm run build:instrumented` sets `VITE_WRUSTTY_INSTRUMENTS=1`. The hot-path
// recorder (`deliveryStats.record`) always ships and short-circuits on one
// boolean; only the reporting and UI halves are gated.
if (import.meta.env.VITE_WRUSTTY_INSTRUMENTS) {
  void Promise.all([
    import('./lib/deliveryReport').then((m) => m.install()),
    import('./lib/paneFlood').then((m) => m.install()),
    import('./lib/measureOverlay').then((m) => m.install()),
  ])
}

const root = createRoot(document.getElementById('root')!)

function renderApp() {
  root.render(
    <StrictMode>
      {/* Outside App so a prompt raised from anywhere (including a pane's context
          menu) renders above the whole window. */}
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </StrictMode>,
  )
}

// The benchmark harness, behind its own build flag. It runs in this WebView
// with the production engines, which is what makes its numbers meaningful.
// Opened with a `#bench` fragment or Ctrl+Alt+B.
//
// Gating the import, hash check and hotkey together makes the branch dead in
// release builds, so rollup emits no chunk (a dynamic import alone still
// ships the chunk). `npm run dev`, `npm run tauri:dev` and
// `npm run build:instrumented` set the flag.
if (import.meta.env.VITE_WRUSTTY_BENCH) {
  const showBench = () => {
    void import('./bench/BenchmarkHarness.tsx').then(({ BenchmarkHarness }) => {
      // Outside StrictMode so engines mount once (a double mount would race two
      // WASM loads). Replacing the tree tears down live sessions, as intended.
      root.render(<BenchmarkHarness />)
    })
  }

  if (window.location.hash === '#bench') {
    showBench()
  } else {
    renderApp()
  }

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && (e.key === 'b' || e.key === 'B')) {
      e.preventDefault()
      showBench()
    }
  })
} else {
  renderApp()
}
