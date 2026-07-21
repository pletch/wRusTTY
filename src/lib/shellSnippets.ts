/**
 * The shell-side half of OSC 133 support, as copyable text.
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
 */

export interface ShellSnippet {
  id: 'bash' | 'zsh' | 'fish'
  label: string
  /** Where it goes on the remote host, shown in the copied-confirmation. */
  rcFile: string
  script: string
}

const PREAMBLE = `# Shell integration: OSC 133 semantic-prompt sequences, which tell the
# terminal when a command starts, when it ends, and with what exit status.
# Understood by iTerm2, kitty, WezTerm, Windows Terminal, VS Code and wRusTTY;
# silently discarded by terminals that don't implement them.`

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
      __osc133_*) return ;;
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

__osc133_precmd() {
  # Not \`local status=$?\` — zsh's \`status\` is a special parameter (a synonym
  # for \`?\`), so shadowing it is asking for trouble.
  local __st=$?
  if (( __osc133_running )); then
    print -n "\\e]133;D;$__st\\a"
    __osc133_running=0
  fi
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
end`

export const SHELL_SNIPPETS: ShellSnippet[] = [
  { id: 'bash', label: 'bash', rcFile: '~/.bashrc', script: BASH },
  { id: 'zsh', label: 'zsh', rcFile: '~/.zshrc', script: ZSH },
  { id: 'fish', label: 'fish', rcFile: '~/.config/fish/config.fish', script: FISH },
]
