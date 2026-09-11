//! What shells this machine actually has.
//!
//! Same shape as `serial_list_ports`: enumerate what is there, return a stable
//! id plus a display label, and let the frontend render a list it did not have
//! to build. Phase 3 of `docs/LOCAL_SHELL_PLAN.md`.
//!
//! This lives in the app rather than in `wr-local` because it needs the
//! registry, and the app already carries the `windows` crate with
//! `Win32_System_Registry` enabled for `putty_import.rs` — which is also the
//! precedent for how a read is done here. Putting it in the transport crate
//! would mean a second `windows` dependency to keep pinned in step with that
//! one, to serve a question that is about this machine's inventory rather than
//! about pseudoconsoles. `wr-serial` only owns its own enumeration because
//! `tokio-serial` hands it over for free.
//!
//! Detection is a snapshot taken when the picker opens, not a watcher. Unlike
//! COM ports, nothing here is hot-plugged.

use std::path::Path;

use serde::Serialize;

/// One shell the user could open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    /// Stable across runs and machines: `pwsh`, `powershell`, `cmd`,
    /// `git-bash`, `wsl:Ubuntu`. This is what a saved profile and a history
    /// key are built from, so it must not carry a version or an install path —
    /// both change under the user without the shell becoming a different one.
    pub id: String,
    /// What the picker shows.
    pub label: String,
    /// Absolute path, resolved now so that connecting later does not re-run a
    /// `PATH` lookup that could resolve differently.
    pub command: String,
    /// Already split. Never a command line — see `LocalConfig`.
    pub args: Vec<String>,
}

/// The machine, behind a trait so the rules above can be tested without one.
///
/// Every environmental question detection asks is here, and nothing else in
/// this module touches the world directly. The fake in the tests is what makes
/// "a machine with Git but no WSL" an ordinary test case rather than a
/// different machine.
pub trait Machine {
    fn var(&self, name: &str) -> Option<String>;
    fn is_file(&self, path: &str) -> bool;
    /// `HKLM\SOFTWARE\GitForWindows\InstallPath`, or its WOW6432Node twin.
    fn git_install_path(&self) -> Option<String>;
    /// Installed WSL distribution names, in registry order.
    fn wsl_distros(&self) -> Vec<String>;
}

/// Everything installed, most useful first.
pub fn detect(machine: &impl Machine) -> Vec<ShellInfo> {
    let mut shells = Vec::new();
    shells.extend(powershell_core(machine));
    shells.extend(windows_powershell(machine));
    shells.extend(command_prompt(machine));
    shells.extend(git_bash(machine));
    shells.extend(wsl(machine));
    shells
}

/// The first of `candidates` that exists.
fn first_present(machine: &impl Machine, candidates: &[String]) -> Option<String> {
    candidates.iter().find(|p| machine.is_file(p)).cloned()
}

fn join(base: &str, rest: &str) -> String {
    Path::new(base)
        .join(rest)
        .to_string_lossy()
        .replace('/', "\\")
}

/// PowerShell 7+, which installs outside the OS and can be absent.
///
/// Versions are tried newest-first and the id stays `pwsh` across all of them:
/// upgrading from 7 to 8 must not orphan a saved profile or fork its history,
/// and the version is an install detail rather than part of what the user
/// means by "PowerShell".
fn powershell_core(machine: &impl Machine) -> Option<ShellInfo> {
    let mut candidates = Vec::new();
    for program_files in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(base) = machine.var(program_files) {
            for major in ["7", "6"] {
                candidates.push(join(&base, &format!("PowerShell\\{major}\\pwsh.exe")));
            }
        }
    }
    // Last, deliberately. The `WindowsApps` entries are zero-byte
    // app-execution aliases — reparse points that launch the real binary — so
    // probing one succeeds and yields a stub rather than the install. It works
    // when executed, but the real path is the better answer when both exist.
    if let Some(local) = machine.var("LOCALAPPDATA") {
        candidates.push(join(&local, "Microsoft\\WindowsApps\\pwsh.exe"));
    }

    Some(ShellInfo {
        id: "pwsh".into(),
        label: "PowerShell".into(),
        command: first_present(machine, &candidates)?,
        args: Vec::new(),
    })
}

/// Windows PowerShell 5.1 — the in-box one, and a different product from the
/// above rather than an older copy of it. Always present on Windows.
fn windows_powershell(machine: &impl Machine) -> Option<ShellInfo> {
    let root = machine.var("SystemRoot")?;
    let command = join(&root, "System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    machine.is_file(&command).then(|| ShellInfo {
        id: "powershell".into(),
        label: "Windows PowerShell".into(),
        command,
        args: Vec::new(),
    })
}

