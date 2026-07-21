# Shell integration

wRusTTY can show which panes have a command running, and notify you when a
long one finishes in a tab you aren't looking at. Both come from the *remote
shell* telling us, using OSC 133 — the "semantic prompt" escape sequences
also understood by iTerm2, kitty, WezTerm, Windows Terminal and VS Code.

This has to come from the far end. A terminal that spawns its own shell can
ask the OS which process has the PTY's foreground process group; wRusTTY
holds a socket or a serial port, and the process it would be asking about is
on another machine. The shell saying so out of band is the only reliable
source, which is why there is a setup step at all.

Nothing breaks without it — panes simply never show a spinner, and command
notifications never fire. The bell marker (below) needs no setup.

## Installing it

Settings (the gear icon) has **Shell integration** with a copy button per
shell — that puts the right snippet on your clipboard, ready to paste into
the host's rc file. The snippets below are the same text, reproduced for
reading here; the canonical copies live in `src/lib/shellSnippets.ts`, so
changing one means changing the other.

It's a per-host, one-time job, and it isn't wRusTTY-specific: the sequences
are a standard, so a host with this installed also lights up iTerm2, kitty,
WezTerm, Windows Terminal and VS Code. Terminals that don't implement OSC 133
discard it, the same way they discard the title-setting sequences already in
most people's `PS1`.

To push it to a host without pasting:

```sh
ssh myhost 'cat >> ~/.bashrc' < snippet.sh
```

## The sequences

