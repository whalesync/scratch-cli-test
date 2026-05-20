//! Workspace-level conflict log (`.scratch/conflicts.log`).
//!
//! Slice D of the simplify-local-workspace plan
//! (`docs/plans/2026-05-17-simplify-local-workspace-architecture.md`).
//!
//! When `scratchmd files download` re-anchors `accepted-patches.json` against
//! the new server `main` and finds a same-field collision between a user's
//! accepted edit and the server's new value, the user wins by policy — and
//! the collision is appended as one JSON object per line here so the user
//! has an audit trail of what was silently overridden.
//!
//! Append-only; never truncated by the CLI. Rotation is a deferred follow-up
//! (see F10 in the plan's CEO follow-ups).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::Context;
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

const FILENAME: &str = "conflicts.log";

/// Single-line record in `.scratch/conflicts.log`. Field names serialize to
/// camelCase to match the plan spec and stay consistent with the on-wire
/// payload conventions.
///
/// `conflicting_keys` lists the RFC 7396 keys touched by both the user's
/// accepted patch and the server's new state. The sentinel `["*"]` marks
/// whole-file conflicts that aren't field-scoped (e.g. server deleted a path
/// the user had `update`d).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictEntry {
    pub ts: String,
    pub connector_account_id: String,
    pub path: String,
    pub conflicting_keys: Vec<String>,
}

/// Resolve the path to the workspace's conflicts log
/// (`<workspace>/.scratch/conflicts.log`).
#[allow(dead_code)]
pub fn path(workspace_dir: &Path) -> PathBuf {
    workspace_dir.join(".scratch").join(FILENAME)
}

/// Append a single conflict entry. Creates `.scratch/` and the file lazily.
///
/// Each call writes one JSON object plus `\n` in a single `write_all`. POSIX
/// guarantees writes ≤ PIPE_BUF (4096 bytes) to an `O_APPEND` file are atomic
/// against concurrent writers, so the log is safe under the workspace lock
/// and robust if multiple connections log in parallel later.
#[allow(dead_code)]
pub fn append(workspace_dir: &Path, entry: &ConflictEntry) -> anyhow::Result<()> {
    let scratch_dir = workspace_dir.join(".scratch");
    fs::create_dir_all(&scratch_dir)
        .with_context(|| format!("failed to create {}", scratch_dir.display()))?;
    let log_path = scratch_dir.join(FILENAME);
    let mut line = serde_json::to_vec(entry).context("failed to serialize conflict entry")?;
    line.push(b'\n');
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .with_context(|| format!("failed to open {}", log_path.display()))?;
    file.write_all(&line)?;
    Ok(())
}

/// Current UTC time formatted as RFC 3339 with seconds precision and the `Z`
/// suffix (e.g. `2026-05-18T13:24:51Z`). Matches the plan's spec so future
/// readers can `cut` and parse without extra options.
#[allow(dead_code)]
pub fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn sample_entry() -> ConflictEntry {
        ConflictEntry {
            ts: "2026-05-18T13:24:51Z".into(),
            connector_account_id: "ca_abc123".into(),
            path: "Companies/rec123.json".into(),
            conflicting_keys: vec!["website".into(), "industry".into()],
        }
    }

    #[test]
    fn append_creates_scratch_dir_and_file_lazily() {
        let dir = tempdir().unwrap();
        assert!(!dir.path().join(".scratch").exists());
        append(dir.path(), &sample_entry()).unwrap();
        assert!(path(dir.path()).exists());
    }

    #[test]
    fn append_writes_one_json_object_per_line() {
        let dir = tempdir().unwrap();
        append(dir.path(), &sample_entry()).unwrap();
        append(dir.path(), &sample_entry()).unwrap();
        let contents = fs::read_to_string(path(dir.path())).unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 2);
        for line in lines {
            let parsed: ConflictEntry = serde_json::from_str(line).unwrap();
            assert_eq!(parsed, sample_entry());
        }
    }

    #[test]
    fn serialization_uses_camelcase_field_names() {
        let json = serde_json::to_string(&sample_entry()).unwrap();
        assert!(json.contains("\"connectorAccountId\""));
        assert!(json.contains("\"conflictingKeys\""));
        assert!(!json.contains("\"connector_account_id\""));
        assert!(!json.contains("\"conflicting_keys\""));
    }

    #[test]
    fn whole_file_conflict_sentinel_round_trips() {
        let dir = tempdir().unwrap();
        let entry = ConflictEntry {
            ts: now_rfc3339(),
            connector_account_id: "ca_x".into(),
            path: "Companies/rec_gone.json".into(),
            conflicting_keys: vec!["*".into()],
        };
        append(dir.path(), &entry).unwrap();
        let line = fs::read_to_string(path(dir.path())).unwrap();
        let parsed: ConflictEntry = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(parsed.conflicting_keys, vec!["*"]);
    }

    #[test]
    fn now_rfc3339_returns_parsable_timestamp_with_z_suffix() {
        let ts = now_rfc3339();
        chrono::DateTime::parse_from_rfc3339(&ts).expect("must parse as RFC 3339");
        assert!(ts.ends_with('Z'), "expected Z suffix, got {ts}");
        assert!(
            !ts.contains('.'),
            "expected seconds precision (no fractional), got {ts}",
        );
    }

    #[test]
    fn append_three_entries_all_round_trip_in_order() {
        let dir = tempdir().unwrap();
        let entries: Vec<ConflictEntry> = (0..3)
            .map(|i| ConflictEntry {
                ts: format!("2026-05-20T10:00:0{i}Z"),
                connector_account_id: format!("ca_{i}"),
                path: format!("Folder/rec_{i}.json"),
                conflicting_keys: vec![format!("field_{i}")],
            })
            .collect();
        for e in &entries {
            append(dir.path(), e).unwrap();
        }
        let contents = fs::read_to_string(path(dir.path())).unwrap();
        let parsed: Vec<ConflictEntry> = contents
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(parsed, entries);
    }
}
