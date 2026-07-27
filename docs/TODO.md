# TODO

Open items with enough context to pick up cold. Design decisions and the
gotchas already found live here so they don't have to be rediscovered — see
PROJECT_PLAN.md for the phased plan this sits alongside.

## Rounded tab corners

Windows 11 apps (Edge, Windows Terminal, File Explorer) round the top corners
of tabs. wRusTTY's are square.

**The modest version** — `rounded-t-lg` on the tab div in `TabBar.tsx`, plus
one required companion change:

- The pane map is `absolute inset-x-0 top-0`, anchored to the exact edge the
  radius eats. At an 8px radius the fill is inset ~8px per side at y=0,
  tapering to ~2.7px by y=2, so a 2px bar would render as a stub with its
  ends chewed off. Change it to `inset-x-2` so it sits on the straight part
  of the top edge. Costs 16px of a 130px minimum tab, which it can spare.
- Content padding needs nothing: `px-3` (12px) already clears an 8px radius.
- The radius is only ever *visible* on the active tab and on hover, since
  inactive tabs have no background at all (`bg-white/10` on active,
  `hover:bg-white/[0.06]` otherwise). Small change, correspondingly small
  risk.

**The full version, as a separate decision.** In Edge and Windows Terminal
the rounding works because the active tab's fill matches the content area
behind it and the strip's bottom border breaks underneath it, so the tab
reads as continuous with the page below. Here the active tab is a translucent
white overlay above an unrelated dark terminal, with an unbroken `border-b`
on the strip — so the modest version gets the shape of the convention without
the thing the shape is *for*. Doing it properly means the active tab's fill
matching the terminal background and interrupting that border, which
interacts with the vibrancy/opacity settings since the terminal background
isn't a fixed colour.

## Settings not yet exposed

Raised while reorganising settings into a dialog.

- **Logging: auto-start per session, and a configurable path.** Logging is
  manual and writes to a fixed location.
- **Custom theme colours.** Presets only, no import of an existing scheme.
- Lower still: selection word separators, scroll sensitivity, rebindable keys.

## Watch: cursor position after closing a tab

Fixed in 872b9b3 by giving `closeTabNow` the `refit()` every other
visibility-changing path already had. That fix is probabilistic, not proven —
the race is too rare to reproduce on demand, so what it claims is parity with
its siblings, not a bug observed disappearing.

If the cursor lands a few columns off after a tab close *again*, the
transitional-size theory is wrong and the next place to look is the
`ResizeObserver` / WebGL-reload interaction in `Terminal.tsx:786`.
