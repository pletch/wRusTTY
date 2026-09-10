# Third-party notices

Attribution and licence notices for third-party material distributed with
wRusTTY. Rust and npm dependencies carry their own licences in their packages;
this file covers material that is embedded in the application's own source and
therefore has nowhere else to declare itself.

## Shell icons

`src/components/ShellIcons.tsx` embeds four glyphs used to identify which shell
a local session opens. They appear only next to a session that launches that
product — they identify it, and are never used as branding for wRusTTY, which
has its own icon.

### Git logo — attribution required

The Git logo is by **Jason Long** and is licensed under the
[Creative Commons Attribution 3.0 Unported License][cc-by-3].

This is a licence condition rather than a courtesy: CC BY requires the credit
above to travel with any distribution of the mark, including this one.

### PowerShell

The PowerShell logo is a trademark of **Microsoft Corporation**. It is used
here referentially, to identify Microsoft's PowerShell where wRusTTY launches
it. Microsoft neither sponsors nor endorses this project.

PowerShell itself is open source under the MIT licence, but that licence covers
the software; the mark is not licensed by it.

### Linux (Tux)

The Linux penguin identifies a WSL distribution. "Linux" is a registered
trademark of **Linus Torvalds**, and the penguin derives from Larry Ewing's
original. Used referentially, as above.

### Command prompt

The `>_` glyph is original to this project. `cmd.exe` has no mark of its own,
and this is drawn rather than borrowed.

### Rendering source

The PowerShell, Git and Linux path data are taken from [Simple Icons][si],
which releases its renderings under [CC0 1.0][cc0]. CC0 waives copyright in the
drawing; it does not affect the trademarks above, which remain with their
owners. Simple Icons' own guidance says the same: brand icons should be used
only to represent the company or product they refer to.

[cc-by-3]: https://creativecommons.org/licenses/by/3.0/
[si]: https://simpleicons.org
[cc0]: https://creativecommons.org/publicdomain/zero/1.0/
