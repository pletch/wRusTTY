# Android

Implementation plan for an Android build of wRusTTY: SSH, SFTP and telnet on a
phone with a soft keyboard.

**Status: M0 is done and M1 is under way.** A debug APK installed on a phone opens and
connects over SSH. The first test found two problems: the layout was drawn under the
system bars, hiding the tabs, and sessions dropped in the background. Both are fixed
and were confirmed on a Pixel 11 Pro: `MainActivity` insets the content view,
including for the keyboard, and `SessionKeepAliveService` is a `specialUse` foreground
service with a partial wake lock, started from `lib/keepAlive.ts` through
`keep_alive.rs`. Until a new WebView can reattach to sessions, `stopWithTask` makes
swiping the app away end them. If a repeat build's APK comes out about twice the size,
Gradle's incremental packaging left gaps in it: delete
`app/build/outputs/apk/universal/debug` and
`app/build/intermediates/incremental/packageUniversalDebug`, then rebuild.

This document was written against `44fbf52` on 2026-11-02, with uncommitted work
in `wr-ssh` and the renderer in the tree. Line numbers will move.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Where it lives | This repo, on `main` | The frontend and crates are almost entirely shared, and engine re-pins and fixes should reach Android without a merge. |
| First release | SSH, SFTP, telnet, vault, profiles | Local shells and USB serial need the most Android-specific work. |
| Design target | Phone with a soft keyboard | Tablets and hardware keyboards should follow from this, but not the other way around. |
| Android config | `src-tauri/tauri.android.conf.json` | Keeps the desktop's window settings out of the Android build. |

## What has been checked

**`cargo check --target aarch64-linux-android --locked` passes** for `wr-core`,
`wr-fs`, `wr-vault`, `wr-telnet`, `wr-sftp`, `wr-local` and `wr-serial`. That
proves they type-check, and nothing about how they behave on a device.

**`wr-ssh` passes too**, with NDK 30.0.16248370 and CMake 3.31.6 on `PATH` and the
`CC`, `CXX`, `AR` and `RANLIB` variables for the target pointing at the NDK. That
means the `aws-lc-sys` build script ran on a Windows host. Nothing has been linked
yet, and `x86_64-linux-android` hasn't been tried.

**`src-tauri` builds and links for `aarch64-linux-android`**, and
`npx tauri android build --debug --target aarch64 --apk` produces an APK signed with
the debug key. It's 279 MB, nearly all of it an unoptimized 272 MB library, so
release size is still unknown. On desktop, `cargo fmt --check` and clippy are clean
and the Tauri crate's tests pass.

**The toolchain this took:** Tauri's generated project uses Gradle 8.14.3 and Android
Gradle Plugin 8.11, which can't run on Android Studio's bundled Java 25. `JAVA_HOME`
points at a portable Temurin JDK 21 instead. These builds had CMake and the NDK's
tools on `PATH`, and the `CC`, `CXX`, `AR`, `RANLIB` and linker variables set for the
target, so a plain shell may need the same. Gradle downloaded build-tools 35 by itself.

**From dependency source:**

- `aws-lc-sys` 0.42.0 lists pregenerated bindings for `aarch64-linux-android`
  but not `x86_64-linux-android` (`builder/main.rs`, around line 841). An
  emulator build may therefore need `bindgen` and libclang when a phone build
  doesn't.
- `tauri-plugin-single-instance` and `tauri-plugin-window-state` both open with
  `#![cfg(not(any(target_os = "android", target_os = "ios")))]`, so their
  `init()` calls at `src-tauri/src/lib.rs:49` and `:64` won't resolve on Android.
- `keyring` 3.6.3 falls back to its mock store when a platform has no credential
  store enabled, and this app enables none for Android. Confirm on a device.

**Not checked, and assumed below:** that Tauri's clipboard, dialog, opener and
notification plugins cover what this app calls on Android, and that the CSP's
`http://ipc.localhost` entry is right there. The notification plugin also adds the
`RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK` and `POST_NOTIFICATIONS` permissions, which
are worth reviewing before a release.

