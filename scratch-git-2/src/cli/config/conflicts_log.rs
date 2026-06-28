//! Workspace-level conflict log (`.scratch/conflicts.log`).
//!
//! Slice D of the simplify-local-workspace plan
//! (`docs/plans/resolved/2026-05-17-simplify-local-workspace-architecture/2026-05-17-simplify-local-workspace-architecture.md`).
//!
//! When `scratchmd files download` re-anchors `accepted-patches.json` against
//! the new server `main` and finds a same-field collision between a user's
//! accepted edit and the server's new value, the user wins by policy — and
//! the collision is appended as one JSON object per line here so the user
//! has an audit trail of what was silently overridden.
//!
//! Size-bounded with a single-file rotation: when the active log reaches
//! `MAX_LOG_BYTES`, it's renamed to `conflicts.log.1` (overwriting any prior
//! rotated file) and the next append starts fresh.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::Context;
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

const FILENAME: &str = "conflicts.log";
const ROTATED_FILENAME: &str = "conflicts.log.1";

/// Rotate when the active log reaches 2 MB. With each entry around 200–400
/// bytes that's tens of thousands of conflicts before rotation — plenty of
/// audit history without the file growing unbounded across years of pulls.
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

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
///
/// Before each append, rotates the file when it has grown to `MAX_LOG_BYTES`.
/// Old contents move to `conflicts.log.1` (overwriting any prior rotated
/// file), and the new append starts a fresh `conflicts.log`. The rename is
/// atomic on POSIX, so a crash mid-rotation can leave behind either layout
/// but never a partial line.
#[allow(dead_code)]
pub fn append(workspace_dir: &Path, entry: &ConflictEntry) -> anyhow::Result<()> {
    let scratch_dir = workspace_dir.join(".scratch");
    fs::create_dir_all(&scratch_dir)
        .with_context(|| format!("failed to create {}", scratch_dir.display()))?;
    let log_path = scratch_dir.join(FILENAME);
    rotate_if_needed(&log_path)?;
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

fn rotate_if_needed(log_path: &Path) -> anyhow::Result<()> {
    let size = match fs::metadata(log_path) {
        Ok(meta) => meta.len(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => {
            return Err(err).with_context(|| format!("failed to stat {}", log_path.display()));
        }
    };
    if size < MAX_LOG_BYTES {
        return Ok(());
    }
    let rotated = log_path.with_file_name(ROTATED_FILENAME);
    fs::rename(log_path, &rotated).with_context(|| {
        format!(
            "failed to rotate {} → {}",
            log_path.display(),
            rotated.display()
        )
    })
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

    fn rotated_path(dir: &Path) -> PathBuf {
        dir.join(".scratch").join(ROTATED_FILENAME)
    }

    #[test]
    fn append_below_threshold_does_not_rotate() {
        let dir = tempdir().unwrap();
        append(dir.path(), &sample_entry()).unwrap();
        append(dir.path(), &sample_entry()).unwrap();
        assert!(path(dir.path()).exists());
        assert!(!rotated_path(dir.path()).exists());
    }

    #[test]
    fn append_rotates_when_threshold_reached() {
        let dir = tempdir().unwrap();
        let scratch_dir = dir.path().join(".scratch");
        fs::create_dir_all(&scratch_dir).unwrap();
        // Seed an existing log at the rotation threshold so the next append
        // triggers rotation without writing megabytes of fixture data.
        let existing = "x".repeat(MAX_LOG_BYTES as usize);
        fs::write(scratch_dir.join(FILENAME), &existing).unwrap();

        append(dir.path(), &sample_entry()).unwrap();

        let rotated = rotated_path(dir.path());
        assert!(
            rotated.exists(),
            "expected rotated file at {}",
            rotated.display()
        );
        assert_eq!(fs::read_to_string(&rotated).unwrap(), existing);
        let fresh = fs::read_to_string(path(dir.path())).unwrap();
        let parsed: ConflictEntry = serde_json::from_str(fresh.trim_end()).unwrap();
        assert_eq!(parsed, sample_entry());
    }

    #[test]
    fn rotation_overwrites_prior_rotated_file() {
        let dir = tempdir().unwrap();
        let scratch_dir = dir.path().join(".scratch");
        fs::create_dir_all(&scratch_dir).unwrap();
        fs::write(scratch_dir.join(ROTATED_FILENAME), "older").unwrap();
        let existing = "y".repeat(MAX_LOG_BYTES as usize);
        fs::write(scratch_dir.join(FILENAME), &existing).unwrap();

        append(dir.path(), &sample_entry()).unwrap();

        assert_eq!(
            fs::read_to_string(rotated_path(dir.path())).unwrap(),
            existing
        );
    }
}
