# wr-shell

A lightweight SSH / Telnet / Serial client for Windows 11: modern GUI,
tabbed sessions, encrypted local credential vault, GPU-accelerated terminal.
Built with Tauri 2 (Rust) + React.

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

The credential vault is encrypted with XChaCha20-Poly1305 under an
Argon2id-derived key; secrets are decrypted only in the Rust process and
never sent back to the webview. One deliberate tradeoff to be aware of:
the optional **"Unlock with Windows sign-in"** convenience stores the raw
vault key in Windows Credential Manager (DPAPI). The Windows Hello/PIN
challenge shown at unlock is enforced by wr-shell's own code — DPAPI
itself will hand that stored key to *any* process running in your
logged-in Windows session, with no Hello prompt. If your threat model
includes malware already running as your user, don't enable OS unlock;
the master-password path keeps the key derivable only via Argon2.

### Checks

```sh
npm run lint && npm run build   # frontend
cargo fmt --all --check         # Rust formatting
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```
