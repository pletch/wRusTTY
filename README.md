# wRusTTY

A lightweight SSH / Telnet / Serial client for Windows 11: modern GUI,
tabbed sessions, encrypted local credential vault, GPU-accelerated terminal.
Built with Tauri 2 (Rust) + React.

Aimed squarely at replacing PuTTY and SuperPuTTY rather than at being a
general-purpose terminal emulator. It reads PuTTY `.ppk` keys directly (v2
and v3, encrypted or not), authenticates through Pageant or the Windows
OpenSSH agent, and supports ProxyJump, port forwarding, Wake-on-LAN, and
the serial line-control details a console cable actually needs — break
signalling, DTR/RTS, local echo, and line-ending control.

See [`docs/PROJECT_PLAN.md`](docs/PROJECT_PLAN.md) for architecture,
feature scope, and the phased build plan.

## Development

Prerequisites: Node.js 22+, Rust (stable), and on Linux the Tauri system
deps (`libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev
librsvg2-dev libssl-dev`). Windows/macOS need their platform's WebView2 /
Xcode Command Line Tools per the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/).

```sh
npm install
npm run tauri:dev     # run the desktop app, with devtools
npm run tauri dev     # same, without devtools
npm run dev           # frontend only, in a browser
```

Devtools are a cargo feature (`devtools`) rather than always-on, so release
installers ship a webview that can't be inspected — the process holds
decrypted vault secrets and renders untrusted remote output. `tauri:dev` is
the everyday command; `tauri build` never enables it.

The development tooling is gated the same way, by Vite mode rather than cargo
feature. A release build (`npm run build`, and so `npm run tauri build`)
contains neither the benchmark harness nor the measurement instruments —
their `import.meta.env` branches are dead, so no chunk is emitted for them at
all, and `dist/` is three files. Both are on for `npm run dev` and
`npm run tauri:dev`, and `npm run build:instrumented` gives you a real
optimised build that still carries them, for taking figures that must not be
distorted by an attached inspector.

### Workspace layout

- `src/` — React + TypeScript frontend
- `src-tauri/` — Tauri app shell (thin glue: commands, window/state wiring)
- `crates/wr-core` — session model, protocol-agnostic `Connector`/`Session` traits
- `crates/wr-ssh` — SSH transport (auth, kex, host keys, PTY, forwarding)
- `crates/wr-telnet` — Telnet transport
- `crates/wr-serial` — serial transport
- `crates/wr-vault` — encrypted credential vault
- `crates/wr-sftp` — SFTP/SCP (Phase 6)
- `crates/wr-fs` — atomic file replacement, shared by every on-disk store

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

**Unlock lifetime.** An unlock lasts until the Windows session locks (Win+L,
or an RDP client disconnecting), the app exits, or you lock the vault
yourself from the padlock menu. There is deliberately **no idle timeout**.

That is a decision rather than an omission. The case an idle timer is
usually bought for — walking away from the machine — is already covered by
the session-lock hook. What it would add is protection at a console that is
unlocked and unattended, and there a locked vault contains very little:
sessions already connected stay authenticated and accept typing, the files
panel keeps working, and anything reachable from the open window stays
reachable. The vault protects credentials at rest, not sessions in flight.
Set against that, a timer that fires mid-workflow and asks for a Hello
gesture to reconnect a pane is the kind of friction that gets configured to
its maximum, which protects less than not having it.

If your threat model includes an unlocked, unattended console, lock the
Windows session — that locks the vault too, and unlike a vault timeout it
also covers the screen and the keyboard.

One consequence worth stating plainly: `change_master_password` requires an
unlocked vault, not the current password, on the reasoning that possession
of an unlocked vault is normally proof enough. Combined with an unlock that
persists until session lock, that means anyone at your unlocked console can
change the master password. They can equally read every stored credential
through the app, so this widens nothing that was otherwise narrow — but it
is the same "unlocked console" boundary, and it is where that boundary sits.

Vault files predating the wrapper format are upgraded in place on the next
master-password unlock, onto a freshly generated data key. Any copy of the
old key stops being useful at that moment — including the one that earlier
versions of "Unlock with Windows sign-in" left sitting in Credential
Manager.

**Workspaces** save the whole arrangement — which sessions are open together
and how the panes are split — under a name, and reopen it later. Opening one
adds its tabs alongside whatever is already open rather than replacing them.
Panes that can't be reconnected without a secret typed at connect time are
skipped.

**Saved sessions** cover SSH, telnet and serial. They share one list, grouped
by whatever folders you create rather than by protocol — folders are the
organisation you chose and mean something; the transport is an attribute of
one entry, shown as a per-item icon. The same device reachable both ways ends
up adjacent, which is where you want it.

A saved serial session records the adapter's USB identity — vendor id, product
id and serial number — rather than its COM number, and resolves a live port at
connect time. A COM number is a property of the socket the adapter is plugged
into, not of the adapter, so it stops meaning anything the moment the cable
moves; the USB identity doesn't. "COM4" becomes "the FTDI cable with serial
A50285BI", which survives a replug, a reboot and a different socket. Adapters
that report no serial number (many CH340 and CP2102 clones) are matched on
vendor and product id instead, and if several identical ones are attached the
session says so rather than guessing — opening a console on the wrong switch
is worse than an error. A non-USB port, such as a PCI serial card, is still
matched by name, which is correct: it doesn't move.

