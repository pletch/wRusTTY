use serde::{Deserialize, Serialize};

/// The `TERM` used when the session doesn't override it. Matches
/// `wr_ssh::DEFAULT_TERM_TYPE` and `wr_telnet::DEFAULT_TERM_TYPE`. WSL and Git
/// Bash read it; PowerShell and CMD get their capabilities from ConPTY.
pub const DEFAULT_TERM_TYPE: &str = "xterm-256color";

/// Everything needed to launch a local shell.
///
/// A saved profile is executable content (`docs/LOCAL_SHELL_PLAN.md`), so the
/// environment is explicit, the working directory stated, and the command
/// line argv rather than a string (a space in a distro name or path would
/// otherwise split an argument). Every field's zero value is its default,
/// hence the derived `Default`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalConfig {
    /// Absolute path, resolved at detection rather than on `PATH` now, so a
    /// `PATH` change can't silently launch a different binary.
    pub command: String,

    /// Arguments, already split. Never a command line to be parsed.
    #[serde(default)]
    pub args: Vec<String>,

    /// Working directory; `None` means the user's home.
    #[serde(default)]
    pub cwd: Option<String>,

    /// Variables set on top of the inherited environment, not replacing it (an
    /// empty environment breaks PowerShell and bash). Whatever this app adds is
    /// an explicit, reviewable list, so nothing leaks to the child just because
    /// it's set in a process holding vault secrets.
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

    /// The label a log file and status line use: the executable's file stem
    /// (`pwsh`), not its path. `logging.rs` sanitizes it. Split on both
    /// separators by hand, since `Path` only knows the host's; the frontend's
    /// `shellLabel` does the same.
    pub fn label(&self) -> &str {
        let leaf = self.command.rsplit(['/', '\\']).next().unwrap_or("");
        let stem = match leaf.rsplit_once('.') {
            Some((stem, _)) if !stem.is_empty() => stem,
            _ => leaf,
        };
        if stem.is_empty() {
            "shell"
        } else {
            stem
        }
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

    /// A snapshot without the optional fields still parses; only `command` is
    /// required.
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

    /// A command that isn't a path still names itself, since the label reaches a
    /// log filename.
    #[test]
    fn label_falls_back_when_there_is_no_stem() {
        let config = LocalConfig {
            command: String::new(),
            ..Default::default()
        };
        assert_eq!(config.label(), "shell");
    }
}