## Risks, worst first

### 1. Soft keyboard input

`GhosttyInputHandler` is built around `keydown`. Text from an IME is sent only at
`compositionend` (`GhosttyInputHandler.ts:137`), `handleInput` drops anything
composing (`:146`), and it sends only `ie.data` (`:153`), so a
`deleteContentBackward` input sends nothing. `src/` has no reference to
`deleteContentBackward`.

Android keyboards commonly report `keyCode` 229 and compose whole words, so this
was expected to send text a word at a time and break Backspace. **On the first phone
tested, typing was reported as working fine**, so the existing path may be enough and
the design below is on hold. That's one phone and one keyboard, not yet identified.
Autocorrect, swipe typing, voice input and other keyboards are still untested.

The keyboard used to treat the terminal's input as ordinary text, showing a `sudo`
password in its suggestion strip and possibly learning it. `TextEntryHints.kt` now
marks every text field as no-suggestions and "visible password", which keyboards
honor where HTML attributes only ask, with personalized learning off. It reaches
`RustWebView` through `WRY_RUSTWEBVIEW_CLASS_EXTENSION` in `.cargo/config.toml`. This
trades away swipe typing and voice input. It also stops composing, so the composition
handling behind Ctrl may no longer be reached on most keyboards.

The likely design is a separate Android input path, leaving the desktop handler
alone:

- Keep sentinel text in the textarea so Backspace always has something to delete.
- On each `input`, diff the value against the last known value and send the
  difference, rather than trusting `data`.
- Turn off what the platform allows: `autocomplete`, `autocorrect`,
  `autocapitalize`, `spellcheck`.
- Reset the textarea after each send, without breaking the keyboard's composing
  state.

Test on Gboard, Samsung Keyboard and SwiftKey at minimum, including swipe typing,
autocorrect and voice input. They differ, and the emulator shows only one of them.

### 2. Sessions in the background

Two separate problems:

**The process being killed.** A foreground service is needed to hold connections.
Android 15 limits `dataSync` services to 6 hours in every 24, so that type can't
hold a long session. `specialUse` has no such limit, but its stated use case is
reviewed when submitting to Play. `connectedDevice` describes interactions with
external devices over a network, which is a possible but weaker fit. **Use
`specialUse`,** subject to the distribution question at the end.

**The WebView losing the terminal.** Terminal state lives in WASM inside the
WebView. Android can destroy the Activity while the process and service survive,
which would leave live SSH sessions with no screen or scrollback. The design for
this is under "Restoring a terminal" below.

Also find out what happens to `coalesce.rs` and the paced delivery in
`wr-core/src/paced.rs` when a backgrounded WebView stops draining. A full buffer
could stall the session or grow without limit, and neither was designed for a
consumer frozen for hours.

Network changes will kill TCP connections routinely on a phone. The existing
auto-reconnect should cover this, but its trigger conditions were written with
desktops in mind.

### 3. Touch

`src/` has no touch or pointer handlers; `GhosttyEngine.ts` and `Terminal.tsx` use
mouse and wheel events. The input textarea is `pointer-events: none`
(`GhosttyInputHandler.ts:62`), so a tap can't open the keyboard by itself.

Tap to focus already works, through the mouse events a tap synthesizes.

One-finger scrolling is in `TouchScroller.ts`, reported working on the test phone. A drag moves
scrollback with momentum, sends wheel reports to mouse-tracking programs, and sends
arrows on the alternate screen as DEC 1007 asks, so `less` and `man` scroll too. That
last one goes beyond the desktop wheel, which does nothing there. Neither of those
two gets momentum, since each row is input to a program.

Long-press is in `TouchSelection.ts` and `GhosttyEngine.touchLongPress`, and selection
was reported working on the test phone. On a word it selects, with handles and a Copy/Paste bar, and dragging
without lifting extends. On a URL it opens the existing link menu. On nothing it offers
Paste, through the same guard as every other paste. Android's own long-press
`contextmenu` is blocked on the canvas, because the terminal reads that as a right click,
which would paste the clipboard into the shell with no prompt for a single line.

