# Shell integration

wRusTTY can show which panes have a command running, notify you when a long
one finishes in a tab you aren't looking at, and know which directory a pane
is sitting in. All three come from the *remote shell* telling us: OSC 133 —
the "semantic prompt" escape sequences also understood by iTerm2, kitty,
WezTerm, Windows Terminal and VS Code — and OSC 7 for the directory.

This has to come from the far end. A terminal that spawns its own shell can
ask the OS which process has the PTY's foreground process group, and what its
cwd is; wRusTTY holds a socket or a serial port, and the process it would be
asking about is on another machine. The shell saying so out of band is the
only reliable source, which is why there is a setup step at all.

Nothing breaks without it — a pane's segment of the tab strip simply never
shows the running marker, command notifications never fire, and the status bar
shows no directory. The one place the absence is felt rather than merely
missed is **drag-and-drop upload**: with no reported directory there is
nowhere to put the file, so the pane asks for a destination every time
instead of defaulting to where you are (see `lib/dropUpload.ts` — guessing
`~`, or scraping it off the prompt, is how a file ends up somewhere nobody
asked for).

The bell marker needs no setup, and neither do the sequences a program emits
about itself — see "Programs that report for themselves" below, which is also
the only thing that reports anything while a full-screen program is up.

## Installing it

Settings (the gear icon) → **Shell integration** has a copy button per
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
| `OSC 7 ; file://<host>/<path> ST` | the working directory |

`OSC` is `ESC ]`, `ST` is `BEL` (`\a`) in every snippet below.

