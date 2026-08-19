# `ghostty-main-esc-k.patch`

The **only** fix we still carry against ghostty `main`, and the whole residual
patch burden of the port: 24 lines across two files, against the 1,648 lines of
`ghostty-131-wasm-api.patch` that the v1.3.1 build needs.

Rebased onto the port's pin, `d9ffbbf17c11f570897a49d4c722130e8698d93b`.

```sh
git apply ../patches/ghostty-main-esc-k.patch
```

## What it does

Adds a `screen_title_string` parser state and routes `ESC k` into it, so the
GNU screen / tmux title sequence `ESC k <text> ST` has its payload **consumed
instead of printed**. Without it, `ESC k SCREENTITLE ST` renders `SCREENTITLE`
onto the grid — verified against a stock `main` build, not assumed.

This is `ghostty-web` PR #176, still unmerged and still absent from `main`.
`main` has no `screen_title` state and no `0x6B` transition in
`parse_table.zig` at all, which is worth being precise about: it is **not** a
matter of registering an effect callback. A parser with no state for a sequence
prints the payload whatever the embedder configures.

## Why it is so small a rebase

The two files it touches are **byte-identical between v1.3.1 and the pin** — the
pre-image blob hashes in this patch (`88e7edf` for `Parser.zig`, `01bd569` for
`parse_table.zig`) are the same ones the v1.3.1 patch carries. So this is the
1.3.1 hunks with nothing to adapt, only the surrounding comments rewritten.

The state block is modelled on `main`'s own `osc_string`, with one deliberate
addition: `osc_string` terminates on BEL (`0x07`) only, while this also accepts
the 8-bit ST (`0x9C`). The 7-bit `ESC \` form needs no entry — it leaves through
the anywhere-ESC transition that already exists.

## The check that it took

`src/lib/ghostty/main/abi.parity.test.ts` carries an `ESC k` case. Against an
**unpatched** build it asserts `SCREENTITLE` *does* reach the grid; against a
patched one that assertion must be inverted. If it fails after a rebuild, the
patch did not apply — which is the point of testing a behaviour rather than
trusting `git apply`'s exit code.

## Upstreaming

Worth sending. It is small, self-contained, and fixes a real rendering bug for
anyone running screen or tmux; upstream taking it would leave this project
carrying **no patch at all** against `main`. Until then it has to be reapplied
on every rebuild, which is why the build recipe in
`docs/PORT_GHOSTTY_MAIN.md` names it explicitly.
