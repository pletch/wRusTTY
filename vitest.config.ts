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
      // The coverage baseline. Ratchet upward as coverage grows; never lower.
      thresholds: {
        lines: 33,
        statements: 32,
        functions: 38,
        branches: 34,
      },
    },
  },
})
