pub mod text;

use std::collections::{HashMap, HashSet};

/// Describes what action to take for a file.
#[derive(Debug, PartialEq)]
pub enum ActionType {
    /// No disk write needed — local version is correct.
    KeepLocal,
    /// Overwrite disk with the remote version.
    WriteRemote,
    /// Remove the file from disk.
    Delete,
    /// Both sides changed differently — needs content merge.
    Merge,
}

/// The resolved action for a single file path.
pub struct MergeAction {
    pub path: String,
    pub action: ActionType,
    pub base: Option<Vec<u8>>,
    pub local: Option<Vec<u8>>,
    pub remote: Option<Vec<u8>>,
    pub warning_msg: Option<String>,
}

/// Maps slash-normalized relative paths to file contents.
pub type FileMap = HashMap<String, Vec<u8>>;

/// Compares base, local, and remote file maps and returns the list of actions
/// needed to reconcile the working tree.
///
/// Rules (base=B, local=L, remote=R):
/// - -/L/- → keep local (created locally)
/// - -/-/R → write remote (created on server)
/// - -/L/R → merge with nil base (both created) or keep if equal
/// - B/-/- → skip (both deleted)
/// - B/L/- → delete (server deleted; warn if L!=B)
/// - B/-/R → delete (local deletion wins)
/// - B/L=B/R → write remote (only server changed)
/// - B/L/R=B → keep local (only local changed)
/// - B/L=R/R → keep local (same change on both sides)
/// - B/L/R → merge (both changed differently)
pub fn compute_merge_actions(base: &FileMap, local: &FileMap, remote: &FileMap) -> Vec<MergeAction> {
    // Build normalized lookup maps so keys like "./foo" and "foo" are treated as equal.
    let norm_base: HashMap<String, &Vec<u8>> = base.iter().map(|(k, v)| (normalize(k), v)).collect();
    let norm_local: HashMap<String, &Vec<u8>> = local.iter().map(|(k, v)| (normalize(k), v)).collect();
    let norm_remote: HashMap<String, &Vec<u8>> = remote.iter().map(|(k, v)| (normalize(k), v)).collect();

    let mut seen = HashSet::new();
    for p in norm_base.keys() {
        seen.insert(p.clone());
    }
    for p in norm_local.keys() {
        seen.insert(p.clone());
    }
    for p in norm_remote.keys() {
        seen.insert(p.clone());
    }

    let mut actions = Vec::with_capacity(seen.len());

    for p in seen {
        let b = norm_base.get(&p).copied();
        let l = norm_local.get(&p).copied();
        let r = norm_remote.get(&p).copied();

        let b_ok = b.is_some();
        let l_ok = l.is_some();
        let r_ok = r.is_some();

        let mut act = MergeAction {
            path: p.clone(),
            action: ActionType::KeepLocal, // default
            base: b.cloned(),
            local: l.cloned(),
            remote: r.cloned(),
            warning_msg: None,
        };

        match (b_ok, l_ok, r_ok) {
            // Only local has it — keep local.
            (false, true, false) => act.action = ActionType::KeepLocal,

            // Only remote has it — write remote.
            (false, false, true) => act.action = ActionType::WriteRemote,

            // Both sides created (no base).
            (false, true, true) => {
                if l.unwrap() == r.unwrap() {
                    act.action = ActionType::KeepLocal;
                } else {
                    act.action = ActionType::Merge;
                }
            }

            // Both deleted — skip.
            (true, false, false) => continue,

            // Server deleted, local still exists.
            (true, true, false) => {
                act.action = ActionType::Delete;
                if l.unwrap() != b.unwrap() {
                    act.warning_msg = Some(format!(
                        "'{}' deleted on server but had local changes",
                        p
                    ));
                }
            }

            // Local deleted, server still has it — respect local deletion.
            (true, false, true) => act.action = ActionType::Delete,

            // All three exist.
            (true, true, true) => {
                let local_changed = l.unwrap() != b.unwrap();
                let remote_changed = r.unwrap() != b.unwrap();
                let same_change = l.unwrap() == r.unwrap();

                if same_change {
                    act.action = ActionType::KeepLocal;
                } else if !local_changed {
                    act.action = ActionType::WriteRemote;
                } else if !remote_changed {
                    act.action = ActionType::KeepLocal;
                } else {
                    act.action = ActionType::Merge;
                }
            }

            // Impossible: no file in any map.
            (false, false, false) => continue,
        }

        actions.push(act);
    }

    actions
}

