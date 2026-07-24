import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const host = process.env.TAURI_DEV_HOST

/**
 * Mirror of the production CSP in src-tauri/tauri.conf.json, relaxed by
 * exactly what the dev server itself needs, so a policy violation shows up
 * on `npm run tauri dev` instead of waiting for a release build.
 *
 * It has to live here rather than in tauri.conf.json's `devCsp`, which looks
 * like the obvious home for it but is inert in this setup: Tauri only ever
 * applies a CSP while serving its own embedded assets, and on desktop it
 * proxies the dev server through that path only under `all(dev, mobile)`
 * (`PROXY_DEV_SERVER` in tauri's manager/webview.rs). A desktop dev build
 * navigates the webview straight at devUrl, so nothing Tauri is configured
 * with reaches the response — the header has to come from whoever serves it,
 * which is us.
 *
 * That gap is why the missing 'wasm-unsafe-eval' that stopped Ghostty's WASM
 * from compiling was invisible until a production build: dev enforced no
 * policy at all.
 *
 * The two relaxations, both dev-server artifacts rather than anything the app
 * does:
 *   - 'unsafe-inline' scripts: @vitejs/plugin-react injects its react-refresh
 *     preamble into index.html as an inline module.
 *   - ws://localhost:*: the HMR client's socket. CSP 3 arguably lets 'self'
 *     cover a same-host ws:, but that is not worth depending on.
 *
 * Note this covers the default localhost flow only. TAURI_DEV_HOST serves on
 * a LAN address that these origins don't match; that path is Tauri's mobile
 * convention and unused here, and would need the host added if it ever is.
 */
const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' ws://localhost:1420 ws://localhost:1421 ipc: http://ipc.localhost",
].join('; ')

// https://vite.dev/config/
// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [react()],

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    headers: { 'Content-Security-Policy': DEV_CSP },
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
