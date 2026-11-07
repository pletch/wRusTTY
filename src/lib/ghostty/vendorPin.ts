/**
 * What the vendored `vendor/ghostty-vt.wasm` actually is.
 *
 * Two things read this and they must agree: `vendorIntegrity.test.ts`, which
 * hashes the binary on every `npm test`, and the About section of Settings,
 * which shows the same facts to whoever is writing a bug report. Before this
 * module they were separate copies of the same constants, which meant the
 * displayed build could drift from the verified one — and the *displayed* one
 * is the copy that ends up pasted into an issue.
 *
 * `vendor/README.md` carries the long-form version of all of this, and
 * `vendorIntegrity.test.ts` asserts the two stay in step. When you rebuild the
 * binary, update this file and that README in the same commit as the `.wasm`.
 *
 * There is deliberately no runtime interrogation of the engine here. Since
 * libghostty-vt 1.0 the wasm does export `ghostty_version`, but that names
 * upstream's library version, not our patch or the exact commit, and
 * `XTVERSION` is a callback *we* answer rather than something the binary
 * reports. Baked-in constants, verified against the bytes by a test, are the
 * honest source.
 */
export const GHOSTTY_PIN = {
  /** The branch the pin is on. ghostty `main` just past the `vt-1.0.0` tag
   *  of libghostty-vt (it reports 1.1.0-dev), with the same C API. */
  upstream: 'main',
  commit: '27ffca0dd67177d1f069ea7f910362e5d871613d',
  /** Carried on top of the pin — see `patches/ghostty-main-esc-k.patch`. Worth
   *  showing: it changes parser behavior, so "ghostty at <commit>" alone would
   *  not reproduce what the user is running. */
  patch: 'ghostty-main-esc-k.patch (#176)',
  sha256: '5edd02712ddc336e706a5a1be362c78d1456b9ccd10d13cfc23e4b0e000b8f3f',
  bytes: 1_331_227,
  zig: '0.17.0',
  buildFlags: '-Demit-lib-vt=true -Dtarget=wasm32-freestanding -Doptimize=fast',
} as const

/** The commit, at the length people actually quote it at. */
export const GHOSTTY_COMMIT_SHORT = GHOSTTY_PIN.commit.slice(0, 12)
