# wRusTTY

A lightweight SSH / Telnet / Serial client for Windows 11: modern GUI,
tabbed sessions, encrypted local credential vault, GPU-accelerated terminal.
Built with Tauri 2 (Rust) + React.

Aimed squarely at replacing PuTTY and SuperPuTTY rather than at being a
general-purpose terminal emulator. It reads PuTTY `.ppk` keys directly (v2
and v3, encrypted or not), authenticates through Pageant or the Windows
OpenSSH agent, and supports ProxyJump, port forwarding, and the serial
line-control details a console cable actually needs — break signalling,
DTR/RTS, local echo, and line-ending control.

See [`docs/PROJECT_PLAN.md`](docs/PROJECT_PLAN.md) for architecture,
feature scope, and the phased build plan.

## Development

Prerequisites: Node.js 22+, Rust (stable), and on Linux the Tauri system
deps (`libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev
librsvg2-dev libssl-dev`). Windows/macOS need their platform's WebView2 /
Xcode Command Line Tools per the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/).

```sh
npm install
npm run tauri dev    # run the desktop app
npm run dev           # frontend only, in a browser
```

### Workspace layout

- `src/` — React + TypeScript frontend
- `src-tauri/` — Tauri app shell (thin glue: commands, window/state wiring)
- `crates/wr-core` — session model, protocol-agnostic `Connection` trait
- `crates/wr-ssh` — SSH transport (auth, kex, host keys, PTY, forwarding)
- `crates/wr-telnet` — Telnet transport
- `crates/wr-serial` — serial transport
- `crates/wr-vault` — encrypted credential vault
- `crates/wr-sftp` — SFTP/SCP (Phase 6)

### Security model notes

The vault holds one random data key that encrypts every stored secret
(XChaCha20-Poly1305), plus one *wrapper* per enabled unlock method, each
holding its own encrypted copy of that data key. Secrets are decrypted only
in the Rust process and never sent back to the webview. Enabling or removing
an unlock method — or changing the master password — rewraps 32 bytes and
re-encrypts no credentials.

**Master password.** Argon2id. Always present and deliberately not
removable: it is the fallback that makes every hardware-backed method safe
to depend on. Cost parameters are stored per wrapper, so raising the
defaults never strands an existing vault.

**Windows Hello** (optional, Windows only). Enrols a key credential whose
private key is held by the TPM and gated on a Hello gesture, then derives
the wrapping key by signing a stored challenge:

```text
KEK = HKDF-SHA256(RequestSignAsync(challenge), salt, "wrustty vault kek v1")
```

Nothing recoverable sits at rest — obtaining the key needs a live gesture at
the machine, and the TPM's anti-hammering bounds guessing. The challenge is
stored in the clear and is not a secret. Two consequences worth knowing:

- The credential is **machine-bound**. A vault copied elsewhere opens with
  the master password, and Hello is enrolled again on that machine.
- The scheme assumes signatures are **deterministic**. That holds for the
  RSA PKCS#1 v1.5 signatures Windows produces today, but is not a documented
  guarantee. If it ever stops holding, unlock says so explicitly instead of
  sending you round a re-enrolment loop, and the master password is
  unaffected.

**Windows sign-in** (fallback where Hello is unavailable). Stores a random
wrapping key in Credential Manager, protected by DPAPI. Any process running
in your logged-in session can read it back with no prompt, and it is
recoverable offline from a stolen disk given your account password — weaker
than the master password alone. Hello is preferred automatically wherever
the machine supports it, and the vault menu names which method is in use.

Vault files predating the wrapper format are upgraded in place on the next
master-password unlock, onto a freshly generated data key. Any copy of the
old key stops being useful at that moment — including the one that earlier
versions of "Unlock with Windows sign-in" left sitting in Credential
Manager.

### Compatibility notes

**SSH agent.** Selecting "SSH agent" as a session's auth method delegates to
whichever agent is running — the Windows OpenSSH agent service is tried
first, then Pageant. The agent holds the key and produces the signature, so
no key material enters this process; it is also the only way to use a key
that cannot be exported at all, such as a FIDO2 security key or a PIV
smartcard. Note that servers cap authentication attempts (OpenSSH's
`MaxAuthTries` defaults to 6), so an agent loaded with many keys can be cut
off before the right one is reached.

**Terminal type.** Sessions send `TERM=xterm-256color` unless overridden per
session. Some network and embedded gear renders badly, or refuses a PTY,
under anything but `vt100`.

**Backspace.** Defaults to `^?` (DEL), which is what modern Unix expects.
Gear that wants `^H` — much network equipment and older Unix — is handled by
a setting; the symptom is backspace doing nothing or echoing `^?`.

**Serial break.** The `BRK` button in the status bar holds a break condition
on the line, for Cisco password recovery, ROMMON entry, and bootloader
interrupts. DTR and RTS toggles sit beside it.

### Checks

```sh
npm run lint && npm run build   # frontend
cargo fmt --all --check         # Rust formatting
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```
