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

const root = createRoot(document.getElementById('root')!)

function renderApp() {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

// The Phase 7 benchmark harness, behind its own build flag.
//
// It runs in this exact WebView — same engines, same WASM as production —
// which is what makes its numbers worth anything. Reached by loading with a
// `#bench` URL fragment, or at any time with Ctrl+Alt+B (the desktop window
// has no address bar to type a fragment into).
//
// Being dynamically imported kept it out of the *app chunk*, so it never cost
// anything at startup — but the chunk was still emitted into `dist/`, which
// means it shipped inside every installer: 564 kB of JS plus 4 kB of CSS,
// carrying all four xterm packages, reachable in a release build by anyone who
// pressed Ctrl+Alt+B. Code-splitting answers "does this slow the app down";
// it does not answer "is this in the shipped artifact".
//
// Gating the whole block — the import, the hash check and the hotkey — makes
// the branch dead in a release build, so rollup emits no chunk at all. The
// hotkey has to be inside the gate too: left registered, it would reach for a
// chunk that no longer exists.
//
// `npm run dev` and `npm run tauri:dev` set the flag, so nothing changes while
// developing. `npm run build:instrumented` sets it too — that is the
// measurement build, and if you are measuring you want both the harness and
// the on-screen instruments above.
if (import.meta.env.VITE_WRUSTTY_BENCH) {
  const showBench = () => {
    void import('./bench/BenchmarkHarness.tsx').then(({ BenchmarkHarness }) => {
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