Still needed: a look at the scrollbar, which only handles the mouse.

### 4. Build

`aws-lc-sys` was the one C dependency expected to cause trouble, and it compiled and
linked for ARM64 Android. Whether it runs correctly on a device is still untested. If
it doesn't, russh has a `ring` feature as a fallback, which would need target-specific
feature selection so the desktop build doesn't change.

## Restoring a terminal

**Decision: Ghostty snapshots plus a Rust-side buffer of the output since the last
snapshot.** The pinned core and the shipped WASM already export
`ghostty_snapshot_encode_*` and `ghostty_snapshot_decoder_*`.

**Built so far, neither used by the app yet:**

- `main/shim.ts` has `ghostty_terminal_track_continuation`, `_snapshot` and `_restore`,
  all streaming. A restored terminal gets the same setup as a new one, so it answers
  queries and counts bells. `main/snapshotShim.test.ts` covers this.
- `session_keep.rs` holds the snapshot and the output and resizes since it, by stream
  position, with a size cap and wiping on release.

**Reattaching is built, not yet tested on a phone.** `session_attach.rs` wraps each
session's channels when it starts, without touching `coalesce.rs` or
`session_registry.rs`: a `Channel::new` closure tees into `SessionKeep` and forwards to
whichever webview is attached, and returns `Ok` with none attached, so the forwarder
doesn't take a dead webview as the end of the session. `Terminal.tsx` saves a snapshot
when hidden and every 30 seconds if anything's new. A new webview lists what's running
and starts each pane from its snapshot, then replays the rest with replies, bells and
clipboard writes muted.

**Known limits:** a resize isn't recorded, so output since the snapshot replays at the
current size. A prompt raised while no webview was attached is lost. Replayed output can
still trigger a "command finished" notification, and an OSC cut by the snapshot isn't
dispatched. A reattached one-off SSH session holds no credentials, so Reconnect on it
needs them again.

**Observed with the developer option "Don't keep activities":** destroying the Activity
ended the whole process, with exit reason `EXIT_SELF`, status 0. Tauri exits when its
last window closes, and tao's Android window closes with the Activity. So the process
now refuses that exit while sessions are kept (`session_attach::on_run_event`) and builds
a new webview on the next Activity's resume. The option has to be set in the phone's
settings: `adb shell settings put global always_finish_activities 1` stores the value
but doesn't take effect.

Tauri's Android side assumes one Activity per process. `PluginManager` is a process-wide
object that keeps the first Activity, and each plugin keeps the one it was built with,
so `PluginActivityHandover` moves them over by reflection. Check it when updating Tauri.

A renderer that dies, by crash or to free memory, would take the app with it unless the
webview client says it's handled. So `MainActivity.onRendererGone` recreates the Activity,
at once or on the next resume, and wry builds another webview. To test it, send `Page.crash`
over the debug build's DevTools socket (`webview_devtools_remote_<pid>`).

Still lost: everything, if the process itself dies. Sessions can't outlive it, and
snapshots are only held in its memory.

A snapshot covers both screens, scrollback and an unfinished
escape sequence, which replaying output from a limited buffer can't do.

| What dies | SSH connection | Recovery |
|---|---|---|
| Activity, WebView or WebView renderer | Alive | Snapshot plus buffered output |
| The whole process | Gone | Restore tabs and reconnect; a `tmux` option keeps the remote session |

**The flow.** A snapshot has to be taken while the WebView is alive, so:

1. **Save.** The WebView takes a snapshot when the app is backgrounded and
   periodically while visible, then hands it to Rust with its position in that
   session's output stream.
2. **Buffer.** `coalesce.rs` keeps the output after that position, up to a limit
   across all sessions. A new snapshot releases what it covers.
3. **Restore.** A new WebView asks Rust for the live sessions, decodes each
   snapshot, feeds in the buffered bytes, then resumes the live stream.

**Requirements:**

- **Terminal tracking on from the start.** `GhosttyEngine` must set
  `GHOSTTY_TERMINAL_OPT_CONTINUATION_MAX_BYTES` before writing anything.
