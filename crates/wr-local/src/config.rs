use serde::{Deserialize, Serialize};

/// What we set `TERM` to when the session doesn't override it.
///
/// Matches `wr_ssh::DEFAULT_TERM_TYPE` and `wr_telnet::DEFAULT_TERM_TYPE`
/// deliberately, for the reason telnet's own constant gives: they are separate
/// transports but the same terminal, and a user has no reason to expect
/// different behaviour from the same shell reached two ways.
///
/// It matters unevenly here. A WSL or Git Bash session reads `TERM` and
/// changes what it emits based on it; PowerShell and CMD ignore it entirely,
/// since ConPTY is what tells them the console's capabilities.
pub const DEFAULT_TERM_TYPE: &str = "xterm-256color";

/// Everything needed to launch a local shell.
///
/// Every field here exists to serve the security decision recorded in
/// `docs/LOCAL_SHELL_PLAN.md` — a saved profile becomes executable content,
/// so the environment is passed explicitly rather than inherited wholesale,
/// the working directory is stated rather than assumed, and the command line
/// is **argv** rather than a string. That last one is not cosmetic: a distro
/// name or an install path with a space in it becomes an argument boundary
/// the moment anything concatenates these together.
///
/// Every field's zero value is also its intended default — an empty command is
/// not runnable, and the rest mean "inherit" or "use the built-in" — so this
/// derives `Default` rather than spelling one out. `SerialConfig` next door
/// does the opposite because 9600 baud is not zero.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalConfig {
    /// Absolute path to the executable, resolved when the shell was detected
    /// rather than looked up on `PATH` now. Detection already had to find it
    /// to offer it, and re-resolving here would let a `PATH` change between
    /// then and now silently launch a different binary.
    pub command: String,

    /// Arguments, already split. Never a command line to be parsed.
    #[serde(default)]
    pub args: Vec<String>,

    /// Working directory. `None` means the user's home, which is what every
    /// shell does when launched from a shortcut and what a user expects from
    /// a fresh terminal.
    #[serde(default)]
    pub cwd: Option<String>,

    /// Variables to set on top of the inherited environment, not a
    /// replacement for it.
    ///
    /// A shell with a genuinely empty environment does not work — PowerShell
    /// needs `SystemRoot` to load .NET, and bash needs `PATH` to find
    /// anything — so a full replacement would have to rebuild most of what it
    /// removed. What this does instead is make every variable *this app*
    /// contributes an explicit, reviewable list, so nothing reaches the child
    /// because it happened to be set in the process that also holds decrypted
    /// vault secrets.
    #[serde(default)]
    pub env: Vec<(String, String)>,

    /// Overrides `TERM`. `None` sends [`DEFAULT_TERM_TYPE`].
    #[serde(default)]
    pub term_type: Option<String>,
}

impl LocalConfig {
    pub fn term_type(&self) -> &str {
        self.term_type.as_deref().unwrap_or(DEFAULT_TERM_TYPE)
    }

    /// The label a log file and a status line use for this session.
    ///
    /// The executable's file stem, not its full path: a log named
    /// `pwsh-2026-09-10.log` says what it is, where one named after
    /// `C--Program-Files-PowerShell-7-pwsh-exe` says the same thing and is
    /// unreadable. `logging.rs` sanitizes whatever it gets, so this only has
    /// to be meaningful, not safe.
    pub fn label(&self) -> &str {
        std::path::Path::new(&self.command)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("shell")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn term_type_falls_back_to_the_default() {
        assert_eq!(LocalConfig::default().term_type(), DEFAULT_TERM_TYPE);
    }

    #[test]
    fn term_type_override_is_used_verbatim() {
        let config = LocalConfig {
            term_type: Some("vt100".into()),
            ..Default::default()
        };
        assert_eq!(config.term_type(), "vt100");
    }

    /// The frontend sends this straight from a saved session snapshot, and a
    /// snapshot written before any of the optional fields existed must still
    /// parse. Only `command` is required.
    #[test]
    fn config_with_only_a_command_still_parses() {
        let config: LocalConfig = serde_json::from_str(r#"{"command":"C:\\pwsh.exe"}"#).unwrap();
        assert_eq!(config.command, r"C:\pwsh.exe");
        assert!(config.args.is_empty());
        assert_eq!(config.cwd, None);
        assert_eq!(config.term_type(), DEFAULT_TERM_TYPE);
    }

    #[test]
    fn label_is_the_executable_stem() {
        let config = LocalConfig {
            command: r"C:\Program Files\PowerShell\7\pwsh.exe".into(),
            ..Default::default()
        };
        assert_eq!(config.label(), "pwsh");
    }

    /// A command that is somehow not a path at all still has to name itself,
    /// because the label reaches a log filename either way.
    #[test]
    fn label_falls_back_when_there_is_no_stem() {
        let config = LocalConfig {
            command: String::new(),
            ..Default::default()
        };
        assert_eq!(config.label(), "shell");
    }
}
