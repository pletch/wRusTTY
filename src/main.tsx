import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// The measurement instruments, behind a build flag.
//
// What they are, and why they exist on screen rather than in the console:
// reaching a recorder through devtools means an inspector is attached, and V8
// runs WebAssembly in a debuggable tier while DevTools is open — 2.75x slower
// on this build. Every production figure taken during the Phase 7
// investigation was wrong for exactly that reason. So the ability to take a
// measurement on a real, uninspected build has to be preserved.
//
// But that argues for *on screen*, not for *always shipped*. Unlike the
// benchmark harness below these were statically imported, so ~1,000 lines of
// instrumentation — and a hotkey that floods a live pane with synthetic data —
// went into the entry chunk of every installer, reachable by nobody.
//
//   - `__wrusttyDelivery` measures the real PTY delivery path in a live
//     session: the half of a flood the harness cannot see, because it starts
//     from a buffer already in the webview.
//   - `__wrusttyPaneFlood.run()` feeds a real pane from inside the page — no
//     PTY, no SSH, no IPC — the only way to measure a transport-free pane in
//     an app whose backend only speaks SSH, telnet and serial.
//   - The overlay is the same two from the keyboard: Ctrl+Alt+F floods the
//     visible pane, Ctrl+Alt+D arms and reports the real PTY path.
//
// Build with `VITE_WRUSTTY_INSTRUMENTS=1` to get them back — `npm run
// build:instrumented` does exactly that. The recorder's hot-path half
// (`deliveryStats.record`) is *not* gated and still ships: it's what
// `Terminal.tsx` calls on every delivery, and it short-circuits on one boolean
// before any clock read. Only the reporting and UI halves are behind this.
if (import.meta.env.VITE_WRUSTTY_INSTRUMENTS) {
  void Promise.all([
    import('./lib/deliveryReport').then((m) => m.install()),
    import('./lib/paneFlood').then((m) => m.install()),
    import('./lib/measureOverlay').then((m) => m.install()),
  ])
}

// The Phase 7 benchmark harness runs in this exact WebView — same engines, same
// WASM as production. It is reached either by loading with a `#bench` URL
// fragment, or at any time with the Ctrl+Alt+B shortcut below (the desktop
// window has no address bar to type a fragment into). It is dynamically
// imported so it splits into its own chunk and never ships in the app bundle.
const root = createRoot(document.getElementById('root')!)

function showBench() {
  import('./bench/BenchmarkHarness.tsx').then(({ BenchmarkHarness }) => {
    // Rendered outside StrictMode so its engines mount once rather than twice —
    // the double-mount is harmless for the app but would race two async WASM
    // loads in the harness. Replacing the tree tears down any live app sessions,
    // which is expected: this is a deliberate switch into benchmark mode.
    root.render(<BenchmarkHarness />)
  })
}

if (window.location.hash === '#bench') {
  showBench()
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

// Ctrl+Alt+B from anywhere in the app opens the harness — no reload, no
// devtools. Left registered in all builds; it costs nothing until pressed and
// the harness chunk only loads on demand.
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.altKey && (e.key === 'b' || e.key === 'B')) {
    e.preventDefault()
    showBench()
  }
})
