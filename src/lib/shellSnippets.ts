/**
 * The shell-side half of OSC 133 and OSC 7 support, as copyable text.
 *
 * These are the canonical copies — docs/SHELL_INTEGRATION.md reproduces them
 * for anyone reading the repo rather than running the app, so a change here
 * needs the same change there.
 *
 * Deliberately vendor-neutral in their naming. The sequences are a standard
 * (see lib/shellIntegration.ts), so a host with this installed also lights up
 * iTerm2, kitty, WezTerm, Windows Terminal and VS Code — calling the
 * functions `__wrustty_*` would misrepresent that to whoever reads the rc
 * file next.
 *
 * OSC 7 rides along with the 133 sequences because the shell is the only thing
 * that can answer either question, and one paste is better than two. It is a
 * separate feature though: it drives the directory in the status bar and the
 * destination a drag-and-drop upload lands in (lib/dropUpload.ts refuses the
 * drop without one), and it is parsed by lib/remoteIdentity.ts rather than
 * lib/shellIntegration.ts.
 */

export interface ShellSnippet {
  id: 'bash' | 'zsh' | 'fish'
  label: string
  /** Where it goes on the remote host, shown in the copied-confirmation. */
  rcFile: string
  script: string
}

const PREAMBLE = `# Shell integration: OSC 133 semantic-prompt sequences, which tell the
# terminal when a command starts, when it ends, and with what exit status,
# plus OSC 7, which tells it what directory you are in.
# Understood by iTerm2, kitty, WezTerm, Windows Terminal, VS Code and wRusTTY;
# silently discarded by terminals that don't implement them.`

// Why every snippet encodes the path by hand rather than shelling out to
// `python -c urllib...` or similar: this runs on every prompt, on hosts that
// are often a switch, a router or a busy jump box, and a fork per prompt is
// the sort of thing people feel on a slow link. It is also the sort of host
// that has no python.
//
// `LC_ALL=C` in a subshell is what makes the loop walk *bytes*. In a UTF-8
// locale the shell reads a multi-byte character as one character and encodes
// its codepoint, so `é` comes out as `%E9` instead of `%C3%A9` and the far
// side decodes a different path — or fails to decode at all.
const POSIX_OSC7 = `# OSC 7: the working directory, as a percent-encoded file:// URL.
__osc7_encode() (
  LC_ALL=C
  local str=$1 safe
  while [[ -n $str ]]; do
    # The longest prefix of characters that need no escaping, then one
    # character that does. RFC 3986's unreserved set, plus the separator.
    safe=\${str%%[!a-zA-Z0-9/._~-]*}
    printf '%s' "$safe"
    str=\${str#"$safe"}
    if [[ -n $str ]]; then
      # A leading quote makes printf take the character's numeric value.
      printf '%%%02X' "'$str"
      str=\${str#?}
    fi
  done
)

# Resolved once: it cannot change for the life of the shell, and \`hostname\`
# is a fork. HOSTNAME first for bash, HOST for zsh, the command for neither.
__osc7_host=\${HOSTNAME:-\${HOST:-$(hostname 2>/dev/null)}}

__osc7_report() {
  printf '\\e]7;file://%s%s\\a' "$__osc7_host" "$(__osc7_encode "$PWD")"
}`

/** The bash snippet keeps its whole body inside the interactive guard. */
const indent = (block: string) => block.replace(/^(?=.)/gm, '  ')

// The interactive guard is load-bearing, not belt-and-braces: bash detects
// stdin being a network socket (as when run by sshd) and sources ~/.bashrc
// even for non-interactive commands, so without it every `scp`, `rsync` and
// git-over-ssh to this host would get escape sequences injected into the
// binary protocol stream and break.
const BASH = `${PREAMBLE}
# Emits nothing in a non-interactive shell, so scp/rsync/git-over-ssh are
# unaffected — do not remove the \`$-\` test below.
if [[ $- == *i* && -z $__osc133_installed ]]; then
  __osc133_installed=1
  __osc133_ready=0
  __osc133_running=0

${indent(POSIX_OSC7)}

  __osc133_precmd() {
    local __st=$?
    # Disarm for the rest of the prompt cycle. Anything that runs between
    # here and __osc133_arm is prompt machinery — your own PROMPT_COMMAND
    # entries, whatever starship or vte.sh installed — not a command you
    # typed, and must not be reported as one.
    __osc133_ready=0
    if (( __osc133_running )); then
      printf '\\e]133;D;%s\\a' "$__st"
      __osc133_running=0
    fi
    __osc7_report
    printf '\\e]133;A\\a'
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
      # Functions bound to a key with \`bind -x\` fire the DEBUG trap too, but
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
    # Escape the command text so a \`;\` in it can't read as a field separator.
    # Via a variable holding the backslash, rather than writing the escapes
    # inline: surviving both the double quotes and the replacement's own
    # unescaping takes four of them, and getting it wrong fails quietly.
    local bs='\\'
    local cmd=$BASH_COMMAND
    cmd=\${cmd//"$bs"/"$bs$bs"}
    printf '\\e]633;E;%s\\a' "\${cmd//;/"\${bs}x3b"}"
    printf '\\e]133;C\\a'
  }

  trap '__osc133_preexec' DEBUG
  # precmd first, so it reads the real $? of the command that just ended;
  # arm last, after any pre-existing entries have had their turn.
  PROMPT_COMMAND="__osc133_precmd\${PROMPT_COMMAND:+;$PROMPT_COMMAND};__osc133_arm"
fi`

const ZSH = `${PREAMBLE}
# zsh has real preexec/precmd hooks, so there's no DEBUG-trap bookkeeping.
__osc133_running=0

${POSIX_OSC7}

__osc133_precmd() {
  # Not \`local status=$?\` — zsh's \`status\` is a special parameter (a synonym
  # for \`?\`), so shadowing it is asking for trouble.
  local __st=$?
  if (( __osc133_running )); then
    print -n "\\e]133;D;$__st\\a"
    __osc133_running=0
  fi
  __osc7_report
  print -n "\\e]133;A\\a"
}

__osc133_preexec() {
  __osc133_running=1
  # Escaped through a variable holding the backslash — writing the escapes
  # inline needs four of them to survive, and fails quietly if miscounted.
  local bs='\\'
  local cmd=$1
  cmd=\${cmd//"$bs"/"$bs$bs"}
  print -n "\\e]633;E;\${cmd//;/"\${bs}x3b"}\\a"
  print -n "\\e]133;C\\a"
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd __osc133_precmd
add-zsh-hook preexec __osc133_preexec`

const FISH = `${PREAMBLE}
function __osc133_prompt --on-event fish_prompt
    printf '\\e]133;A\\a'
end

function __osc133_preexec --on-event fish_preexec
    set -l cmd (string replace -a '\\\\' '\\\\\\\\' -- $argv[1])
    printf '\\e]633;E;%s\\a' (string replace -a ';' '\\\\x3b' -- $cmd)
    printf '\\e]133;C\\a'
end

function __osc133_postexec --on-event fish_postexec
    set -l status_code $status
    printf '\\e]133;D;%s\\a' $status_code
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
        printf '\\e]7;file://%s%s\\a' $hostname (string escape --style=url -- $PWD | string replace -ai %2F /)
    end
    __osc7_report
end`

export const SHELL_SNIPPETS: ShellSnippet[] = [
  { id: 'bash', label: 'bash', rcFile: '~/.bashrc', script: BASH },
  { id: 'zsh', label: 'zsh', rcFile: '~/.zshrc', script: ZSH },
  { id: 'fish', label: 'fish', rcFile: '~/.config/fish/config.fish', script: FISH },
]