| Sequence | Meaning |
| --- | --- |
| `OSC 133 ; A ST` | a prompt is about to be drawn |
| `OSC 133 ; C ST` | a command is executing, output follows |
| `OSC 133 ; D ; <code> ST` | the command finished, with its exit status |
| `OSC 633 ; E ; <cmdline> ST` | the command line as text (VS Code's extension) |

`OSC` is `ESC ]`, `ST` is `BEL` (`\a`) in every snippet below.

Two notes on what's deliberately *not* here. The spec also defines
`OSC 133 ; B ST` (prompt drawn, input starts) — wRusTTY doesn't need it, so
none of these snippets modify `PS1`, which is the part most likely to fight
with a prompt framework like starship or powerlevel10k. And `E` is optional:
without it everything still works, notifications just say "Command" instead
of naming what ran.

## bash

Add to `~/.bashrc` on the remote host:

```bash
# Shell integration: OSC 133 semantic-prompt sequences, which tell the
# terminal when a command starts, when it ends, and with what exit status.
# Understood by iTerm2, kitty, WezTerm, Windows Terminal, VS Code and wRusTTY;
# silently discarded by terminals that don't implement them.
# Emits nothing in a non-interactive shell, so scp/rsync/git-over-ssh are
# unaffected — do not remove the `$-` test below.
if [[ $- == *i* && -z $__osc133_installed ]]; then
  __osc133_installed=1
  __osc133_ready=0
  __osc133_running=0

  __osc133_precmd() {
    local __st=$?
    # Disarm for the rest of the prompt cycle. Anything that runs between
    # here and __osc133_arm is prompt machinery — your own PROMPT_COMMAND
    # entries, whatever starship or vte.sh installed — not a command you
    # typed, and must not be reported as one.
    __osc133_ready=0
    if (( __osc133_running )); then
      printf '\e]133;D;%s\a' "$__st"
      __osc133_running=0
    fi
    printf '\e]133;A\a'
  }

  # Runs last in PROMPT_COMMAND, so the next command to fire the DEBUG trap
  # really is one you typed.
  __osc133_arm() { __osc133_ready=1; }

  __osc133_preexec() {
    # Programmable completion also fires the DEBUG trap; it isn't a command.
    [[ -n $COMP_LINE ]] && return
    case $BASH_COMMAND in
      # Our own hooks. DEBUG fires for __osc133_precmd *before* it runs, so
      # it can't have disarmed yet — without this, pressing Enter on an empty
      # prompt reports the prompt hook itself as the command that just ran.
      __osc133_*) return ;;
      # Functions bound to a key with `bind -x` fire the DEBUG trap too, but
      # they run from readline rather than from a line you typed. systemd's
      # OSC context integration (systemd 257+, /etc/profile.d) binds one to
      # Enter, so without this every Enter — including on an empty prompt —
      # looks like a command starting, and consumes the flag before your real
      # command can. Add others here the same way if your host has them.
      __systemd_osc_context_*) return ;;
    esac
    # Only the first command of an entered line, not each stage of a pipeline
    # — otherwise a pipeline reports only its last stage's duration.
    (( __osc133_ready )) || return
    __osc133_ready=0
    __osc133_running=1
    # Escape the command text so a `;` in it can't read as a field separator.
    # Via a variable holding the backslash, rather than writing the escapes
    # inline: surviving both the double quotes and the replacement's own
    # unescaping takes four of them, and getting it wrong fails quietly.
    local bs='\'
    local cmd=$BASH_COMMAND
    cmd=${cmd//"$bs"/"$bs$bs"}
    printf '\e]633;E;%s\a' "${cmd//;/"${bs}x3b"}"
    printf '\e]133;C\a'
  }

  trap '__osc133_preexec' DEBUG
  # precmd first, so it reads the real $? of the command that just ended;
  # arm last, after any pre-existing entries have had their turn.
  PROMPT_COMMAND="__osc133_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND};__osc133_arm"
fi
```

If you have set `PROMPT_COMMAND` as an *array* (bash 5.1+, uncommon), use
`PROMPT_COMMAND=(__osc133_precmd "${PROMPT_COMMAND[@]}" __osc133_arm)` on that
last line instead — the string assignment above would replace it.

The ordering there is the whole trick, and is worth preserving if you rework
this. Arming the flag inside `__osc133_precmd` instead of in a separate entry
at the end means any pre-existing `PROMPT_COMMAND` — Debian's default
`.bashrc`, `vte.sh`, starship — runs while armed and gets reported as the
command you ran, which pins the terminal at "a command is running" forever.

## zsh

Add to `~/.zshrc`. zsh has real `preexec`/`precmd` hooks, so there's no
DEBUG-trap bookkeeping:

```zsh
# Shell integration: OSC 133 semantic-prompt sequences, which tell the
# terminal when a command starts, when it ends, and with what exit status.
# Understood by iTerm2, kitty, WezTerm, Windows Terminal, VS Code and wRusTTY;
# silently discarded by terminals that don't implement them.
# zsh has real preexec/precmd hooks, so there's no DEBUG-trap bookkeeping.
__osc133_running=0

__osc133_precmd() {
  # Not `local status=$?` — zsh's `status` is a special parameter (a synonym
  # for `?`), so shadowing it is asking for trouble.
  local __st=$?
  if (( __osc133_running )); then
    print -n "\e]133;D;$__st\a"
    __osc133_running=0
  fi
  print -n "\e]133;A\a"
}

__osc133_preexec() {
  __osc133_running=1
  # Escaped through a variable holding the backslash — writing the escapes
  # inline needs four of them to survive, and fails quietly if miscounted.
  local bs='\'
  local cmd=$1
  cmd=${cmd//"$bs"/"$bs$bs"}
  print -n "\e]633;E;${cmd//;/"${bs}x3b"}\a"
  print -n "\e]133;C\a"
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd __osc133_precmd
add-zsh-hook preexec __osc133_preexec
```

## fish

Add to `~/.config/fish/config.fish`:

```fish
# Shell integration: OSC 133 semantic-prompt sequences, which tell the
# terminal when a command starts, when it ends, and with what exit status.
# Understood by iTerm2, kitty, WezTerm, Windows Terminal, VS Code and wRusTTY;
# silently discarded by terminals that don't implement them.
function __osc133_prompt --on-event fish_prompt
    printf '\e]133;A\a'
end

function __osc133_preexec --on-event fish_preexec
    set -l cmd (string replace -a '\\' '\\\\' -- $argv[1])
    printf '\e]633;E;%s\a' (string replace -a ';' '\\x3b' -- $cmd)
    printf '\e]133;C\a'
end

function __osc133_postexec --on-event fish_postexec
    set -l status_code $status
    printf '\e]133;D;%s\a' $status_code
end
```

## Checking it works

You don't need any of the above to test the wRusTTY side. Paste this into
any connected pane — it fakes a 15-second command by hand:

```sh
printf '\e]133;C\a'; sleep 15; printf '\e]133;D;0\a'
```

The tab should show a spinner in place of its protocol icon for 15 seconds.
Switch to another tab before it finishes and you should get a toast plus an
amber marker on the tab you left. Change the `0` to a `1` and the toast turns
into an error.

To check the exit-code path with real integration installed, `sleep 15; false`
should notify as `exited 1`.

## What gets notified

A completion only raises a toast when all of these hold:

- **Notify on command completion** is enabled in settings (it is by default).
- The command took at least 10 seconds. Below that you were probably still
  watching, and per-command toasts for `ls` would train you to ignore them.
- Its tab isn't the one on screen in a focused window. If you watched it
  finish, you don't need telling.
- It never entered the alternate screen. Quitting `vim` after twenty minutes
  is not a background job landing.

## Bell

Separately, and with no setup at all, a `BEL` from the far end marks its tab
with the same amber dot until you visit it (**Bell marks the tab** in
settings). This works on anything that can write a byte, including network
gear that will never have OSC 133:

```sh
long-running-thing; printf '\a'
```

## Caveats

- **Keep the interactive guard.** bash detects stdin being a network socket
  (as when run by sshd) and sources `~/.bashrc` even for non-interactive
  commands, so `ssh host 'some command'`, `scp`, `rsync` and git-over-ssh all
  execute it. Anything an rc file writes to stdout corrupts those binary
  protocol streams — it's a classic cause of "scp suddenly broke". The
  `[[ $- == *i* ]]` test at the top of the bash snippet is what prevents it,
  and is not decoration.
- **Anything bound to a key with `bind -x` fires the DEBUG trap too.** It runs
  from readline rather than from a line you typed, so it looks like a command
  starting on every keypress it's bound to. systemd 257+ ships exactly this —
  `__systemd_osc_context_precmdline`, bound to Enter from `/etc/profile.d` —
  and the snippet skips it by name. If a spinner runs continuously on an idle
  prompt, that's the shape of the problem; find the culprit by adding
  `printf '[dbg <%s>]\n' "$BASH_COMMAND"` at the top of `__osc133_preexec`,
  pressing Enter on an empty prompt, and adding whatever it names to the
  `case` list.
- Don't stack this alongside iTerm2's or VS Code's own installed integration
  on the same host: two installs means two `D` reports per command. wRusTTY
  ignores the duplicate (a `D` with nothing running is dropped), but other
  clients may be less forgiving.
- The sequences are emitted into the session's byte stream, so they land in
  session logs too. Plain-text logging (on by default) strips them.
- A `sudo -i`, `su`, or nested `screen`/`tmux` shell has its own startup
  files; integration installed for your login shell doesn't follow you in.
- In bash, a line that is *entirely* a subshell or group — `(make all)`,
  `{ make all; }` — doesn't fire the DEBUG trap, so it goes untracked. Run
  `make all` directly, or `time (make all)`, and it reports normally. zsh and
  fish have real hooks and don't have this gap.
- If a connection drops mid-command, the in-flight command is discarded
  silently rather than reported — its real outcome isn't knowable from here.
