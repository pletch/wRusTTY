# PPK test fixtures

These two files are **real Ed25519 private keys in PuTTY's PPK-3 format**, and
they are here on purpose.

| File | Encryption | Passphrase |
|---|---|---|
| `id_ed25519.ppk` | none | — |
| `id_ed25519_enc.ppk` | `aes256-cbc`, Argon2id | `123` |

## Why they are committed

`load_private_key` has to decode the real PuTTY-3 container — including the
Argon2id KDF on the encrypted one — and a parser test that feeds itself a
synthetic file only ever proves the parser agrees with itself. Committing known
good inputs is the normal way to test a key parser, and it is why the encrypted
fixture's passphrase is written down above rather than hidden: a test that
cannot decrypt its own fixture tests nothing.

They are consumed via `include_str!` from `ppk_tests` in
`crates/wr-ssh/src/session.rs`, copied into a `tempfile` directory at test time,
and never read from this path by anything that runs in the shipped app.

## Provenance

Borrowed from the [`ssh-key`](https://github.com/RustCrypto/SSH) crate's own
test suite (Apache-2.0 / MIT). They are upstream test vectors, not keys
generated for this repository — which also means they are public, and have been
for as long as that crate has existed.

## If a secret scanner flags these

It will, and it is not wrong to: they match every private-key signature there
is. GitHub push protection, `gitleaks`, `trufflehog` and corporate scanners all
have a reason to stop here. That is expected, and this file exists so the next
person — including a future you — does not have to re-derive the answer under
time pressure.

**They correspond to no real host, guard nothing, and grant access to nothing.**
Allowlist them by path rather than disabling the scanner, and if you add such an
entry, point it at this README.

**Never reuse these keys for anything.** They are published in at least two
public repositories. Treat them as compromised by construction, because they
are.