/// Normalize a path to use forward slashes and strip leading "./".
fn normalize(p: &str) -> String {
    let p = p.replace('\\', "/");
    p.strip_prefix("./").unwrap_or(&p).to_string()
}

/// Replace all \r\n with \n for cross-platform comparison.
pub fn normalize_crlf(data: &[u8]) -> Vec<u8> {
    let s = String::from_utf8_lossy(data);
    s.replace("\r\n", "\n").into_bytes()
}

/// Returns true if data looks like a binary file (contains null bytes in first 8KB).
pub fn is_binary(data: &[u8]) -> bool {
    let limit = data.len().min(8192);
    data[..limit].contains(&0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_map(entries: &[(&str, &[u8])]) -> FileMap {
        entries
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_vec()))
            .collect()
    }

    fn find_action<'a>(actions: &'a [MergeAction], path: &str) -> Option<&'a MergeAction> {
        actions.iter().find(|a| a.path == path)
    }

    // ---- normalize ----

    #[test]
    fn normalize_strips_dot_slash() {
        assert_eq!(normalize("./foo/bar.txt"), "foo/bar.txt");
    }

    #[test]
    fn normalize_replaces_backslashes() {
        assert_eq!(normalize("foo\\bar\\baz.txt"), "foo/bar/baz.txt");
    }

    #[test]
    fn normalize_passthrough() {
        assert_eq!(normalize("already/fine.txt"), "already/fine.txt");
    }

    #[test]
    fn normalize_dot_slash_and_backslash() {
        assert_eq!(normalize(".\\foo\\bar"), "foo/bar");
    }

    // ---- normalize_crlf ----

    #[test]
    fn normalize_crlf_converts() {
        assert_eq!(normalize_crlf(b"a\r\nb\r\n"), b"a\nb\n");
    }

    #[test]
    fn normalize_crlf_no_change_for_lf() {
        assert_eq!(normalize_crlf(b"a\nb\n"), b"a\nb\n");
    }

    #[test]
    fn normalize_crlf_mixed() {
        assert_eq!(normalize_crlf(b"a\r\nb\nc\r\n"), b"a\nb\nc\n");
    }

    #[test]
    fn normalize_crlf_empty() {
        assert_eq!(normalize_crlf(b""), b"");
    }

    // ---- is_binary ----

    #[test]
    fn is_binary_false_for_text() {
        assert!(!is_binary(b"hello world\nfoo bar"));
    }

    #[test]
    fn is_binary_true_for_null_byte() {
        assert!(is_binary(b"hello\x00world"));
    }

    #[test]
    fn is_binary_empty_is_not_binary() {
        assert!(!is_binary(b""));
    }

    #[test]
    fn is_binary_checks_only_first_8kb() {
        let mut data = vec![b'a'; 8193];
        data[8192] = 0; // null byte beyond 8KB limit
        assert!(!is_binary(&data));
    }

    #[test]
    fn is_binary_null_within_8kb() {
        let mut data = vec![b'a'; 8192];
        data[4000] = 0;
        assert!(is_binary(&data));
    }

    // ---- compute_merge_actions: all 10 cases ----

    // Case 1: -/L/- → KeepLocal (created locally only)
    #[test]
    fn case_only_local() {
        let base = make_map(&[]);
        let local = make_map(&[("new.txt", b"local content")]);
        let remote = make_map(&[]);
        let actions = compute_merge_actions(&base, &local, &remote);
        let act = find_action(&actions, "new.txt").unwrap();
        assert_eq!(act.action, ActionType::KeepLocal);
    }

    // Case 2: -/-/R → WriteRemote (created on server only)
    #[test]
    fn case_only_remote() {
        let base = make_map(&[]);
        let local = make_map(&[]);
        let remote = make_map(&[("new.txt", b"remote content")]);
        let actions = compute_merge_actions(&base, &local, &remote);
        let act = find_action(&actions, "new.txt").unwrap();
        assert_eq!(act.action, ActionType::WriteRemote);
    }

    // Case 3a: -/L/R (same content) → KeepLocal
    #[test]
    fn case_both_created_same_content() {
        let base = make_map(&[]);
        let local = make_map(&[("new.txt", b"same content")]);
        let remote = make_map(&[("new.txt", b"same content")]);
        let actions = compute_merge_actions(&base, &local, &remote);
        let act = find_action(&actions, "new.txt").unwrap();
        assert_eq!(act.action, ActionType::KeepLocal);
    }

    // Case 3b: -/L/R (different content) → Merge
    #[test]
    fn case_both_created_different_content() {
        let base = make_map(&[]);
        let local = make_map(&[("new.txt", b"local version")]);
        let remote = make_map(&[("new.txt", b"remote version")]);
        let actions = compute_merge_actions(&base, &local, &remote);
        let act = find_action(&actions, "new.txt").unwrap();
        assert_eq!(act.action, ActionType::Merge);
    }

    // Case 4: B/-/- → skip (both deleted)
    #[test]
    fn case_both_deleted() {
        let base = make_map(&[("old.txt", b"content")]);
        let local = make_map(&[]);
        let remote = make_map(&[]);
        let actions = compute_merge_actions(&base, &local, &remote);
        assert!(find_action(&actions, "old.txt").is_none());
    }

    // Case 5a: B/L/- (L==B) → Delete (server deleted, no local changes)
    #[test]
    fn case_server_deleted_no_local_changes() {
        let base = make_map(&[("file.txt", b"original")]);
        let local = make_map(&[("file.txt", b"original")]);
        let remote = make_map(&[]);
        let actions = compute_merge_actions(&base, &local, &remote);
        let act = find_action(&actions, "file.txt").unwrap();
        assert_eq!(act.action, ActionType::Delete);
        assert!(act.warning_msg.is_none());
    }

    // Case 5b: B/L/- (L!=B) → Delete with warning
    #[test]
    fn case_server_deleted_with_local_changes() {
        let base = make_map(&[("file.txt", b"original")]);
        let local = make_map(&[("file.txt", b"modified locally")]);
        let remote = make_map(&[]);
        let actions = compute_merge_actions(&base, &local, &remote);
        let act = find_action(&actions, "file.txt").unwrap();
        assert_eq!(act.action, ActionType::Delete);
        assert!(act.warning_msg.is_some());
        assert!(act.warning_msg.as_ref().unwrap().contains("local changes"));
    }

    // Case 6: B/-/R → Delete (local deletion wins)
    #[test]
    fn case_local_deleted() {
        let base = make_map(&[("file.txt", b"original")]);
        let local = make_map(&[]);
        let remote = make_map(&[("file.txt", b"updated remotely")]);
        let actions = compute_merge_actions(&base, &local, &remote);
        let act = find_action(&actions, "file.txt").unwrap();
        assert_eq!(act.action, ActionType::Delete);
    }

    // Case 7: B/L=B/R → WriteRemote (only server changed)
    #[test]
    fn case_only_remote_changed() {
        let base = make_map(&[("file.txt", b"original")]);
        let local = make_map(&[("file.txt", b"original")]);
        let remote = make_map(&[("file.txt", b"updated")]);
        let actions = compute_merge_actions(&base, &local, &remote);
        let act = find_action(&actions, "file.txt").unwrap();
        assert_eq!(act.action, ActionType::WriteRemote);
    }

    // Case 8: B/L/R=B → KeepLocal (only local changed)
    #[test]
    fn case_only_local_changed() {
        let base = make_map(&[("file.txt", b"original")]);
        let local = make_map(&[("file.txt", b"local edit")]);
        let remote = make_map(&[("file.txt", b"original")]);
        let actions = compute_merge_actions(&base, &local, &remote);
        let act = find_action(&actions, "file.txt").unwrap();
        assert_eq!(act.action, ActionType::KeepLocal);
    }

    // Case 9: B/L=R/R → KeepLocal (same change on both sides)
    #[test]
    fn case_same_change_both_sides() {
        let base = make_map(&[("file.txt", b"original")]);
        let local = make_map(&[("file.txt", b"same edit")]);
        let remote = make_map(&[("file.txt", b"same edit")]);
        let actions = compute_merge_actions(&base, &local, &remote);
        let act = find_action(&actions, "file.txt").unwrap();
        assert_eq!(act.action, ActionType::KeepLocal);
    }

    // Case 10: B/L/R (all different) → Merge
    #[test]
    fn case_both_changed_differently() {
        let base = make_map(&[("file.txt", b"original")]);
        let local = make_map(&[("file.txt", b"local edit")]);
        let remote = make_map(&[("file.txt", b"remote edit")]);
        let actions = compute_merge_actions(&base, &local, &remote);
        let act = find_action(&actions, "file.txt").unwrap();
        assert_eq!(act.action, ActionType::Merge);
    }

    // ---- Multiple files ----

    #[test]
    fn multiple_files_different_actions() {
        let base = make_map(&[
            ("unchanged.txt", b"same"),
            ("remote_only.txt", b"old"),
            ("deleted.txt", b"gone"),
        ]);
        let local = make_map(&[
            ("unchanged.txt", b"same"),
            ("remote_only.txt", b"old"),
            ("new_local.txt", b"created"),
        ]);
        let remote = make_map(&[
            ("unchanged.txt", b"same"),
            ("remote_only.txt", b"updated"),
            ("new_remote.txt", b"from server"),
        ]);
        let actions = compute_merge_actions(&base, &local, &remote);

        // unchanged → KeepLocal (same on all sides)
        assert_eq!(
            find_action(&actions, "unchanged.txt").unwrap().action,
            ActionType::KeepLocal
        );
        // remote_only → WriteRemote (local unchanged, remote changed)
        assert_eq!(
            find_action(&actions, "remote_only.txt").unwrap().action,
            ActionType::WriteRemote
        );
        // deleted.txt: B/-/- → both deleted, skipped
        assert!(find_action(&actions, "deleted.txt").is_none());
        // new_local → KeepLocal
        assert_eq!(
            find_action(&actions, "new_local.txt").unwrap().action,
            ActionType::KeepLocal
        );
        // new_remote → WriteRemote
        assert_eq!(
            find_action(&actions, "new_remote.txt").unwrap().action,
            ActionType::WriteRemote
        );
    }

    // ---- Path normalization in merge ----

    #[test]
    fn paths_normalized_across_maps() {
        let base = make_map(&[("./foo/bar.txt", b"original")]);
        let local = make_map(&[("foo/bar.txt", b"original")]);
        let remote = make_map(&[("foo/bar.txt", b"updated")]);
        let actions = compute_merge_actions(&base, &local, &remote);
        let act = find_action(&actions, "foo/bar.txt").unwrap();
        assert_eq!(act.action, ActionType::WriteRemote);
    }

    // ---- MergeAction carries data ----

    #[test]
    fn merge_action_carries_all_data() {
        let base = make_map(&[("f.txt", b"base")]);
        let local = make_map(&[("f.txt", b"local")]);
        let remote = make_map(&[("f.txt", b"remote")]);
        let actions = compute_merge_actions(&base, &local, &remote);
        let act = find_action(&actions, "f.txt").unwrap();
        assert_eq!(act.action, ActionType::Merge);
        assert_eq!(act.base.as_deref(), Some(b"base".as_ref()));
        assert_eq!(act.local.as_deref(), Some(b"local".as_ref()));
        assert_eq!(act.remote.as_deref(), Some(b"remote".as_ref()));
    }

    // ---- Empty maps ----

    #[test]
    fn all_empty_maps() {
        let empty = make_map(&[]);
        let actions = compute_merge_actions(&empty, &empty, &empty);
        assert!(actions.is_empty());
    }
}
