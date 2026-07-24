import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

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
