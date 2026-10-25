/**
 * The app's version, for Settings' About section. A checked-in constant
 * pinned to the manifests by `version.test.ts`, rather than a build-time
 * `define` that would need repeating in both Vite configs.
 *
 * Five files carry it: here, `package.json`, `package-lock.json`, the
 * workspace `Cargo.toml`, and `src-tauri/tauri.conf.json` (authoritative; it's
 * what Add/Remove Programs shows). `npm run release` (tools/version.mjs) sets
 * all five.
 */
export const APP_VERSION = '0.4.3'