- **Replies muted during replay.** Buffered output can contain terminal queries,
  and answering them again would send stray input to the live shell. Bells,
  notifications, OSC 52 clipboard writes and progress updates must not fire again
  either. Restoring the snapshot itself parses no old output.
- **Engine adoption.** The decoder returns a new terminal, so the engine has to
  take it over and reinstall its callbacks and settings.
- **Reattaching channels.** Each session's output channel belongs to the old
  WebView, so `session_registry.rs` needs a reattach command. Stream positions
  must prevent bytes being lost or delivered twice during the handover.
- **Resizes.** A resize after the snapshot has to be recorded in the buffer, so
  the bytes replay at the size they were written for.
- **Snapshots stay in memory.** They hold screen contents and scrollback, so they
  are wiped on disconnect and not written to disk. The format has no
  compatibility guarantee yet, which is a second reason not to persist them.

**When the buffer overflows.** A session producing a lot of output while the
WebView is frozen can outrun the buffer, and no new snapshot can be taken. Restore
the last snapshot, drop the partial output, show a divider saying output was lost,
and change the PTY size by one column and back so full-screen programs repaint.

**Process death.** `sessionSnapshot.ts` and auto-reconnect restore tabs and
connections, though the vault may need unlocking first. A per-profile "start in
`tmux`" option (`tmux new -A -s wrustty`) keeps the remote session itself alive.

**Reducing how often it happens.** Tauri's generated manifest already keeps rotation
and keyboard changes from recreating the Activity. Run the foreground service from the first connection, and handle `onRenderProcessGone` so a renderer
crash doesn't end the app.

**What the core has been shown to do.** `main/snapshotRestore.test.ts` runs against
the shipped WASM, restoring into a separate instance each time:

- A sample session cut at every byte offset, snapshotted, restored and fed the
  remaining bytes matches an uninterrupted terminal. That covers escape sequences,
  OSC strings and UTF-8 characters cut in half, and the alt screen.
- Both screens, scrollback, modes, title, working directory, palette changes and
  scrollback caps come through. Damaged and truncated snapshots are rejected.
- Without tracking, encoding fails with `GHOSTTY_INVALID_VALUE` when a read ended
  mid-sequence, and works otherwise. An untracked engine would pass casual testing.

Not covered: the app's callbacks, its configured theme colors and cursor defaults.
The engine should reapply all of those after a restore.

**Use the streaming APIs only.** WASM memory never shrinks, so the allocating calls
permanently inflate a pane. `ghostty_snapshot_encode` with a writer and
`ghostty_snapshot_decoder_new` with a reader avoid that, and the writer produces
the same bytes. `SNAPSHOT_MEASURE=1` printed these on the desktop under Node, with
80 columns of repetitive text. Phones will be slower.

| Budget (starting heap) | Rows | Snapshot | Heap after encoding: allocating | Streaming, after 4 snapshots | Restored heap: from a buffer | From a reader |
|---|---|---|---|---|---|---|
| 8 MB (9 MB) | 11,920 | 2.8 MB | 25 MB | 9 MB | 13 MB | 9 MB |
| 32 MB (33 MB) | 48,787 | 11.5 MB | 65 MB | 34 MB | 49 MB | 34 MB |
| 64 MB (65 MB) | 97,943 | 23.1 MB | 193 MB | 66 MB | 97 MB | 66 MB |
| 128 MB (129 MB) | 195,909 | 46.2 MB | 257 MB | 129 MB | 193 MB | 130 MB |

Over four runs, streamed encoding typically took about 5, 19, 38 and 77 ms, and
decoding about 8, 31, 61 and 180 ms. Occasional runs were much slower (one 128 MB
decode took 645 ms), so a phone's worst case matters more than its average. Output
arrives in chunks of up to 162 KB. A writer that returns false gets
`GHOSTTY_IO_ERROR` and leaves the terminal working. Add `--reporter=verbose` to see
the printed figures; the default reporter hid them when I ran it.

What this leaves open:

- **Blocking the UI.** Encoding is synchronous on the JS thread, because that's
  where the engine lives. A long pause on a phone would limit how often snapshots
  can run. Measure on a mid-range phone in M4.
- **Memory outside WASM.** A snapshot is still its full size while it passes through
  JS and sits in Rust, on top of the buffered output. Snapshots need a limit across
  sessions, so an oversized one is refused rather than held.
- **IPC.** The writer callback is synchronous and `invoke` isn't, so chunks queue in
  JS until they're sent. Rust must keep the previous snapshot until the new one has
  fully arrived.
- **A small default.** Default Android to a small scrollback budget, which bounds all
  of the above. If periodic snapshots still cost too much, take them only on
  backgrounding and accept a staler restore when a visible WebView dies.

**Upstream since the pin.** Checked on 2026-11-02 against `e0acea2753`, 52 commits
past the pin. Only three changes touch `src/terminal/snapshot/`, and nothing changes
in `include/` or the snapshot test fixtures, so the format and the C API stay as
they are:

- **`ce920296c8` (OSC 133).** Skips the prompt scan in a full clear when no prompt
  was seen, and fixes a restore that lost `seen` while the cursor was in shell input.
  At the pin the clear doesn't read `seen`, so the bug has no effect here. After a
  re-pin it would, and this commit carries its own fix.
- **`41557e2ccf` (packed `Style`).** Colors are stored differently, and the snapshot
  fixtures didn't change.
- **`d20d208c51` (hyperlink map).** Sized separately for memory density. Its message
  says the snapshot format is unchanged.

**Run against that `main`.** `e0acea2753` plus `ghostty-main-esc-k.patch`, which still
applies, built with Zig 0.17.0 (SHA-256 `04c1486d...`). All of
`snapshotRestore.test.ts` passes through `GHOSTTY_VT_WASM`, including the OSC 133
scenario that now depends on restored state. Streaming stays flat on the heap, and
timing matches the pin within noise. Row counts at the same budgets are slightly
lower (11,674 against 11,920 at 8 MB, about 2%, and less at larger budgets), and output
chunks are up to 138 KB. Only this file ran against that build, so the rest of the
suite, the shim and the app have not been tried on it.

For the next re-pin:

- **Don't stop between `a3b5946a59` and `0d4418ac20`.** The first adds carried page
  capacity, and the second fixes an overflow it causes on wasm32 for terminals
  narrower than about 37 columns. A phone in portrait is often about that narrow.
- **Expect memory figures to move.** Carried pages, the hyperlink map and the larger
  style alignment all change page sizes. Re-run `SNAPSHOT_MEASURE=1` and
  `scrollbackLimit.test.ts`, which pins `SCROLLBACK_BYTES_PER_CELL`.
- **Run `snapshotRestore.test.ts` against the new build.** The format has no
  compatibility guarantee, so the test catches a re-pin that changes behavior. It
  wouldn't catch a snapshot from an older build, which is one reason they stay in
  memory.

## Rust gating

Done unless marked otherwise. Commands are gated with `#[cfg(desktop)]` in
`generate_handler!`, and the frontend hasn't been changed to match, so it will get
rejected `invoke`s for these until M1 and M3 deal with them.