fn command_prompt(machine: &impl Machine) -> Option<ShellInfo> {
    let mut candidates = Vec::new();
    // `ComSpec` is what every launcher on Windows uses, and it is the value to
    // honour if something has pointed it elsewhere.
    if let Some(comspec) = machine.var("ComSpec") {
        candidates.push(comspec);
    }
    if let Some(root) = machine.var("SystemRoot") {
        candidates.push(join(&root, "System32\\cmd.exe"));
    }
    Some(ShellInfo {
        id: "cmd".into(),
        label: "Command Prompt".into(),
        command: first_present(machine, &candidates)?,
        args: Vec::new(),
    })
}

/// Git for Windows' bash.
///
/// `-i -l` because this is an interactive login shell and Git Bash's own
/// shortcut passes the same: without `-l` the profile that puts `git` on
/// `PATH` never runs, and a shell that cannot find git is not what anyone
/// meant by "Git Bash".
fn git_bash(machine: &impl Machine) -> Option<ShellInfo> {
    let mut candidates = Vec::new();
    if let Some(install) = machine.git_install_path() {
        candidates.push(join(&install, "bin\\bash.exe"));
    }
    // The registry key is missing for a portable or user-scoped install, so
    // the usual locations are worth trying before giving up.
    for program_files in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(base) = machine.var(program_files) {
            candidates.push(join(&base, "Git\\bin\\bash.exe"));
        }
    }
    Some(ShellInfo {
        id: "git-bash".into(),
        label: "Git Bash".into(),
        command: first_present(machine, &candidates)?,
        args: vec!["-i".into(), "-l".into()],
    })
}

/// Every installed WSL distribution, one entry each.
///
/// Keyed by distro name rather than by the `wsl.exe` that launches it: the
/// shell, the filesystem and the history all belong to the distro, and two of
/// them share a launcher without sharing anything else.
fn wsl(machine: &impl Machine) -> Vec<ShellInfo> {
    let Some(root) = machine.var("SystemRoot") else {
        return Vec::new();
    };
    // System32 even on 64-bit: `wsl.exe` is not present under SysWOW64, and a
    // 32-bit process would be redirected away from it.
    let command = join(&root, "System32\\wsl.exe");
    if !machine.is_file(&command) {
        return Vec::new();
    }
    machine
        .wsl_distros()
        .into_iter()
        .map(|distro| ShellInfo {
            id: format!("wsl:{distro}"),
            label: format!("{distro} (WSL)"),
            command: command.clone(),
            // `--cd ~` so the shell opens in the Linux home rather than in
            // whatever Windows directory this process happens to be in, which
            // over the 9p bridge is both surprising and slow.
            args: vec!["-d".into(), distro, "--cd".into(), "~".into()],
        })
        .collect()
}

/// The real machine.
pub struct SystemMachine;

impl Machine for SystemMachine {
    fn var(&self, name: &str) -> Option<String> {
        std::env::var(name).ok().filter(|v| !v.is_empty())
    }

    fn is_file(&self, path: &str) -> bool {
        Path::new(path).is_file()
    }

    #[cfg(windows)]
    fn git_install_path(&self) -> Option<String> {
        use windows::Win32::System::Registry::HKEY_LOCAL_MACHINE;
        registry::string_value(HKEY_LOCAL_MACHINE, r"SOFTWARE\GitForWindows", "InstallPath")
            .or_else(|| {
                registry::string_value(
                    HKEY_LOCAL_MACHINE,
                    r"SOFTWARE\WOW6432Node\GitForWindows",
                    "InstallPath",
                )
            })
    }

    #[cfg(not(windows))]
    fn git_install_path(&self) -> Option<String> {
        None
    }

    #[cfg(windows)]
    fn wsl_distros(&self) -> Vec<String> {
        registry::wsl_distros()
    }

    #[cfg(not(windows))]
    fn wsl_distros(&self) -> Vec<String> {
        Vec::new()
    }
}

