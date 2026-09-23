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
 * There is deliberately no runtime interrogation of the engine here. The wasm
 * exports no version symbol (see `main/abi.ts` — 178 functions, none of them a
 * version), and `XTVERSION` is a callback *we* answer rather than something the
 * binary reports. Baked-in constants, verified against the bytes by a test, are
 * the only honest source available.
 */
export const GHOSTTY_PIN = {
  /** The branch the pin is on. ghostty `main`, post-v1.3.1 — there is no
   *  upstream release number that describes this build. */
  upstream: 'main',
  commit: '622b4eecd7d2ce1a10930537c17f0d61abdba817',
  /** Carried on top of the pin — see `patches/ghostty-main-esc-k.patch`. Worth
   *  showing: it changes parser behaviour, so "ghostty at <commit>" alone would
   *  not reproduce what the user is running. */
  patch: 'ghostty-main-esc-k.patch (#176)',
  sha256: '23cfa45b9fe0d463fcb2d7fac8cfa9d7c3ababcfac33206381005063597d4a65',
  bytes: 1_130_482,
  zig: '0.16.0',
  buildFlags: '-Demit-lib-vt=true -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast',
} as const

/** The commit, at the length people actually quote it at. */
export const GHOSTTY_COMMIT_SHORT = GHOSTTY_PIN.commit.slice(0, 12)