OSC 7's path is percent-encoded, and the snippets encode it by hand rather
than calling out to python: this runs on every prompt, on hosts that are
often a jump box or an appliance, where a fork per prompt is felt and python
may not exist. The encoders walk *bytes* — under `LC_ALL=C`, in a subshell —
because in a UTF-8 locale the shell reads a multi-byte character as one
character and encodes its codepoint, which puts `%E9` on the wire for `é`
where the URL grammar wants `%C3%A9`.

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
# terminal when a command starts, when it ends, and with what exit status,
# plus OSC 7, which tells it what directory you are in.
# Understood by iTerm2, kitty, WezTerm, Windows Terminal, VS Code and wRusTTY;
# silently discarded by terminals that don't implement them.
# Emits nothing in a non-interactive shell, so scp/rsync/git-over-ssh are
# unaffected — do not remove the `$-` test below.
if [[ $- == *i* && -z $__osc133_installed ]]; then
  __osc133_installed=1
  __osc133_ready=0
  __osc133_running=0

  # OSC 7: the working directory, as a percent-encoded file:// URL.
  __osc7_encode() (
    LC_ALL=C
    local str=$1 safe
    while [[ -n $str ]]; do
      # The longest prefix of characters that need no escaping, then one
      # character that does. RFC 3986's unreserved set, plus the separator.
      safe=${str%%[!a-zA-Z0-9/._~-]*}
      printf '%s' "$safe"
      str=${str#"$safe"}
      if [[ -n $str ]]; then
        # A leading quote makes printf take the character's numeric value.
        printf '%%%02X' "'$str"
        str=${str#?}
      fi
    done
  )

  # Resolved once: it cannot change for the life of the shell, and `hostname`
  # is a fork. HOSTNAME first for bash, HOST for zsh, the command for neither.
  __osc7_host=${HOSTNAME:-${HOST:-$(hostname 2>/dev/null)}}

  __osc7_report() {
    printf '\e]7;file://%s%s\a' "$__osc7_host" "$(__osc7_encode "$PWD")"
  }

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
    __osc7_report
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
      # The OSC 7 reporter is only ever called from inside precmd, which has
      # disarmed by then, but it is named here so that stays true if it is
      # ever hooked up somewhere else.
      __osc133_*|__osc7_*) return ;;
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
# terminal when a command starts, when it ends, and with what exit status,
# plus OSC 7, which tells it what directory you are in.
# Understood by iTerm2, kitty, WezTerm, Windows Terminal, VS Code and wRusTTY;
# silently discarded by terminals that don't implement them.
# zsh has real preexec/precmd hooks, so there's no DEBUG-trap bookkeeping.
__osc133_running=0

# OSC 7: the working directory, as a percent-encoded file:// URL.
__osc7_encode() (
  LC_ALL=C
  local str=$1 safe
  while [[ -n $str ]]; do
    # The longest prefix of characters that need no escaping, then one
    # character that does. RFC 3986's unreserved set, plus the separator.
    safe=${str%%[!a-zA-Z0-9/._~-]*}
    printf '%s' "$safe"
    str=${str#"$safe"}
    if [[ -n $str ]]; then
      # A leading quote makes printf take the character's numeric value.
      printf '%%%02X' "'$str"
      str=${str#?}
    fi
  done
)

# Resolved once: it cannot change for the life of the shell, and `hostname`
# is a fork. HOSTNAME first for bash, HOST for zsh, the command for neither.
__osc7_host=${HOSTNAME:-${HOST:-$(hostname 2>/dev/null)}}

__osc7_report() {
  printf '\e]7;file://%s%s\a' "$__osc7_host" "$(__osc7_encode "$PWD")"
}

__osc133_precmd() {
  # Not `local status=$?` — zsh's `status` is a special parameter (a synonym
  # for `?`), so shadowing it is asking for trouble.
  local __st=$?
  if (( __osc133_running )); then
    print -n "\e]133;D;$__st\a"
    __osc133_running=0
  fi
  __osc7_report
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
# terminal when a command starts, when it ends, and with what exit status,
# plus OSC 7, which tells it what directory you are in.
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

# OSC 7: the working directory. fish already reports this itself, from
# __update_cwd_osc in __fish_config_interactive.fish, so this only fills in
# for a build that doesn't — two reporters would emit every directory change
# twice. No hand-rolled encoder either, because fish has one.
if not functions -q __update_cwd_osc
    function __osc7_report --on-variable PWD
        # A command substitution's output is being captured, not displayed.
        status is-command-substitution; and return
        # --style=url escapes the separators too. They are put back because a
        # path with %2F through it is the kind of thing a human has to decode
        # by hand when it turns up in a status bar or an error message.
        printf '\e]7;file://%s%s\a' $hostname (string escape --style=url -- $PWD | string replace -ai %2F /)
    end
    __osc7_report
end
```

## PowerShell

Written for and tested on PowerShell 7 (`pwsh`); Windows PowerShell 5.1 is
not covered. Add to the file `$PROFILE` names — by default
`~\Documents\PowerShell\Microsoft.PowerShell_profile.ps1` — and put it **last**,
after anything that sets a prompt. It wraps whatever `prompt` exists when it
loads; starship and oh-my-posh *replace* `prompt`, so one loaded afterwards
takes the reporting with it. Same ordering trap as bash's `PROMPT_COMMAND`,
for the same reason.

PowerShell needs neither of the two awkward parts of the POSIX snippets.
`PSConsoleHostReadLine` is called by the host to read one line and returns
exactly when you press Enter on a line you typed, which is the pre-exec point
bash reconstructs from a DEBUG trap with an arming flag — so it is wrapped
rather than emulated. And `[uri]::EscapeDataString` percent-encodes UTF-8
bytes, so there is no hand-rolled encoder and no `LC_ALL=C` to get wrong.

It also sets `ConEmuANSI`, which the POSIX snippets leave to a separate line
(see "Telling programs the terminal supports it" below) — on Windows the shell
profile is the only place it can go, since there is no `~/.bashrc` to append
to and sshd discards the variable wRusTTY sends.

```powershell
# Shell integration: OSC 133 semantic-prompt sequences, which tell the
# terminal when a command starts, when it ends, and with what exit status,
# plus OSC 7, which tells it what directory you are in.
# Understood by iTerm2, kitty, WezTerm, Windows Terminal, VS Code and wRusTTY;
# silently discarded by terminals that don't implement them.
# Emits nothing when stdin is redirected, which is how the profile is loaded
# for `ssh host pwsh -c ...` and for anything piping into pwsh — do not
# remove the test below, or those streams get escape sequences injected.
if (-not [Console]::IsInputRedirected -and -not $Global:__osc133_installed) {
  $Global:__osc133_installed = $true
  $Global:__osc133_running = $false
  # PowerShell 7: the escape is spelled `e, but a literal ESC in a variable
  # keeps every sequence below readable as ESC ] ... BEL.
  $Global:__osc133_esc = [char]27
  $Global:__osc133_bel = [char]7

  # Resolved once: it cannot change for the life of the shell.
  $Global:__osc7_host = [System.Net.Dns]::GetHostName()

  # OSC 7: the working directory, as a percent-encoded file:// URL.
  function Global:__osc7_report {
    # ProviderPath, not Path: inside a PSDrive the latter reads as `Foo:\bar`,
    # which is not a path any other machine can use. A non-filesystem provider
    # (Env:, HKLM:) has no path at all, so it reports nothing rather than
    # something that looks like one.
    if ($PWD.Provider.Name -ne 'FileSystem') { return }
    $path = $PWD.ProviderPath.Replace('\', '/')
    # The URL grammar's separator, not part of the path: `/C:/Users/you`.
    if (-not $path.StartsWith('/')) { $path = '/' + $path }
    # Per segment, so the separators survive as separators. EscapeDataString
    # encodes UTF-8 bytes, which is what the URL grammar wants.
    $encoded = ($path -split '/' | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/'
    [Console]::Write("$__osc133_esc]7;file://$__osc7_host$encoded$__osc133_bel")
  }

  # Escape the command text so a `;` in it can't read as a field separator.
  function Global:__osc133_escape([string] $text) {
    $bs = [string][char]92
    $text.Replace($bs, $bs + $bs).Replace(';', $bs + 'x3b')
  }

  # The host calls this to read one line, and it returns exactly when you
  # press Enter on a line you typed — the pre-exec point bash has to
  # reconstruct from a DEBUG trap. Wrapped rather than replaced, so PSReadLine
  # keeps doing its job; skipped entirely if the host has no such function,
  # since defining one that calls nothing would break input outright.
  if ($function:PSConsoleHostReadLine) {
    $Global:__osc133_readline = $function:PSConsoleHostReadLine
    function Global:PSConsoleHostReadLine {
      $line = $Global:__osc133_readline.Invoke()
      # An empty line — Enter on an empty prompt, or Ctrl+C — ran no command,
      # and reporting one would pin the terminal at "a command is running".
      if ($line) {
        # What $LASTEXITCODE held before this command ran, so the prompt can
        # tell a code this command set from one left over from an earlier one.
        $Global:__osc133_lastexit = $global:LASTEXITCODE
        [Console]::Write("$__osc133_esc]633;E;$(__osc133_escape $line)$__osc133_bel")
        [Console]::Write("$__osc133_esc]133;C$__osc133_bel")
        $Global:__osc133_running = $true
      }
      $line
    }
  }

  $Global:__osc133_prompt = $function:prompt
  function Global:prompt {
    # First statement in the function: $? reflects the statement before it,
    # so anything at all here — a comparison, an assignment — overwrites the
    # answer this is trying to read.
    $ok = $?
    if ($Global:__osc133_running) {
      # $? decides *whether* it failed; $LASTEXITCODE says by how much, and
      # only native commands set it. It is not cleared by a cmdlet, so a
      # failing cmdlet after a failing `git` would otherwise be reported with
      # git's code — hence the comparison against the value from before this
      # command ran. A native command that fails twice with the same code is
      # the case that leaves behind: the second is reported as a plain 1.
      $code = if ($ok) { 0 }
        elseif ($LASTEXITCODE -and $LASTEXITCODE -ne $Global:__osc133_lastexit) { $LASTEXITCODE }
        else { 1 }
      [Console]::Write("$__osc133_esc]133;D;$code$__osc133_bel")
      $Global:__osc133_running = $false
    }
    __osc7_report
    [Console]::Write("$__osc133_esc]133;A$__osc133_bel")
    & $Global:__osc133_prompt
  }

  # Progress reporting (OSC 9;4) is emitted by programs, not by the shell, and
  # they look for this variable to decide the terminal supports it. wRusTTY
  # sends it as an SSH environment request, which a default sshd discards.
  $env:ConEmuANSI = 'ON'
}
```

Two PowerShell-specific things worth knowing if you rework this.

`$?` must be read by the *first* statement in `prompt` — any statement at all,
including a comparison, overwrites it — and it is the only reliable answer to
"did that fail", because a cmdlet failure never touches `$LASTEXITCODE`.
`$LASTEXITCODE` is consulted only for the number, and only when it differs
from the value recorded before the command ran; without that check, a failing
cmdlet after a failing `git` gets reported with git's exit code. What the check
can't catch is the same native command failing twice with the same code — the
second is reported as a plain `1`, which loses the number but not the failure.

The interactive guard is `[Console]::IsInputRedirected` rather than bash's
`$-` test, and it matters for the same reason: `ssh host pwsh -c ...` loads the
profile too, and anything it writes to stdout lands in that command's output.

## Checking it works

You don't need any of the above to test the wRusTTY side. Paste this into
any connected pane — it fakes a 15-second command by hand:

```sh
printf '\e]133;C\a'; sleep 15; printf '\e]133;D;0\a'
```

On a Windows host, where there is no `printf`:

```powershell
"`e]133;C`a"; Start-Sleep 15; "`e]133;D;0`a"
```

A red marker should sweep back and forth along this pane's segment of the tab
strip for 15 seconds. Switch to another tab before it finishes and you should
get a toast, plus the marker settling into a pulsing amber one on the pane you
left. Change the `0` to a `1` and the toast turns into an error.

To check the exit-code path with real integration installed, `sleep 15; false`
should notify as `exited 1`.

## What gets notified

A completion only raises a toast when all of these hold:

- **Notify on command completion** is enabled (Settings → Notifications; it is
  by default).
- The command took at least 10 seconds. Below that you were probably still
  watching, and per-command toasts for `ls` would train you to ignore them.
- Its tab isn't the one on screen in a focused window. If you watched it
  finish, you don't need telling.
- It never entered the alternate screen. Quitting `vim` after twenty minutes
  is not a background job landing.

## Programs that report for themselves

Shell integration has one structural gap: it reports *commands*, and a
full-screen program is a single command. Start `tmux`, `vim`, `top` or Claude
Code and the shell says nothing for however long you stay in it — and wRusTTY
suppresses the running marker on the alternate screen anyway, since "you are
using a program" is not news.

An application can close that gap itself, because these sequences come from the
program rather than the shell. That makes them work with no setup on the host,
inside a full-screen program, and over SSH — they are just bytes in the output
stream, exactly like a title change.

**Progress** (ConEmu's OSC 9;4; Windows Terminal draws the same thing in its
tab). wRusTTY spins the pane's marker for as long as progress is set:

```sh
printf '\033]9;4;3\a'          # busy, no idea how far along
printf '\033]9;4;1;40\a'       # 40%
printf '\033]9;4;0\a'          # done — clear it
```

State `2` is an error and `4` is paused; both still count as "a program is
there and hasn't finished", so both keep the marker up. An app that dies
without clearing its progress doesn't strand the marker: the next OSC 133
prompt or command exit clears it, as does a disconnect.

Once a program has reported progress, it owns the pane's marker for the rest
of the command — the shell's run is still tracked, and still notifies on
completion, but it stops driving the display. Without that, a program that
reports per-turn state *and* stays on the primary screen would be covered by
the shell's "a command is running" for its whole session, which is true and
useless: one `claude` is one command to the shell and many pieces of work to
you. The alternate screen already does this job for a full-screen program;
this is the same rule for one that renders inline. Whether a given program
takes the alternate screen is not something you can assume — Claude Code does
on Linux and does not on Windows, in the same version.

When progress that had been up for at least five seconds clears, the pane
keeps the amber attention marker until you focus it, and the taskbar button
flashes if the window isn't in front — the same treatment a bell gets. That
transition is the point of the whole thing: while the program works the
running marker covers it, but that marker vanishes the moment it stops, so
without this, coming back from another application would show a tab that
looks exactly as idle as one that never ran anything. There's no toast or
desktop notification, because this signal carries no text — a program with
something to say can say it with OSC 9 or OSC 777 below.

A *disconnect* takes the marker down without leaving that trace. The program's
fate isn't knowable from here, and claiming it finished would be a lie.

### Telling programs the terminal supports it

Programs don't probe for progress support — they recognise terminals by name
from a fixed list, and stay silent for anything they don't know. wRusTTY
therefore advertises itself as ConEmu-compatible (`ConEmuANSI=ON`) when
opening an SSH session, since OSC 9;4 is ConEmu's sequence.

That is sent as an SSH environment request, which **a default sshd throws
away**: `AcceptEnv` defaults to `LANG LC_*`. So on any host where progress
matters, set it in the shell's rc instead:

```sh
echo 'export ConEmuANSI=ON' >> ~/.bashrc     # or ~/.zshrc
```

The PowerShell snippet above sets it already, so a Windows host needs nothing
extra — there is no rc file to append this line to separately.

Claude Code is the concrete case. It emits `9;4;3` while it works and `9;4;0`
when it stops — but only when it sees `ConEmuANSI`/`ConEmuPID`/`ConEmuTask`,
or a `TERM_PROGRAM` of `ghostty` >= 1.2.0 or `iTerm.app` >= 3.6.6. Without one
of those it emits nothing at all, no matter what its own **terminal progress
bar** setting says, and the pane stays blank for the whole turn. (It also
disables progress outright under Windows Terminal, which is why the activity
indicator you see there is the tab *title*, not a progress bar.)

With the variable set, its pane spins over SSH even though it never returns to
a prompt, its tab is marked when it stops, and the taskbar flashes if you're in
another application.

**Notifications** (iTerm2's OSC 9, and urxvt/kitty's OSC 777), gated by
**Programs may raise notifications** in Settings → Notifications:

```sh
printf '\033]9;backup finished\a'
printf '\033]777;notify;Backup;finished in 4m\a'
```

Unlike a completion notification these fire whenever the program asks,
including for the pane you are watching — the sender has no way to know
whether you saw it. The text is remote input, so it is truncated, stripped of
control characters, and always shown under the pane's own name rather than as
a title of its own.

## Bell

Separately, and with no setup at all, a `BEL` from the far end marks its pane
with the same amber marker until you focus it (**Bell marks the pane**,
Settings → Notifications). **Bell plays a sound** there adds a short tone, off
by default. This works on anything that can write a byte, including network
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
  and the snippet skips it by name. If the running marker sweeps continuously
  on an idle prompt, that's the shape of the problem; find the culprit by adding
  `printf '[dbg <%s>]\n' "$BASH_COMMAND"` at the top of `__osc133_preexec`,
  pressing Enter on an empty prompt, and adding whatever it names to the
  `case` list.
- Don't stack this alongside iTerm2's or VS Code's own installed integration
  on the same host: two installs means two `D` reports per command. wRusTTY
  ignores the duplicate (a `D` with nothing running is dropped), but other
  clients may be less forgiving.
- **A second OSC 7 reporter is harmless, unlike a second `D`.** It is a
  statement of fact rather than an event, so a host where GNOME's `vte.sh` (or
  a distro `bashrc`) already reports the directory just reports it twice per
  prompt and lands on the same answer. The bytes are wasted, nothing else. The
  fish snippet still skips its own reporter when fish's built-in
  `__update_cwd_osc` is present, because that one is bound to `PWD` changing
  rather than to the prompt, and two handlers on one variable is a thing you
  then have to think about when either misbehaves.
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
