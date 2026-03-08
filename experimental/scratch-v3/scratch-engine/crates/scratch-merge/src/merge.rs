use std::collections::{HashMap, HashSet};

/// Describes what to do with a file after three-way comparison.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionType {
    /// No disk write needed -- local version is correct.
    KeepLocal,
    /// Overwrite disk with the remote version.
    WriteRemote,
    /// Remove the file from disk.
    Delete,
    /// Base, local, and remote all differ -- needs content merge.
    Merge,
}

/// Describes the resolved action for a single file path.
#[derive(Debug, Clone)]
pub struct MergeAction {
    /// The file path (slash-normalized).
    pub path: String,
    /// The action to take.
    pub action: ActionType,
    /// Content from the base state (`None` means file did not exist).
    pub base: Option<Vec<u8>>,
    /// Content from the local state (`None` means file did not exist).
    pub local: Option<Vec<u8>>,
    /// Content from the remote state (`None` means file did not exist).
    pub remote: Option<Vec<u8>>,
    /// Set when the action discards local changes.
    pub warning_msg: Option<String>,
}

/// Maps slash-normalized relative paths to file contents.
pub type FileMap = HashMap<String, Vec<u8>>;

/// Compares base, local, and remote file maps and returns the list of actions
/// needed to reconcile the working tree.
///
/// Rules (base=B, local=L, remote=R):
///
///   -/-/- impossible (file wouldn't be in any map)
///   -/L/- keep local  (created locally)
///   -/-/R write remote (created on server)
///   -/L/R merge with nil base (both sides created)
///   B/-/- no action   (both deleted)
///   B/L/- delete      (server deleted; warn if L!=B)
///   B/-/R delete      (local deletion wins)
///   B/L=B/R write remote (only server changed)
///   B/L/R=B keep local   (only local changed)
///   B/L=R/R keep local   (same change on both sides)
///   B/L/R   merge        (both sides changed differently)
pub fn compute_merge_actions(base: &FileMap, local: &FileMap, remote: &FileMap) -> Vec<MergeAction> {
    // Build normalized copies of each map so lookups work regardless of
    // the original path format (e.g. `./foo` vs `foo`, backslashes, etc.).
    let base_n = normalize_map(base);
    let local_n = normalize_map(local);
    let remote_n = normalize_map(remote);

    // Collect the union of all normalized paths.
    let mut seen = HashSet::new();
    for p in base_n.keys() {
        seen.insert(p.clone());
    }
    for p in local_n.keys() {
        seen.insert(p.clone());
    }
    for p in remote_n.keys() {
        seen.insert(p.clone());
    }

    let mut actions = Vec::with_capacity(seen.len());

    for p in &seen {
        let b = base_n.get(p.as_str());
        let l = local_n.get(p.as_str());
        let r = remote_n.get(p.as_str());

        let b_ok = b.is_some();
        let l_ok = l.is_some();
        let r_ok = r.is_some();

        let mut act = MergeAction {
            path: p.clone(),
            action: ActionType::KeepLocal, // default, overwritten below
            base: b.cloned(),
            local: l.cloned(),
            remote: r.cloned(),
            warning_msg: None,
        };

        match (b_ok, l_ok, r_ok) {
            // Only local has it -- keep local.
            (false, true, false) => {
                act.action = ActionType::KeepLocal;
            }

            // Only remote has it -- write remote.
            (false, false, true) => {
                act.action = ActionType::WriteRemote;
            }

            // Both sides created (no base) -- merge or keep if identical.
            (false, true, true) => {
                if l.unwrap() == r.unwrap() {
                    act.action = ActionType::KeepLocal;
                } else {
                    act.action = ActionType::Merge;
                }
            }

            // Both deleted -- nothing to do (skip).
            (true, false, false) => {
                continue;
            }

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

            // Local deleted, server still has it -- respect local deletion.
            (true, false, true) => {
                act.action = ActionType::Delete;
            }

            // All three exist.
            (true, true, true) => {
                let local_changed = l.unwrap() != b.unwrap();
                let remote_changed = r.unwrap() != b.unwrap();
                let same_change = l.unwrap() == r.unwrap();

                if same_change {
                    // Identical content -- keep local (no disk write needed).
                    act.action = ActionType::KeepLocal;
                } else if !local_changed {
                    // Only remote changed.
                    act.action = ActionType::WriteRemote;
                } else if !remote_changed {
                    // Only local changed.
                    act.action = ActionType::KeepLocal;
                } else {
                    // Both changed differently -- merge.
                    act.action = ActionType::Merge;
                }
            }

            // Impossible: file not in any map. Should not happen.
            (false, false, false) => {
                continue;
            }
        }

        actions.push(act);
    }

    actions
}