| Item | Android |
|---|---|
| `tauri-plugin-single-instance`, `tauri-plugin-window-state` | In a non-mobile target table; registered under `cfg(desktop)`. |
| `window_effects.rs`, `attention.rs` | Gated out. `window-vibrancy` is still a dependency, unused. |
| `keyring` and `OsKeyringProvider` (`vault.rs`) | Still compiled but refused: `usable_on_this_platform` says no and enrolling returns an error, because the mock store loses the key. M5 replaces this. |
| `local.rs`, `local_open.rs`, `local_shells.rs`, `shell_icon.rs`, `elevation` | Gated out, since this app renders untrusted output and shouldn't leave a process-spawning command reachable. `wr-local` and its PTY code are out of the APK. |
| `sftp_edit_file` | Removed from the handler list, because it spawns a command the frontend supplies. The editing code it leaves unused is allowed as dead code in `sftp.rs` on Android. |
| `serial.rs` | Gated out for the first release. `wr-serial` stays a dependency because `profiles.rs` uses its types in the saved session format, so `to_config` is compiled out. |
| `putty_import.rs`, `ssh_config_import.rs`, `session_import.rs` | Gated out; there's no PuTTY registry or `~/.ssh/config` to read. |
| `fonts.rs` | **Not done.** Use bundled fonts plus the system monospace. |
| `session_lock.rs` | Already a no-op off Windows. **Not done:** lock the vault on Android's own lifecycle events instead. |
| `capabilities/` | `default.json` is limited to desktop platforms, and `mobile.json` drops the window permissions. |
| `tauri.android.conf.json` | Replaces the window list, dropping `transparent`, `decorations: false` and `visible: false`. |
| `src-tauri/gen/android` | Generated by `tauri android init`. Its manifest already lists `orientation`, `keyboard` and `screenSize` in `configChanges`, so those don't recreate the Activity. |

## Frontend

- **Platform flag.** A single build-time constant, so desktop-only UI drops out
  of the Android bundle.
- **Window APIs.** `getCurrentWindow()` calls in `App.tsx` and `TabBar.tsx`
  (`toggleMaximize`, `startDragging`, `onCloseRequested`) and all of `windowFit.ts`
  and `WindowControls.tsx` are desktop-only. `show()` at `App.tsx:300` and
  `onFocusChanged` at `:347` need checking on Android.
- **Key row.** `KeyRow.tsx` has Esc, Tab, one-shot Ctrl and Alt, arrows that repeat
  while held, and `|`, `~`, `/` and `-`. Keys are dispatched to the focused terminal's
  input, so they pass through `KeyEncoder` and modes such as application cursor keys
  and Kitty stay correct. An armed modifier applies to the next key from the row or
  the keyboard (`lib/softModifiers.ts`), without waiting for a composing keyboard to
  finish its word, which ends that composition by refocusing the input. Reported
  working on the test phone.
- **Viewport.** When the keyboard opens, the grid keeps its size and slides to keep the
  cursor visible (`lib/keyboardHold.ts`). Resizing it for the host made inline programs like
  Claude Code redraw over their own output on every open and close.
- **Layout.** The toolbar is the top row and the tabs the second, with no window
  controls. The split buttons are hidden, toolbar buttons are finger-sized through
  `.touch-toolbar` in `index.css`, and its menus anchor to the toolbar so they stay on
  screen. A menu of rarely used actions wouldn't win back height while the tabs have
  their own row, so all seven buttons stay out. Not done: dialogs (`ConnectDialog`,
  `SettingsDialog`, `SessionBrowser`) going full screen, and anything that depends on
  hover, including the pane controls in `Pane.tsx`.
- **Keybindings.** Keep them for hardware keyboards and hide the editor.
- **Performance.** Run the harness in `src/bench` on a mid-range phone.
  `CONTEXT_BUDGET = 8` (`ContextManager.ts:14`) and glyph atlas memory are the
  first things to look at.

## Vault

`KeyProvider` in `wr-vault/src/provider.rs` already allows for async, user-gesture
providers, so an Android provider fits the existing shape.

- **The password stays as the fallback**, and always works.
- **Biometric unlock is reported working on the test phone.** `VaultBiometricPlugin.kt`
  and `android_biometric.rs` add a `WrapperKind::AndroidBiometric` provider. A Keystore
  key that needs a strong biometric for every use, through `CryptoObject`, encrypts a
  random KEK, and only that ciphertext goes in the vault file. A new fingerprint or face
  enrollment invalidates the key, which maps to `ProviderError::Invalidated`. It's our
  own small plugin rather than `tauri-plugin-biometry`, a third-party crate that would
  sit directly on the vault's key material.
- **File format:** the new kind is a format addition. A desktop build from before it
  can't parse a vault file holding one, so export from a phone with biometrics on needs
  a current desktop build to open. A current build ignores the wrapper and asks for the
  master password, as a phone does with a Hello wrapper.