**Importing from PuTTY.** If PuTTY's saved sessions are present on the machine,
the connect screen offers to import them —
`HKCU\Software\SimonTatham\PuTTY\Sessions`, read-only, PuTTY's own keys left
untouched. SSH, telnet and serial sessions come across; `raw` and `rlogin` are
skipped rather than silently imported as something they aren't. The import is
additive: a session already saved here with the same name and host is left
exactly as it is, so running it twice is harmless. Imported sessions land in an
"Imported from PuTTY" folder. Passwords are not imported, because PuTTY doesn't
store them — an SSH session with a key file comes across as key auth, and
anything else as agent auth, which is what a PuTTY user running Pageant already
has.

**Broadcast input** sends what you type to every pane in a tab at once —
SuperPuTTY's "send commands to all sessions", for when the same command has to
go to a rack of switches. It is per-tab, toggled from the toolbar, and every
pane in the group is ringed in amber while it is on: a mode that changes what
a keystroke does needs to be visible without looking for it.

### Compatibility notes

**SSH agent.** Selecting "SSH agent" as a session's auth method delegates to
whichever agent is running — the Windows OpenSSH agent service is tried
first, then Pageant. The agent holds the key and produces the signature, so
no key material enters this process; it is also the only way to use a key
that cannot be exported at all, such as a FIDO2 security key or a PIV
smartcard. Note that servers cap authentication attempts (OpenSSH's
`MaxAuthTries` defaults to 6), so an agent loaded with many keys can be cut
off before the right one is reached.

**Terminal type.** Set per session, and reaching the far end by different
means per protocol: SSH sends it with the PTY request, telnet answers the
RFC 1091 TERMINAL-TYPE subnegotiation with it. SSH defaults to
`xterm-256color`; telnet defaults to `vt100`, since its remaining users are
largely the network gear and legacy systems that want it. Serial has no
equivalent — it is a raw byte stream with nothing to negotiate.

**Backspace.** Per session: `^?` (DEL) by default, which is what modern Unix
expects, or `^H` for network gear and older Unix. The symptom of the wrong
one is backspace doing nothing or echoing `^?`. It is a per-connection choice
rather than a global preference because one machine routinely has both kinds
of host open in adjacent tabs.

**24-bit colour.** The terminal renders it natively, and sessions request
`COLORTERM=truecolor` so remote programs know to emit it. That request is
advisory: sshd only forwards variables listed in `AcceptEnv`, which defaults
to `LANG LC_*`, so it is frequently ignored. If colours look limited, either
add `AcceptEnv COLORTERM` to the server's `sshd_config`, export it from the
remote shell's rc, or set this session's terminal type to `xterm-direct`,
which advertises direct colour through terminfo instead.

`xterm-direct` is offered but is deliberately *not* the default. `TERM` is
an assertion, not a negotiation — the server looks the value up in its own
terminfo database, and there is no fallback if it is missing. `xterm-direct`
needs ncurses 6.1+, so on older distributions, minimal container images, and
most network gear it resolves to nothing and programs degrade to *dumb*
rather than to 256 colours. `xterm-256color` is present essentially
everywhere, which is why it remains the default.

**Serial break.** The `BRK` button in the status bar holds a break condition
on the line, for Cisco password recovery, ROMMON entry, and bootloader
interrupts. DTR and RTS toggles sit beside it.

**Wake-on-LAN.** An SSH session can carry the host's MAC address. Connecting
then checks whether the host is already up and only sends a magic packet if
it isn't, so leaving a MAC saved costs one round trip and nothing else; while
waiting, the pane shows *Waking* and the packet is re-sent every few seconds
until the host answers or the wait (60s by default) runs out. Right-clicking a
saved session also offers **Wake**, which sends the packet without connecting.

Two things about the packet itself. It doesn't route: the default
255.255.255.255 reaches this machine's own network segment only, so a host on
another subnet needs that subnet's directed broadcast (`192.168.1.255`) in the
*Broadcast to* field. On a machine with several active adapters — Wi-Fi,
Ethernet, a VM switch — the default also leaves by whichever one the routing
table picks, and naming a directed broadcast is how you choose. Not offered
for a session with a jump host: the packet would go out on this segment for a
machine that isn't on it, so waking is skipped rather than waited on.

When a packet is sent and nothing happens, the cause is almost always on the
target rather than here. On Windows 11, check all of:

- **Device Manager → the adapter → Power Management**: *Allow this device to
  wake the computer*, and *Only allow a magic packet to wake the computer*.
- **The adapter's Advanced tab**: *Wake on Magic Packet* enabled.
- **Fast Startup off** (Control Panel → Power Options → *Choose what the power
  buttons do*) if you want to wake the machine from a full shutdown. With it
  on, S5 is closer to hibernation and most NICs won't arm.
- **`powercfg /a`**: a Modern Standby (S0) machine sleeps and wakes on
  entirely different rules from an S3 one, and its Wi-Fi adapter in particular
  may never listen for a packet.

Wi-Fi wake (WoWLAN) is unreliable across vendors even when all of the above is
set; Ethernet is what this works on consistently.

The matching problem is a host that sleeps again *during* a session. The
Windows idle timer is reset by user input and power requests only — not by
network traffic — so an SSH session is invisible to it, and keepalives don't
help. [`tools/keep-awake.ps1`](tools/keep-awake.ps1) runs on the remote host
and holds it awake for as long as it runs.

### Checks

```sh
npm run lint && npm run build   # frontend
cargo fmt --all --check         # Rust formatting
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```
