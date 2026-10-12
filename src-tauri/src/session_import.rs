//! What every session importer (PuTTY, `~/.ssh/config`) shares after mapping
//! a foreign session to a [`SessionProfile`]: minting ids, appending without
//! clobbering, and reporting.

use serde::Serialize;

use crate::profiles::SessionProfile;

/// What an import did, for the UI to report.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    /// Profiles added.
    pub imported: usize,
    /// Already present by label and host (see [`merge_into`]).
    pub skipped_duplicates: usize,
    /// Sessions this app can't represent, as each importer defines it.
    pub skipped_unsupported: usize,
    /// Labels of what was imported, for the UI.
    pub labels: Vec<String>,
}

/// Appends candidates not already saved.
///
/// A session with the same label and host is left alone, so re-running is
/// harmless and edits aren't reverted; matching both fields keeps a
/// same-named unrelated profile from blocking it. `existing` is mutated in
/// place under the caller's profile lock, so duplicates within one run are
/// caught too.
pub fn merge_into(
    existing: &mut Vec<SessionProfile>,
    candidates: Vec<SessionProfile>,
) -> ImportSummary {
    let mut summary = ImportSummary::default();
    for profile in candidates {
        if existing
            .iter()
            .any(|p| p.label == profile.label && p.host == profile.host)
        {
            summary.skipped_duplicates += 1;
            continue;
        }
        summary.labels.push(profile.label.clone());
        summary.imported += 1;
        existing.push(profile);
    }
    summary
}

/// An id not in use and never minted again: `prefix` (`"putty"`, `"sshcfg"`)
/// plus eight random bytes (like `wr-vault`'s `new_wrapper_id`).
///
/// A profile id is also its vault key, and a credential can outlive its
/// profile (deleting with the vault locked leaves it), so a reused id would
/// silently authenticate a new host with another's secret.
pub fn next_id(existing: &[SessionProfile], prefix: &str) -> String {
    loop {
        let suffix: String = wr_vault::random_bytes::<8>()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let candidate = format!("{prefix}-{suffix}");
        if !existing.iter().any(|p| p.id == candidate) {
            return candidate;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: &str, label: &str, host: &str) -> SessionProfile {
        SessionProfile {
            id: id.to_string(),
            label: label.to_string(),
            folder: None,
            host: host.to_string(),
            port: 22,
            protocol: "ssh".to_string(),
            username: String::new(),
            auth_type: "agent".to_string(),
            key_path: None,
            has_credential: false,
            jump_profile_id: None,
            term_type: None,
            backspace_sends_ctrl_h: None,
            keepalive_seconds: None,
            wake_on_lan: None,
            auto_reconnect: None,
            import_remote_history: None,
            use_proxy: None,
            log_session: None,
            serial: None,
            local: None,
        }
    }

    /// Re-running doesn't revert an edited profile.
    #[test]
    fn an_already_saved_session_is_left_exactly_as_it_is() {
        let mut existing = vec![profile("mine", "prod", "10.0.0.5")];
        existing[0].username = "tim".into();

        let summary = merge_into(&mut existing, vec![profile("new", "prod", "10.0.0.5")]);

        assert_eq!(summary.imported, 0);
        assert_eq!(summary.skipped_duplicates, 1);
        assert_eq!(existing.len(), 1);
        assert_eq!(existing[0].id, "mine");
        assert_eq!(existing[0].username, "tim");
    }

    /// A same-named unrelated profile doesn't block an import.
    #[test]
    fn a_shared_name_on_a_different_host_still_imports() {
        let mut existing = vec![profile("mine", "router", "192.168.1.1")];
        let summary = merge_into(&mut existing, vec![profile("new", "router", "10.9.9.1")]);
        assert_eq!(summary.imported, 1);
        assert_eq!(summary.labels, vec!["router"]);
        assert_eq!(existing.len(), 2);
    }

    /// Duplicates within one run are caught.
    #[test]
    fn two_identical_candidates_import_once() {
        let mut existing = Vec::new();
        let summary = merge_into(
            &mut existing,
            vec![profile("a", "dup", "h"), profile("b", "dup", "h")],
        );
        assert_eq!(summary.imported, 1);
        assert_eq!(summary.skipped_duplicates, 1);
    }

    /// Ids never recur, since a recycled id could inherit another host's
    /// credential.
    #[test]
    fn a_deleted_imports_id_is_never_handed_out_again() {
        let mut existing: Vec<SessionProfile> = (0..10)
            .map(|_| profile(&next_id(&[], "putty"), "h", "h"))
            .collect();

        let retired: Vec<String> = existing.split_off(8).into_iter().map(|p| p.id).collect();

        // The vault keeps entries under retired ids.
        for _ in 0..64 {
            let minted = next_id(&existing, "putty");
            assert!(
                !retired.contains(&minted),
                "{minted} was reissued after its profile was deleted"
            );
            existing.push(profile(&minted, "h", "h"));
        }
    }

    /// The prefix marks an import; the suffix makes it unrepeatable.
    #[test]
    fn imported_ids_are_prefixed_and_random() {
        let id = next_id(&[], "sshcfg");
        let suffix = id.strip_prefix("sshcfg-").expect("keeps the prefix");
        assert_eq!(suffix.len(), 16, "eight bytes as hex");
        assert!(suffix.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(id, next_id(&[], "sshcfg"));
    }
}