/// Converts a path to use forward slashes and strips leading `./`.
fn normalize(p: &str) -> String {
    let s = p.replace('\\', "/");
    s.strip_prefix("./").unwrap_or(&s).to_string()
}

/// Returns a new FileMap with all keys normalized.
fn normalize_map(m: &FileMap) -> FileMap {
    m.iter()
        .map(|(k, v)| (normalize(k), v.clone()))
        .collect()
}

/// Replaces all `\r\n` sequences with `\n` so that content read from disk on
/// Windows can be compared byte-for-byte with LF-only content from git.
pub fn normalize_crlf(data: &[u8]) -> Vec<u8> {
    let mut result = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        if i + 1 < data.len() && data[i] == b'\r' && data[i + 1] == b'\n' {
            result.push(b'\n');
            i += 2;
        } else {
            result.push(data[i]);
            i += 1;
        }
    }
    result
}

/// Returns `true` if `data` looks like a binary file (contains null bytes in
/// the first 8 KB).
pub fn is_binary(data: &[u8]) -> bool {
    let limit = data.len().min(8192);
    data[..limit].contains(&0)
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Helper ---

    fn file_map(entries: &[(&str, &[u8])]) -> FileMap {
        entries
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_vec()))
            .collect()
    }

    fn find_action<'a>(actions: &'a [MergeAction], path: &str) -> Option<&'a MergeAction> {
        actions.iter().find(|a| a.path == path)
    }

    // --- compute_merge_actions tests ---

    #[test]
    fn test_only_local_keep_local() {
        let base = file_map(&[]);
        let local = file_map(&[("file.txt", b"local content")]);
        let remote = file_map(&[]);

        let actions = compute_merge_actions(&base, &local, &remote);
        let act = find_action(&actions, "file.txt").expect("should have action for file.txt");
        assert_eq!(act.action, ActionType::KeepLocal);
    }

    #[test]
    fn test_only_remote_write_remote() {
        let base = file_map(&[]);
        let local = file_map(&[]);
        let remote = file_map(&[("file.txt", b"remote content")]);

        let actions = compute_merge_actions(&base, &local, &remote);
        let act = find_action(&actions, "file.txt").expect("should have action for file.txt");
        assert_eq!(act.action, ActionType::WriteRemote);
    }

    #[test]
    fn test_both_created_identical_keep_local() {
        let base = file_map(&[]);
        let local = file_map(&[("file.txt", b"same content")]);
        let remote = file_map(&[("file.txt", b"same content")]);

        let actions = compute_merge_actions(&base, &local, &remote);
        let act = find_action(&actions, "file.txt").expect("should have action for file.txt");
        assert_eq!(act.action, ActionType::KeepLocal);
    }

    #[test]
    fn test_both_created_different_merge() {
        let base = file_map(&[]);
        let local = file_map(&[("file.txt", b"local version")]);
        let remote = file_map(&[("file.txt", b"remote version")]);

        let actions = compute_merge_actions(&base, &local, &remote);
        let act = find_action(&actions, "file.txt").expect("should have action for file.txt");
        assert_eq!(act.action, ActionType::Merge);
    }

    #[test]
    fn test_both_deleted_no_action() {
        let base = file_map(&[("file.txt", b"base content")]);
        let local = file_map(&[]);
        let remote = file_map(&[]);

        let actions = compute_merge_actions(&base, &local, &remote);
        assert!(find_action(&actions, "file.txt").is_none());
    }

    #[test]
    fn test_server_deleted_local_unchanged_delete() {
        let base = file_map(&[("file.txt", b"content")]);
        let local = file_map(&[("file.txt", b"content")]);
        let remote = file_map(&[]);

        let actions = compute_merge_actions(&base, &local, &remote);
        let act = find_action(&actions, "file.txt").expect("should have action for file.txt");
        assert_eq!(act.action, ActionType::Delete);
        assert!(act.warning_msg.is_none());
    }

    #[test]
    fn test_server_deleted_local_changed_delete_with_warning() {
        let base = file_map(&[("file.txt", b"base content")]);
        let local = file_map(&[("file.txt", b"modified locally")]);
        let remote = file_map(&[]);

        let actions = compute_merge_actions(&base, &local, &remote);
        let act = find_action(&actions, "file.txt").expect("should have action for file.txt");
        assert_eq!(act.action, ActionType::Delete);
        assert!(act.warning_msg.is_some());
        assert!(act
            .warning_msg
            .as_ref()
            .unwrap()
            .contains("deleted on server but had local changes"));
    }

    #[test]
    fn test_local_deleted_server_exists_delete() {
        let base = file_map(&[("file.txt", b"content")]);
        let local = file_map(&[]);
        let remote = file_map(&[("file.txt", b"content")]);

        let actions = compute_merge_actions(&base, &local, &remote);
        let act = find_action(&actions, "file.txt").expect("should have action for file.txt");
        assert_eq!(act.action, ActionType::Delete);
    }

    #[test]
    fn test_local_deleted_server_modified_delete() {
        let base = file_map(&[("file.txt", b"base")]);
        let local = file_map(&[]);
        let remote = file_map(&[("file.txt", b"modified on server")]);

        let actions = compute_merge_actions(&base, &local, &remote);
        let act = find_action(&actions, "file.txt").expect("should have action for file.txt");
        assert_eq!(act.action, ActionType::Delete);
    }

    #[test]
    fn test_only_remote_changed_write_remote() {
        let base = file_map(&[("file.txt", b"base")]);
        let local = file_map(&[("file.txt", b"base")]);
        let remote = file_map(&[("file.txt", b"remote changed")]);

        let actions = compute_merge_actions(&base, &local, &remote);
        let act = find_action(&actions, "file.txt").expect("should have action for file.txt");
        assert_eq!(act.action, ActionType::WriteRemote);
    }

    #[test]
    fn test_only_local_changed_keep_local() {
        let base = file_map(&[("file.txt", b"base")]);
        let local = file_map(&[("file.txt", b"local changed")]);
        let remote = file_map(&[("file.txt", b"base")]);

        let actions = compute_merge_actions(&base, &local, &remote);
        let act = find_action(&actions, "file.txt").expect("should have action for file.txt");
        assert_eq!(act.action, ActionType::KeepLocal);
    }

    #[test]
    fn test_same_change_both_sides_keep_local() {
        let base = file_map(&[("file.txt", b"base")]);
        let local = file_map(&[("file.txt", b"same change")]);
        let remote = file_map(&[("file.txt", b"same change")]);

        let actions = compute_merge_actions(&base, &local, &remote);
        let act = find_action(&actions, "file.txt").expect("should have action for file.txt");
        assert_eq!(act.action, ActionType::KeepLocal);
    }

    #[test]
    fn test_both_changed_differently_merge() {
        let base = file_map(&[("file.txt", b"base")]);
        let local = file_map(&[("file.txt", b"local change")]);
        let remote = file_map(&[("file.txt", b"remote change")]);

        let actions = compute_merge_actions(&base, &local, &remote);
        let act = find_action(&actions, "file.txt").expect("should have action for file.txt");
        assert_eq!(act.action, ActionType::Merge);
    }

    #[test]
    fn test_multiple_files() {
        let base = file_map(&[("a.txt", b"base-a"), ("b.txt", b"base-b")]);
        let local = file_map(&[("a.txt", b"local-a"), ("b.txt", b"base-b"), ("c.txt", b"new-c")]);
        let remote = file_map(&[("a.txt", b"base-a"), ("b.txt", b"remote-b")]);

        let actions = compute_merge_actions(&base, &local, &remote);

        let act_a = find_action(&actions, "a.txt").expect("should have a.txt");
        assert_eq!(act_a.action, ActionType::KeepLocal); // only local changed

        let act_b = find_action(&actions, "b.txt").expect("should have b.txt");
        assert_eq!(act_b.action, ActionType::WriteRemote); // only remote changed

        let act_c = find_action(&actions, "c.txt").expect("should have c.txt");
        assert_eq!(act_c.action, ActionType::KeepLocal); // only local has it
    }

    #[test]
    fn test_path_normalization() {
        let base = file_map(&[]);
        let local = file_map(&[("./folder/file.txt", b"content")]);
        let remote = file_map(&[]);

        let actions = compute_merge_actions(&base, &local, &remote);
        let act = find_action(&actions, "folder/file.txt").expect("should normalize path");
        assert_eq!(act.action, ActionType::KeepLocal);
    }

    #[test]
    fn test_merge_action_carries_content() {
        let base = file_map(&[("f.txt", b"base")]);
        let local = file_map(&[("f.txt", b"local")]);
        let remote = file_map(&[("f.txt", b"remote")]);

        let actions = compute_merge_actions(&base, &local, &remote);
        let act = find_action(&actions, "f.txt").expect("should have f.txt");
        assert_eq!(act.action, ActionType::Merge);
        assert_eq!(act.base.as_deref(), Some(b"base".as_slice()));
        assert_eq!(act.local.as_deref(), Some(b"local".as_slice()));
        assert_eq!(act.remote.as_deref(), Some(b"remote".as_slice()));
    }

    // --- normalize_crlf tests ---

    #[test]
    fn test_normalize_crlf_basic() {
        let input = b"hello\r\nworld\r\n";
        let result = normalize_crlf(input);
        assert_eq!(result, b"hello\nworld\n");
    }

    #[test]
    fn test_normalize_crlf_no_change() {
        let input = b"hello\nworld\n";
        let result = normalize_crlf(input);
        assert_eq!(result, b"hello\nworld\n");
    }

    #[test]
    fn test_normalize_crlf_mixed() {
        let input = b"a\r\nb\nc\r\nd";
        let result = normalize_crlf(input);
        assert_eq!(result, b"a\nb\nc\nd");
    }

    #[test]
    fn test_normalize_crlf_empty() {
        let result = normalize_crlf(b"");
        assert_eq!(result, b"");
    }

    #[test]
    fn test_normalize_crlf_preserves_lone_cr() {
        // Lone \r (not followed by \n) should be preserved
        let input = b"a\rb";
        let result = normalize_crlf(input);
        assert_eq!(result, b"a\rb");
    }

    // --- is_binary tests ---

    #[test]
    fn test_is_binary_with_null_byte() {
        let mut data = vec![b'a'; 100];
        data[50] = 0;
        assert!(is_binary(&data));
    }

    #[test]
    fn test_is_binary_text_only() {
        let data = b"Hello, world!\nThis is text.\n";
        assert!(!is_binary(data));
    }

    #[test]
    fn test_is_binary_empty() {
        assert!(!is_binary(b""));
    }

    #[test]
    fn test_is_binary_null_at_start() {
        let data = b"\x00hello";
        assert!(is_binary(data));
    }

    #[test]
    fn test_is_binary_null_beyond_8kb() {
        let mut data = vec![b'a'; 9000];
        data[8500] = 0; // beyond 8KB limit
        assert!(!is_binary(&data));
    }

    #[test]
    fn test_is_binary_null_at_8kb_boundary() {
        let mut data = vec![b'a'; 8192];
        data[8191] = 0; // at the boundary (within the first 8KB)
        assert!(is_binary(&data));
    }

    // --- normalize path tests ---

    #[test]
    fn test_normalize_strips_dot_slash() {
        assert_eq!(normalize("./foo/bar"), "foo/bar");
    }

    #[test]
    fn test_normalize_backslash_to_forward() {
        assert_eq!(normalize("foo\\bar\\baz"), "foo/bar/baz");
    }

    #[test]
    fn test_normalize_no_change() {
        assert_eq!(normalize("foo/bar"), "foo/bar");
    }
}