/// The machine as the *elevated host* may see it: system locations only.
///
/// [`SystemMachine`] answers from the environment, and the environment is the
/// user's to set — `HKCU\Environment` can override `ComSpec`, `SystemRoot` or
/// `ProgramFiles` for every process they start, the elevated one included, with
/// no elevation needed to write it. `LOCALAPPDATA` is under the user's control
/// by definition. Resolving an administrator shell through any of those would
/// let anything running as the user pick what the next UAC approval runs.
///
/// So this answers the three folder variables detection needs from the known-
/// folder API, which reads machine-wide configuration rather than the
/// environment, and answers nothing else: no `ComSpec`, so Command Prompt is
/// `System32\cmd.exe`; no `LOCALAPPDATA`, so neither the `WindowsApps` alias for
/// PowerShell nor a per-user Git install is considered. Git's `HKLM` install
/// path stays, since only an administrator can write it. WSL is not elevatable
/// and is left out.
#[cfg(windows)]
pub struct ElevatedMachine;

#[cfg(windows)]
impl Machine for ElevatedMachine {
    fn var(&self, name: &str) -> Option<String> {
        use windows::Win32::UI::Shell::{
            FOLDERID_ProgramFiles, FOLDERID_ProgramFilesX86, FOLDERID_Windows,
        };
        match name {
            "SystemRoot" => known_folder(&FOLDERID_Windows),
            "ProgramFiles" => known_folder(&FOLDERID_ProgramFiles),
            "ProgramFiles(x86)" => known_folder(&FOLDERID_ProgramFilesX86),
            _ => None,
        }
    }

    fn is_file(&self, path: &str) -> bool {
        SystemMachine.is_file(path)
    }

    fn git_install_path(&self) -> Option<String> {
        SystemMachine.git_install_path()
    }

    fn wsl_distros(&self) -> Vec<String> {
        Vec::new()
    }
}

/// A known folder's path, or `None` if Windows will not say.
#[cfg(windows)]
fn known_folder(id: &windows::core::GUID) -> Option<String> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{SHGetKnownFolderPath, KF_FLAG_DEFAULT};

    let path = unsafe { SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None) }.ok()?;
    let text = unsafe { path.to_string() };
    // Freed whether or not it decoded: the shell allocated it for us.
    unsafe { CoTaskMemFree(Some(path.0 as *const std::ffi::c_void)) };
    text.ok().filter(|p| !p.is_empty())
}

