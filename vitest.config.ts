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
      include: ['src/lib/**', 'src/state/**'],
    },
  },
})
