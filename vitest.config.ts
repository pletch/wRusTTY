import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Most of what gets tested is pure logic in src/lib and src/state — that
// doesn't need a DOM. Files that do (portal machinery, ConnectDialog, etc.)
// opt in per-file with a `// @vitest-environment jsdom` directive comment.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.{ts,tsx}', 'src/state/**/*.{ts,tsx}', 'src/hooks/**/*.{ts,tsx}'],
      exclude: ['src/lib/**/*.test.ts', 'src/lib/ghostty/vendor/**'],
      // Phase 1-7 baseline (paneTree, sessionSnapshot, shellIntegration,
      // lineEditor, settings, theme, oscScanner, state/tabOps,
      // state/paneRuntime, state/tabs, hooks/usePanePortals). Ratchet
      // upward as more of src/lib, src/state and src/hooks get covered —
      // never lower these.
      thresholds: {
        lines: 26,
        statements: 26,
        functions: 34,
        branches: 29,
      },
    },
  },
})
