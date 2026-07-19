import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const host = process.env.TAURI_DEV_HOST

// https://vite.dev/config/
// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [react()],

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // src-tauri/ itself never has watchable frontend files, but more
      // importantly: this is a Cargo workspace with src-tauri as a member,
      // not the root, so the actual build output (target/) lives at the
      // repo root rather than under src-tauri/ — without excluding it too,
      // Vite's watcher can grab a file handle on a build artifact mid-link,
      // right as cargo has it locked, and crash with EBUSY.
      ignored: ['**/src-tauri/**', '**/target/**'],
    },
  },
})