/// The two registry reads detection needs, in the shape `putty_import.rs`
/// established: read-only, a self-closing key, and a missing key treated as
/// "not installed" rather than as an error.
#[cfg(windows)]
mod registry {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{ERROR_NO_MORE_ITEMS, ERROR_SUCCESS};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_READ, REG_EXPAND_SZ, REG_SZ, REG_VALUE_TYPE,
    };

    /// Where the WSL service records what is installed. Read rather than
    /// running `wsl.exe -l -v`, whose output is UTF-16LE with decorations and
    /// is localised — parsing it has burned everyone who has tried.
    const LXSS_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Lxss";

    struct OwnedKey(HKEY);
    impl Drop for OwnedKey {
        fn drop(&mut self) {
            unsafe {
                let _ = RegCloseKey(self.0);
            }
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn from_wide(buf: &[u16]) -> String {
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
    }

    fn open(parent: HKEY, path: &str) -> Option<OwnedKey> {
        let mut key = HKEY::default();
        let status = unsafe {
            RegOpenKeyExW(
                parent,
                PCWSTR(wide(path).as_ptr()),
                Some(0),
                KEY_READ,
                &mut key,
            )
        };
        (status == ERROR_SUCCESS).then_some(OwnedKey(key))
    }

    pub fn string_value(parent: HKEY, path: &str, name: &str) -> Option<String> {
        let key = open(parent, path)?;
        let name = wide(name);
        let mut kind = REG_VALUE_TYPE::default();
        // Ask for the size first: an install path is short, but guessing a
        // buffer is how a long one gets silently truncated.
        let mut len = 0u32;
        let status = unsafe {
            RegQueryValueExW(
                key.0,
                PCWSTR(name.as_ptr()),
                None,
                Some(&mut kind),
                None,
                Some(&mut len),
            )
        };
        if status != ERROR_SUCCESS || (kind != REG_SZ && kind != REG_EXPAND_SZ) {
            return None;
        }
        let mut buf = vec![0u16; (len as usize).div_ceil(2) + 1];
        let mut size = (buf.len() * 2) as u32;
        let status = unsafe {
            RegQueryValueExW(
                key.0,
                PCWSTR(name.as_ptr()),
                None,
                None,
                Some(buf.as_mut_ptr().cast()),
                Some(&mut size),
            )
        };
        (status == ERROR_SUCCESS).then(|| from_wide(&buf))
    }

    pub fn wsl_distros() -> Vec<String> {
        // A machine with no WSL has no key at all, which is the ordinary case
        // and an empty list rather than a failure.
        let Some(lxss) = open(HKEY_CURRENT_USER, LXSS_KEY) else {
            return Vec::new();
        };

        let mut distros = Vec::new();
        let mut index = 0u32;
        loop {
            // 256 is the documented maximum length of a key name.
            let mut name_buf = [0u16; 256];
            let mut name_len = name_buf.len() as u32;
            let status = unsafe {
                RegEnumKeyExW(
                    lxss.0,
                    index,
                    Some(PWSTR(name_buf.as_mut_ptr())),
                    &mut name_len,
                    None,
                    None,
                    None,
                    None,
                )
            };
            if status == ERROR_NO_MORE_ITEMS {
                break;
            }
            index += 1;
            if status != ERROR_SUCCESS {
                // One unreadable entry should not cost the user the rest of
                // their distros.
                continue;
            }

            let guid = String::from_utf16_lossy(&name_buf[..name_len as usize]);
            // The subkey is a GUID; the name a human recognises is a value
            // inside it. An entry mid-install or mid-uninstall can have the
            // key without the value, and is correctly skipped.
            let path = format!("{LXSS_KEY}\\{guid}");
            if let Some(name) = string_value(HKEY_CURRENT_USER, &path, "DistributionName") {
                if !name.is_empty() {
                    distros.push(name);
                }
            }
        }
        distros
    }
}

#[tauri::command]
pub async fn local_list_shells() -> Result<Vec<ShellInfo>, String> {
    Ok(detect(&SystemMachine))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// A machine that is exactly what the test says it is.
    #[derive(Default)]
    struct FakeMachine {
        vars: HashMap<String, String>,
        files: Vec<String>,
        git: Option<String>,
        distros: Vec<String>,
    }

    impl FakeMachine {
        /// A plausible Windows box: both PowerShells, cmd, no Git, no WSL.
        fn windows() -> Self {
            let mut vars = HashMap::new();
            vars.insert("SystemRoot".into(), r"C:\Windows".into());
            vars.insert("ProgramFiles".into(), r"C:\Program Files".into());
            vars.insert("ComSpec".into(), r"C:\Windows\System32\cmd.exe".into());
            vars.insert(
                "LOCALAPPDATA".into(),
                r"C:\Users\t\AppData\Local".to_string(),
            );
            Self {
                vars,
                files: vec![
                    r"C:\Program Files\PowerShell\7\pwsh.exe".into(),
                    r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe".into(),
                    r"C:\Windows\System32\cmd.exe".into(),
                    r"C:\Windows\System32\wsl.exe".into(),
                ],
                ..Default::default()
            }
        }

        fn without(mut self, path: &str) -> Self {
            self.files.retain(|f| f != path);
            self
        }

        fn with_file(mut self, path: &str) -> Self {
            self.files.push(path.into());
            self
        }
    }

    impl Machine for FakeMachine {
        fn var(&self, name: &str) -> Option<String> {
            self.vars.get(name).cloned()
        }
        fn is_file(&self, path: &str) -> bool {
            self.files.iter().any(|f| f == path)
        }
        fn git_install_path(&self) -> Option<String> {
            self.git.clone()
        }
        fn wsl_distros(&self) -> Vec<String> {
            self.distros.clone()
        }
    }

    fn ids(shells: &[ShellInfo]) -> Vec<&str> {
        shells.iter().map(|s| s.id.as_str()).collect()
    }

    fn find<'a>(shells: &'a [ShellInfo], id: &str) -> &'a ShellInfo {
        shells.iter().find(|s| s.id == id).expect(id)
    }

    #[test]
    fn finds_the_shells_a_plain_windows_box_has() {
        let shells = detect(&FakeMachine::windows());
        assert_eq!(ids(&shells), vec!["pwsh", "powershell", "cmd"]);
    }

    #[test]
    fn a_machine_without_powershell_7_still_offers_the_rest() {
        let machine = FakeMachine::windows().without(r"C:\Program Files\PowerShell\7\pwsh.exe");
        assert_eq!(ids(&detect(&machine)), vec!["powershell", "cmd"]);
    }

    /// The version is an install detail. Someone upgrading 7 to 8 must not
    /// find their saved session orphaned because its id moved with it.
    #[test]
    fn the_powershell_id_does_not_carry_a_version() {
        let shells = detect(&FakeMachine::windows());
        assert_eq!(find(&shells, "pwsh").id, "pwsh");
        assert!(find(&shells, "pwsh").command.contains("PowerShell"));
    }

    /// A real install and a `WindowsApps` alias both present: the alias is a
    /// zero-byte reparse stub, so the install is the better answer.
    #[test]
    fn a_real_install_wins_over_the_windowsapps_alias() {
        let machine = FakeMachine::windows()
            .with_file(r"C:\Users\t\AppData\Local\Microsoft\WindowsApps\pwsh.exe");
        assert_eq!(
            find(&detect(&machine), "pwsh").command,
            r"C:\Program Files\PowerShell\7\pwsh.exe"
        );
    }

    #[test]
    fn the_windowsapps_alias_is_used_when_it_is_all_there_is() {
        let machine = FakeMachine::windows()
            .without(r"C:\Program Files\PowerShell\7\pwsh.exe")
            .with_file(r"C:\Users\t\AppData\Local\Microsoft\WindowsApps\pwsh.exe");
        assert_eq!(
            find(&detect(&machine), "pwsh").command,
            r"C:\Users\t\AppData\Local\Microsoft\WindowsApps\pwsh.exe"
        );
    }

    #[test]
    fn git_bash_is_found_through_the_registry_and_is_a_login_shell() {
        let mut machine = FakeMachine::windows();
        machine.git = Some(r"C:\Program Files\Git".into());
        machine
            .files
            .push(r"C:\Program Files\Git\bin\bash.exe".into());

        let shells = detect(&machine);
        let bash = find(&shells, "git-bash");
        assert_eq!(bash.command, r"C:\Program Files\Git\bin\bash.exe");
        // Without `-l` the profile that puts git on PATH never runs.
        assert_eq!(bash.args, vec!["-i", "-l"]);
    }

    /// A portable install has no registry key, so the usual locations are
    /// still worth probing.
    #[test]
    fn git_bash_is_found_without_a_registry_key() {
        let machine = FakeMachine::windows().with_file(r"C:\Program Files\Git\bin\bash.exe");
        assert_eq!(
            find(&detect(&machine), "git-bash").command,
            r"C:\Program Files\Git\bin\bash.exe"
        );
    }

    #[test]
    fn a_registry_key_pointing_nowhere_does_not_invent_a_shell() {
        let mut machine = FakeMachine::windows();
        machine.git = Some(r"D:\uninstalled\Git".into());
        assert!(!ids(&detect(&machine)).contains(&"git-bash"));
    }

    #[test]
    fn every_wsl_distro_becomes_its_own_entry() {
        let mut machine = FakeMachine::windows();
        machine.distros = vec!["Ubuntu".into(), "Debian".into()];

        let shells = detect(&machine);
        assert!(ids(&shells).contains(&"wsl:Ubuntu"));
        assert!(ids(&shells).contains(&"wsl:Debian"));

        let ubuntu = find(&shells, "wsl:Ubuntu");
        assert_eq!(ubuntu.label, "Ubuntu (WSL)");
        assert!(ubuntu.command.ends_with(r"System32\wsl.exe"));
        // argv, never a command line — a distro name with a space in it would
        // otherwise become two arguments.
        assert_eq!(ubuntu.args, vec!["-d", "Ubuntu", "--cd", "~"]);
    }

    /// The registry can list distros on a machine whose `wsl.exe` has been
    /// removed. Offering one would produce a pane that fails at connect.
    #[test]
    fn distros_are_not_offered_without_wsl_exe() {
        let mut machine = FakeMachine::windows().without(r"C:\Windows\System32\wsl.exe");
        machine.distros = vec!["Ubuntu".into()];
        assert!(!ids(&detect(&machine))
            .iter()
            .any(|id| id.starts_with("wsl:")));
    }

    #[test]
    fn a_distro_name_with_a_space_stays_one_argument() {
        let mut machine = FakeMachine::windows();
        machine.distros = vec!["Ubuntu 22.04 LTS".into()];
        assert_eq!(
            find(&detect(&machine), "wsl:Ubuntu 22.04 LTS").args,
            vec!["-d", "Ubuntu 22.04 LTS", "--cd", "~"]
        );
    }

    /// `ComSpec` is what every other launcher on Windows honours.
    #[test]
    fn command_prompt_follows_comspec() {
        let mut machine = FakeMachine::windows();
        machine
            .vars
            .insert("ComSpec".into(), r"C:\alt\cmd.exe".into());
        machine.files.push(r"C:\alt\cmd.exe".into());
        assert_eq!(find(&detect(&machine), "cmd").command, r"C:\alt\cmd.exe");
    }

    /// A `ComSpec` pointing at something gone falls back rather than offering
    /// a command that cannot start.
    #[test]
    fn command_prompt_falls_back_when_comspec_is_stale() {
        let mut machine = FakeMachine::windows();
        machine
            .vars
            .insert("ComSpec".into(), r"C:\gone\cmd.exe".into());
        assert_eq!(
            find(&detect(&machine), "cmd").command,
            r"C:\Windows\System32\cmd.exe"
        );
    }

    /// The elevated host's view, against the real machine. Whatever this
    /// user's environment says, Command Prompt is the one in the system
    /// directory and nothing resolves under their profile.
    #[cfg(windows)]
    #[test]
    fn the_elevated_view_resolves_only_system_locations() {
        let machine = ElevatedMachine;
        assert_eq!(machine.var("ComSpec"), None);
        assert_eq!(machine.var("LOCALAPPDATA"), None);
        let windows = machine.var("SystemRoot").expect("a Windows directory");
        assert!(Path::new(&windows).join("System32").is_dir());

        let shells = detect(&machine);
        let cmd = find(&shells, "cmd");
        assert!(cmd
            .command
            .eq_ignore_ascii_case(&join(&windows, r"System32\cmd.exe")));

        let profile = std::env::var("USERPROFILE").unwrap().to_ascii_lowercase();
        for shell in &shells {
            assert!(
                !shell.command.to_ascii_lowercase().starts_with(&profile),
                "{} resolved under the user profile: {}",
                shell.id,
                shell.command
            );
        }
        assert!(!ids(&shells).iter().any(|id| id.starts_with("wsl:")));
    }

    /// Nothing found is an empty list, never an error: a machine this bare is
    /// not a failure to report, and the picker can say so itself.
    #[test]
    fn a_machine_with_nothing_returns_nothing() {
        assert!(detect(&FakeMachine::default()).is_empty());
    }

    /// The fake cannot exercise a line of the registry code, so this runs the
    /// real thing against the real machine.
    ///
    /// It asserts only what is true of *any* Windows box, because a test that
    /// expected this developer's WSL distros would fail on the next machine.
    /// What it does catch is the whole class of failure the fake cannot: a
    /// registry read that returns garbage, a path built with the wrong
    /// separator, a buffer size miscalculated, or a `DistributionName` decoded
    /// with its trailing NUL still attached — every one of which produces a
    /// `command` that does not name a file.
    #[cfg(windows)]
    #[test]
    fn every_shell_this_machine_reports_can_actually_be_run() {
        let shells = detect(&SystemMachine);

        // `cmd.exe` is on every Windows install there has ever been, so an
        // empty list here means detection is broken rather than that the
        // machine is bare.
        assert!(
            shells.iter().any(|s| s.id == "cmd"),
            "no cmd.exe found: {shells:?}"
        );

        for shell in &shells {
            assert!(!shell.id.is_empty());
            assert!(!shell.label.is_empty());
            assert!(
                Path::new(&shell.command).is_file(),
                "{} points at {}, which is not a file",
                shell.id,
                shell.command
            );
            // A NUL or a stray control character surviving the decode would
            // reach a command line, where it is neither visible nor harmless.
            assert!(
                !shell.id.contains('\0') && !shell.label.contains('\0'),
                "{shell:?} carries a NUL out of the registry"
            );
        }

        let mut ids: Vec<_> = shells.iter().map(|s| s.id.clone()).collect();
        ids.sort();
        let before = ids.len();
        ids.dedup();
        assert_eq!(before, ids.len(), "duplicate id from the real machine");
    }

    /// Ids are what profiles and history keys are built from, so a duplicate
    /// would silently merge two shells.
    #[test]
    fn ids_are_unique() {
        let mut machine = FakeMachine::windows();
        machine.distros = vec!["Ubuntu".into(), "Debian".into()];
        machine.git = Some(r"C:\Program Files\Git".into());
        machine
            .files
            .push(r"C:\Program Files\Git\bin\bash.exe".into());

        let shells = detect(&machine);
        let mut seen = ids(&shells);
        seen.sort_unstable();
        let before = seen.len();
        seen.dedup();
        assert_eq!(
            seen.len(),
            before,
            "duplicate shell id in {:?}",
            ids(&shells)
        );
    }
}
