# Third-party notices

Attribution and licence notices for third-party material distributed with
wRusTTY. Rust and npm dependencies carry their own licences in their packages;
this file covers material that is embedded in the application's own source and
therefore has nowhere else to declare itself.

## Ghostty — terminal engine

`src/lib/ghostty/vendor/ghostty-vt.wasm` is compiled from
[Ghostty](https://github.com/ghostty-org/ghostty) at the commit recorded in
that directory's README, with the patches in `patches/` applied. The same
credit appears in the application's About panel, since the binary ships inside
the installer.

```text
MIT License

Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Shell icons

Local session tabs show an icon for the shell they launch. Where those icons
come from depends on whether the mark may be redistributed.

### Git logo — bundled, attribution required

The Git logo is by **Jason Long** and is licensed under the
[Creative Commons Attribution 3.0 Unported License][cc-by-3].

This is a licence condition rather than a courtesy: CC BY requires the credit
above to travel with any distribution of the mark, including this one. It is
repeated in the application's About panel for that reason.

### Linux (Tux) — bundled

The Linux penguin identifies a WSL distribution. "Linux" is a registered
trademark of **Linus Torvalds**, and the penguin derives from Larry Ewing's
original. Used referentially, next to the product it identifies.

### PowerShell and Command Prompt — not distributed

wRusTTY ships **no** PowerShell or Command Prompt artwork. Microsoft's
trademark terms prohibit using its logos without permission — the reason
Simple Icons removed every Microsoft brand in 2024 ([simple-icons#10019][si-ms]).

Instead, the icon a tab shows for these shells is read at runtime from the
shell's own executable (`pwsh.exe`, `powershell.exe`, `cmd.exe`) on the
machine it is installed on — the same icon Windows itself shows for that file.
Nothing is copied into the application. Where that read is not possible, a
neutral `>_` glyph original to this project is shown instead.

PowerShell and Windows are trademarks of **Microsoft Corporation**, which
neither sponsors nor endorses this project.

### Rendering source

The Git and Linux path data, and their brand colours, are taken from
[Simple Icons][si], which releases its renderings under [CC0 1.0][cc0]. CC0
waives copyright in the drawing; it does not affect the trademarks above,
which remain with their owners. Simple Icons' own guidance says the same:
brand icons should be used only to represent the company or product they
refer to.

[cc-by-3]: https://creativecommons.org/licenses/by/3.0/
[si]: https://simpleicons.org
[si-ms]: https://github.com/simple-icons/simple-icons/pull/10019
[cc0]: https://creativecommons.org/publicdomain/zero/1.0/