- **Importing:** `read_picked` and `write_picked` in `vault.rs` handle the picker's
  `content://` links through `DeviceFilesPlugin.kt`. They used to look like a cancel.
- **Desktop exports:** serial and local sessions stay on disk but aren't listed
  (`openableHere`), so an export from the phone keeps them. A session with a key path
  says so when opened, and editing it asks for the key to store in the vault.

## SSH keys and files

- `expand_tilde` (`wr-ssh/src/session.rs:950`) and any stored key path assume a
  normal filesystem, so saved profiles that point at a key file won't carry over.
  Import keys through the document picker into the vault or app-private storage.
- There's no agent support on Android for the first release.
- The Android file picker returns `content://` URIs, while `FilesPanel` and
  `wr-sftp` work with paths. An upload streams from a file descriptor that
  `DeviceFilesPlugin.open` gets from `ContentResolver`. A download goes to a private
  cache directory and is copied to the link when whole, so retries and staging work as
  on desktop, at the cost of holding the file twice for a moment.
- A workspace from a desktop opens flattened, one pane to a tab, skipping what a phone
  can't open (`flattenForPhone`). Splits aren't offered on a phone, and a reattached
  session comes back as its own tab anyway.
- Not on Android yet: folder transfers, which need a tree picker, and remote editing, since
  there's no external editor to launch. Tapping a file downloads it. A transfer keeps
  running if the screen is rebuilt, but its row in the panel doesn't come back.

## Milestones

Each one ends with something to check, and they run in order. M2 and M4 hold the
risks most likely to change the plan, so they come before the polish.

| | Goal | Done when |
|---|---|---|
| **M0** | Toolchain and Rust build | `wr-ssh` and `src-tauri` build for `aarch64-linux-android`; a debug APK installs. |
| **M1** | First light | On a phone: connect over SSH, see a correctly rendered terminal, run `vim` and `htop` with the desktop's parser and renderer. |
| **M2** | Input | Typing, Backspace, swipe and autocorrect work on three keyboards. Key row and scrolling work. |
| **M3** | Phone layout | Everything in scope is reachable one-handed, with no desktop chrome. |
| **M4** | Staying alive | A session survives an hour in the background, a screen lock, a Wi-Fi to cellular change and an Activity kill (developer option "Don't keep activities"). A killed WebView restores screen, scrollback and modes from a snapshot. |
| **M5** | Secrets and files | Vault unlock, key import and SFTP transfers both ways. |
| **M6** | Ship | CI builds Android, release signing is set up, a build reaches testers. |

## Testing

Nothing here reaches a live host or a real keyboard on its own, so M1 onward needs
Tim to test on a phone. Add logging for the raw `keydown`, `beforeinput`, `input`
and composition events first, so a failed test comes back with evidence.

The emulator is for build and layout checks only. It runs `x86_64`, the target
that may need extra binding generation, so **a real `arm64` phone should be the
main target from M1.** Only `aarch64-linux-android` and `x86_64-linux-android` are
needed; Tauri's docs also list `armv7` and `i686`, which can wait.

CI's `android` job runs clippy against the Android target, so desktop work can't quietly
break the gating. It packages a debug APK only for a tag or a manual run.

A release build reads its key's location and password from
`src-tauri/gen/android/keystore.properties`, which Git ignores, with `storeFile`,
`keyAlias` and `password`. Without that file it comes out unsigned. The key has to stay
the same for an install to accept an update, so it needs a backup.

## Open questions

1. **Distribution.** Play, sideloaded APKs, or F-Droid? This decides how much the
   `specialUse` review and Play's foreground service declarations matter.
2. **Minimum Android version.** Depends on the WebView features the input path
   ends up needing.
3. **Which phone** M1 and M2 are tested on, and which keyboard is on it.

## References

- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
- [Foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types)
- [Foreground service timeouts](https://developer.android.com/develop/background-work/services/fg-service-timeout)
- [tauri-plugin-biometry](https://docs.rs/crate/tauri-plugin-biometry/latest)
