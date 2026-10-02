/**
 * The app's own version, for Settings' About section.
 *
 * A checked-in constant with a test pinning it to the manifests, rather than a
 * build-time `define` fed from `tauri.conf.json`. The define is the obvious
 * approach and costs more than it returns: it has to be repeated in
 * `vite.config.ts` and `vitest.config.ts` (which don't share a config), needs an
 * ambient declaration for the global, and leaves the value absent under any
 * tool that loads the source without either config. `version.test.ts` catches
 * the one failure mode the define would have prevented — someone bumping the
 * manifests and forgetting this — and catches it at the same moment, on CI.
 *
 * Five files carry this number: here, `package.json`, `package-lock.json`, the
 * workspace `Cargo.toml`, and `src-tauri/tauri.conf.json`. The last is the one
 * users see in Add/Remove Programs, so it is the one to treat as authoritative
 * when they disagree. `npm run release` (tools/version.mjs) sets all five.
 */
export const APP_VERSION = '0.4.0'
