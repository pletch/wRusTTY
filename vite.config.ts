import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const host = process.env.TAURI_DEV_HOST

/**
 * Mirror of the production CSP in src-tauri/tauri.conf.json, relaxed only as
 * the dev server needs, so violations show up in `npm run tauri dev`.
 *
 * It lives here because tauri.conf.json's `devCsp` is inert on desktop: Tauri
 * applies a CSP only to its embedded assets and proxies the dev server only
 * under `all(dev, mobile)` (`PROXY_DEV_SERVER` in tauri's
 * manager/webview.rs), so the header must come from the server.
 *
 * The two relaxations, both dev-server artifacts:
 *   - 'unsafe-inline' scripts: @vitejs/plugin-react injects its react-refresh
 *     preamble into index.html as an inline module.
 *   - ws://localhost:*: the HMR socket (CSP 3 may cover it via 'self', but
 *     that's not worth relying on).
 *
 * Covers the default localhost flow only; TAURI_DEV_HOST (a mobile
 * convention, unused here) would need its host added.
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
      // Cargo's target/ is at the repo root (src-tauri is a workspace member);
      // Vite's watcher can grab a build artifact mid-link and crash with EBUSY.
      ignored: ['**/src-tauri/**', '**/target/**'],
    },
  },
})
