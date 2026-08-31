//! The maintenance database — a **throw-away cache and journal**, never the truth.
//!
//! `<root>/maintenance/maintenance.sqlite`, where `<root>` is the parent of `GIT_REPOS_DIR`
//! (the same root `staging/` hangs off). Everything `decide()` needs is derived from files git
//! already maintains (`objects/info/commit-graph` mtime = last full, newest `objects/pack/*.pack`
//! mtime = last quick); this DB only adds what files cannot tell you — outcomes, history, ticks —
//! plus the one setting (the switch). Delete the file at any time: the next tick recreates it
//! and no extra GC work results.
//!
//! Contract every caller relies on:
//! - **writes create the DB** (and its tables) if it does not exist;
//! - **reads assume defaults** when the DB, a table, or a row is missing — they never create
//!   the file, never fail the caller, and log at warn when the file exists but cannot be read.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};

use crate::service::maintenance::{ObjectCounts, StepMode, StepOutcome, TickSummary};

pub const MAINTENANCE_DB_FILE_NAME: &str = "maintenance.sqlite";
const SETTING_ENABLED: &str = "enabled";
const BUSY_TIMEOUT_MS: u64 = 5_000;

/// Default retention for `maintenance_runs` / `ticks`.
pub const RUN_RETENTION_MS: i64 = 30 * 24 * 3_600_000;

/// One `settings` row.
#[derive(Clone, Debug, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SettingRow {
    pub key: String,
    pub value: String,
    pub updated_at_ms: i64,
}

/// One `ticks` row.
#[derive(Clone, Debug, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TickRow {
    pub id: i64,
    pub started_at_ms: i64,
    pub duration_ms: i64,
    pub scan_ms: i64,
    pub repos_scanned: i64,
    pub repos_unreadable: i64,
    pub due_quick: i64,
    pub due_full: i64,
    pub ran: i64,
    pub aborted: bool,
}

/// A run row as returned to the status/history endpoints.
#[derive(Clone, Debug, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceRunRow {
    pub id: i64,
    pub repo_id: String,
    pub outcome: StepOutcome,
}

#[derive(Clone, Debug)]
pub struct MaintenanceDb {
    path: PathBuf,
}

impl MaintenanceDb {
    pub fn at(maintenance_dir: &Path) -> Self {
        Self {
            path: maintenance_dir.join(MAINTENANCE_DB_FILE_NAME),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    // -------------------------------------------------------------------------------------
    // Open helpers: `for_write` creates, `for_read` never does.
    // -------------------------------------------------------------------------------------

    fn for_write(&self) -> rusqlite::Result<Connection> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CANTOPEN),
                    Some(format!("create {}: {}", parent.display(), e)),
                )
            })?;
        }
        let conn = Connection::open(&self.path)?;
        conn.busy_timeout(std::time::Duration::from_millis(BUSY_TIMEOUT_MS))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS settings (
                 key TEXT PRIMARY KEY,
                 value TEXT NOT NULL,
                 updated_at_ms INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS maintenance_runs (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 repo_id TEXT NOT NULL,
                 mode TEXT NOT NULL,
                 reason TEXT NOT NULL,
                 state TEXT NOT NULL,
                 started_at_ms INTEGER NOT NULL,
                 duration_ms INTEGER NOT NULL,
                 loose_before INTEGER NOT NULL,
                 loose_after INTEGER NOT NULL,
                 packs_before INTEGER NOT NULL,
                 packs_after INTEGER NOT NULL,
                 pack_bytes_before INTEGER NOT NULL,
                 pack_bytes_after INTEGER NOT NULL,
                 largest_pack_bytes_before INTEGER NOT NULL,
                 largest_pack_bytes_after INTEGER NOT NULL,
                 commands TEXT NOT NULL,
                 exit_code INTEGER,
                 stderr TEXT NOT NULL,
                 fsck_clean INTEGER
             );
             CREATE INDEX IF NOT EXISTS maintenance_runs_repo_started
                 ON maintenance_runs (repo_id, started_at_ms DESC);
             CREATE INDEX IF NOT EXISTS maintenance_runs_started
                 ON maintenance_runs (started_at_ms DESC);
             CREATE TABLE IF NOT EXISTS ticks (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 started_at_ms INTEGER NOT NULL,
                 duration_ms INTEGER NOT NULL,
                 scan_ms INTEGER NOT NULL,
                 repos_scanned INTEGER NOT NULL,
                 repos_unreadable INTEGER NOT NULL,
                 due_quick INTEGER NOT NULL,
                 due_full INTEGER NOT NULL,
                 ran INTEGER NOT NULL,
                 aborted INTEGER NOT NULL
             );",
        )?;
        Ok(conn)
    }

    /// `None` when the file does not exist (the common "fresh" case — no log). A file that
    /// exists but cannot be opened logs at warn and also yields `None`: readers fall back to
    /// defaults rather than fail.
    fn for_read(&self) -> Option<Connection> {
        if !self.path.exists() {
            return None;
        }
        let conn = Connection::open_with_flags(
            &self.path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        );
        match conn {
            Ok(conn) => {
                let _ = conn.busy_timeout(std::time::Duration::from_millis(BUSY_TIMEOUT_MS));
                Some(conn)
            }
            Err(e) => {
                tracing::warn!(
                    "[GC] maintenance db {} exists but cannot be opened ({}); using defaults",
                    self.path.display(),
                    e
                );
                None
            }
        }
    }

    /// Run a read; any SQL error (e.g. a table missing in an older file) → the default.
    fn read_or_default<T>(
        &self,
        default: T,
        f: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> T {
        let Some(conn) = self.for_read() else {
            return default;
        };
        match f(&conn) {
            Ok(value) => value,
            Err(e) => {
                tracing::warn!(
                    "[GC] maintenance db {} read failed ({}); using defaults",
                    self.path.display(),
                    e
                );
                default
            }
        }
    }

    // -------------------------------------------------------------------------------------
    // Settings
    // -------------------------------------------------------------------------------------

    /// `(enabled, updated_at_ms)`; `(false, None)` when there is no DB or no row.
    pub fn read_enabled(&self) -> (bool, Option<i64>) {
        self.read_or_default((false, None), |conn| {
            conn.query_row(
                "SELECT value, updated_at_ms FROM settings WHERE key = ?1",
                params![SETTING_ENABLED],
                |row| {
                    let value: String = row.get(0)?;
                    let updated: i64 = row.get(1)?;
                    Ok((value == "1", Some(updated)))
                },
            )
            .optional()
            .map(|row| row.unwrap_or((false, None)))
        })
    }

    /// Every `settings` row (there is one key today: `enabled`).
    pub fn list_settings(&self) -> Vec<SettingRow> {
        self.read_or_default(Vec::new(), |conn| {
            let mut stmt =
                conn.prepare("SELECT key, value, updated_at_ms FROM settings ORDER BY key")?;
            let rows = stmt.query_map([], |row| {
                Ok(SettingRow {
                    key: row.get(0)?,
                    value: row.get(1)?,
                    updated_at_ms: row.get(2)?,
                })
            })?;
            rows.collect()
        })
    }

    pub fn write_enabled(&self, enabled: bool, now_ms: i64) -> rusqlite::Result<()> {
        let conn = self.for_write()?;
        conn.execute(
            "INSERT INTO settings (key, value, updated_at_ms) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms",
            params![SETTING_ENABLED, if enabled { "1" } else { "0" }, now_ms],
        )?;
        Ok(())
    }

    // -------------------------------------------------------------------------------------
    // Runs (the journal)
    // -------------------------------------------------------------------------------------

    pub fn record_run(&self, repo_id: &str, outcome: &StepOutcome) -> rusqlite::Result<i64> {
        let conn = self.for_write()?;
        conn.execute(
            "INSERT INTO maintenance_runs (
                 repo_id, mode, reason, state, started_at_ms, duration_ms,
                 loose_before, loose_after, packs_before, packs_after,
                 pack_bytes_before, pack_bytes_after,
                 largest_pack_bytes_before, largest_pack_bytes_after,
                 commands, exit_code, stderr, fsck_clean
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
            params![
                repo_id,
                outcome.mode.to_string(),
                outcome.reason,
                outcome.state,
                outcome.started_at_ms,
                outcome.duration_ms as i64,
                outcome.before.loose as i64,
                outcome.after.loose as i64,
                outcome.before.packs as i64,
                outcome.after.packs as i64,
                outcome.before.pack_bytes as i64,
                outcome.after.pack_bytes as i64,
                outcome.before.largest_pack_bytes as i64,
                outcome.after.largest_pack_bytes as i64,
                outcome.commands.join("\n"),
                outcome.exit_code,
                outcome.stderr,
                outcome.fsck_clean.map(|b| b as i64),
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Most recent run for one repo, if any (test helper; production reads use `recent_runs`).
    #[cfg(test)]
    pub fn last_run(&self, repo_id: &str) -> Option<MaintenanceRunRow> {
        self.read_or_default(None, |conn| {
            let mut stmt = conn.prepare(&format!(
                "{} WHERE repo_id = ?1 ORDER BY started_at_ms DESC, id DESC LIMIT 1",
                SELECT_RUN
            ))?;
            stmt.query_row(params![repo_id], row_to_run).optional()
        })
    }

    /// Recent runs, newest first; optionally for one repo.
    pub fn recent_runs(&self, repo_id: Option<&str>, limit: usize) -> Vec<MaintenanceRunRow> {
        self.read_or_default(Vec::new(), |conn| {
            let limit = limit.clamp(1, 1000) as i64;
            let mut rows = Vec::new();
            match repo_id {
                Some(repo_id) => {
                    let mut stmt = conn.prepare(&format!(
                        "{} WHERE repo_id = ?1 ORDER BY started_at_ms DESC, id DESC LIMIT ?2",
                        SELECT_RUN
                    ))?;
                    for row in stmt.query_map(params![repo_id, limit], row_to_run)? {
                        rows.push(row?);
                    }
                }
                None => {
                    let mut stmt = conn.prepare(&format!(
                        "{} ORDER BY started_at_ms DESC, id DESC LIMIT ?1",
                        SELECT_RUN
                    ))?;
                    for row in stmt.query_map(params![limit], row_to_run)? {
                        rows.push(row?);
                    }
                }
            }
            Ok(rows)
        })
    }

    // -------------------------------------------------------------------------------------
    // Ticks + housekeeping
    // -------------------------------------------------------------------------------------

    pub fn record_tick(&self, summary: &TickSummary) -> rusqlite::Result<()> {
        let conn = self.for_write()?;
        conn.execute(
            "INSERT INTO ticks (started_at_ms, duration_ms, scan_ms, repos_scanned, repos_unreadable,
                                due_quick, due_full, ran, aborted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                summary.started_at_ms,
                summary.duration_ms as i64,
                summary.scan_ms as i64,
                summary.repos_scanned as i64,
                summary.repos_unreadable as i64,
                summary.due_quick as i64,
                summary.due_full as i64,
                summary.ran.len() as i64,
                summary.aborted as i64,
            ],
        )?;
        Ok(())
    }

    /// Recent ticks, newest first.
    pub fn recent_ticks(&self, limit: usize) -> Vec<TickRow> {
        self.read_or_default(Vec::new(), |conn| {
            let mut stmt = conn.prepare(
                "SELECT id, started_at_ms, duration_ms, scan_ms, repos_scanned, repos_unreadable,
                        due_quick, due_full, ran, aborted
                 FROM ticks ORDER BY started_at_ms DESC, id DESC LIMIT ?1",
            )?;
            let rows = stmt.query_map(params![limit.clamp(1, 1000) as i64], |row| {
                Ok(TickRow {
                    id: row.get(0)?,
                    started_at_ms: row.get(1)?,
                    duration_ms: row.get(2)?,
                    scan_ms: row.get(3)?,
                    repos_scanned: row.get(4)?,
                    repos_unreadable: row.get(5)?,
                    due_quick: row.get(6)?,
                    due_full: row.get(7)?,
                    ran: row.get(8)?,
                    aborted: row.get::<_, i64>(9)? != 0,
                })
            })?;
            rows.collect()
        })
    }

    /// Drop journal rows older than the retention, and — only when `existing_repo_ids` is
    /// `Some` (a COMPLETE scan) — runs for repos that no longer exist. `None` after an
    /// incomplete scan, so an unreadable directory can never make its repos' history vanish.
    /// Returns `(runs_deleted, ticks_deleted)`.
    pub fn prune(
        &self,
        now_ms: i64,
        retention_ms: i64,
        existing_repo_ids: Option<&[String]>,
    ) -> rusqlite::Result<(usize, usize)> {
        if !self.path.exists() {
            return Ok((0, 0));
        }
        let mut conn = self.for_write()?;
        let cutoff = now_ms - retention_ms;
        let tx = conn.transaction()?;
        let mut runs = tx.execute(
            "DELETE FROM maintenance_runs WHERE started_at_ms < ?1",
            params![cutoff],
        )?;
        let ticks = tx.execute(
            "DELETE FROM ticks WHERE started_at_ms < ?1",
            params![cutoff],
        )?;
        // Rows for repos that vanished (deleted / moved / renamed on disk) — complete scans only.
        if let Some(existing_repo_ids) = existing_repo_ids {
            tx.execute(
                "CREATE TEMP TABLE IF NOT EXISTS existing_repos (repo_id TEXT PRIMARY KEY)",
                [],
            )?;
            tx.execute("DELETE FROM existing_repos", [])?;
            {
                let mut insert =
                    tx.prepare("INSERT OR IGNORE INTO existing_repos (repo_id) VALUES (?1)")?;
                for id in existing_repo_ids {
                    insert.execute(params![id])?;
                }
            }
            runs += tx.execute(
                "DELETE FROM maintenance_runs WHERE repo_id NOT IN (SELECT repo_id FROM existing_repos)",
                [],
            )?;
        }
        tx.commit()?;
        Ok((runs, ticks))
    }
}

const SELECT_RUN: &str = "SELECT id, repo_id, mode, reason, state, started_at_ms, duration_ms,
    loose_before, loose_after, packs_before, packs_after, pack_bytes_before, pack_bytes_after,
    largest_pack_bytes_before, largest_pack_bytes_after, commands, exit_code, stderr, fsck_clean
    FROM maintenance_runs";

fn row_to_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<MaintenanceRunRow> {
    let mode: String = row.get(2)?;
    let commands: String = row.get(15)?;
    let fsck: Option<i64> = row.get(18)?;
    Ok(MaintenanceRunRow {
        id: row.get(0)?,
        repo_id: row.get(1)?,
        outcome: StepOutcome {
            mode: if mode == "full" {
                StepMode::Full
            } else {
                StepMode::Quick
            },
            reason: row.get(3)?,
            state: row.get(4)?,
            started_at_ms: row.get(5)?,
            duration_ms: row.get::<_, i64>(6)? as u128,
            before: ObjectCounts {
                loose_bytes: 0,
                loose: row.get::<_, i64>(7)? as u64,
                packs: row.get::<_, i64>(9)? as u64,
                pack_bytes: row.get::<_, i64>(11)? as u64,
                largest_pack_bytes: row.get::<_, i64>(13)? as u64,
            },
            after: ObjectCounts {
                loose_bytes: 0,
                loose: row.get::<_, i64>(8)? as u64,
                packs: row.get::<_, i64>(10)? as u64,
                pack_bytes: row.get::<_, i64>(12)? as u64,
                largest_pack_bytes: row.get::<_, i64>(14)? as u64,
            },
            commands: if commands.is_empty() {
                Vec::new()
            } else {
                commands.split('\n').map(str::to_string).collect()
            },
            exit_code: row.get(16)?,
            stderr: row.get(17)?,
            fsck_clean: fsck.map(|v| v != 0),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outcome(mode: StepMode, state: &str, started_at_ms: i64) -> StepOutcome {
        StepOutcome {
            mode,
            state: state.to_string(),
            reason: "test".to_string(),
            started_at_ms,
            duration_ms: 42,
            before: ObjectCounts {
                loose_bytes: 0,
                loose: 10,
                packs: 2,
                pack_bytes: 300,
                largest_pack_bytes: 200,
            },
            after: ObjectCounts {
                loose_bytes: 0,
                loose: 0,
                packs: 1,
                pack_bytes: 280,
                largest_pack_bytes: 280,
            },
            commands: vec!["a".to_string(), "b c".to_string()],
            exit_code: Some(0),
            stderr: String::new(),
            fsck_clean: Some(true),
        }
    }

    #[test]
    fn reads_never_create_the_file_and_return_defaults() {
        let tmp = tempfile::tempdir().unwrap();
        let db = MaintenanceDb::at(&tmp.path().join("maintenance"));
        assert_eq!(db.read_enabled(), (false, None));
        assert!(db.last_run("r").is_none());
        assert!(db.recent_runs(None, 10).is_empty());
        assert_eq!(db.prune(0, 0, Some(&[])).unwrap(), (0, 0));
        assert!(!db.path().exists(), "reads must not create the db");
        assert!(!tmp.path().join("maintenance").exists());
    }

    #[test]
    fn writes_create_the_file_and_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let db = MaintenanceDb::at(&tmp.path().join("maintenance"));
        db.write_enabled(true, 1_000).unwrap();
        assert!(db.path().exists());
        assert_eq!(db.read_enabled(), (true, Some(1_000)));
        db.write_enabled(false, 2_000).unwrap();
        assert_eq!(db.read_enabled(), (false, Some(2_000)));

        let id = db
            .record_run("org/wkb/coa", &outcome(StepMode::Quick, "completed", 5_000))
            .unwrap();
        let id2 = db
            .record_run(
                "org/wkb/coa",
                &outcome(StepMode::Full, "fsck_failed", 6_000),
            )
            .unwrap();
        assert!(id2 > id);
        let last = db.last_run("org/wkb/coa").unwrap();
        assert_eq!(last.id, id2);
        assert_eq!(last.outcome, outcome(StepMode::Full, "fsck_failed", 6_000));
        assert_eq!(db.recent_runs(None, 10).len(), 2);
        assert_eq!(db.recent_runs(Some("other"), 10).len(), 0);
        assert_eq!(db.recent_runs(Some("org/wkb/coa"), 1)[0].id, id2);
    }

    #[test]
    fn deleting_the_file_is_survivable() {
        let tmp = tempfile::tempdir().unwrap();
        let db = MaintenanceDb::at(&tmp.path().join("maintenance"));
        db.write_enabled(true, 1).unwrap();
        db.record_run("r", &outcome(StepMode::Quick, "completed", 1))
            .unwrap();
        std::fs::remove_file(db.path()).unwrap();
        // Reads: defaults. Writes: a fresh file.
        assert_eq!(db.read_enabled(), (false, None));
        assert!(db.last_run("r").is_none());
        db.record_run("r", &outcome(StepMode::Quick, "completed", 2))
            .unwrap();
        assert_eq!(db.recent_runs(None, 10).len(), 1);
    }

    #[test]
    fn corrupt_file_reads_as_defaults_and_is_reported_not_fatal() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("maintenance");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(MAINTENANCE_DB_FILE_NAME),
            b"this is not a database",
        )
        .unwrap();
        let db = MaintenanceDb::at(&dir);
        assert_eq!(db.read_enabled(), (false, None));
        assert!(db.recent_runs(None, 5).is_empty());
    }

    #[test]
    fn settings_and_ticks_are_listable() {
        let tmp = tempfile::tempdir().unwrap();
        let db = MaintenanceDb::at(&tmp.path().join("maintenance"));
        assert!(db.list_settings().is_empty());
        assert!(db.recent_ticks(10).is_empty());
        db.write_enabled(true, 7).unwrap();
        assert_eq!(
            db.list_settings(),
            vec![SettingRow {
                key: "enabled".to_string(),
                value: "1".to_string(),
                updated_at_ms: 7
            }]
        );
        db.record_tick(&TickSummary {
            started_at_ms: 100,
            repos_scanned: 3,
            due_full: 1,
            ..Default::default()
        })
        .unwrap();
        db.record_tick(&TickSummary {
            started_at_ms: 200,
            aborted: true,
            ..Default::default()
        })
        .unwrap();
        let ticks = db.recent_ticks(10);
        assert_eq!(ticks.len(), 2);
        assert_eq!(ticks[0].started_at_ms, 200);
        assert!(ticks[0].aborted);
        assert_eq!(ticks[1].repos_scanned, 3);
        assert_eq!(ticks[1].due_full, 1);
    }

    #[test]
    fn prune_drops_old_rows_and_vanished_repos() {
        let tmp = tempfile::tempdir().unwrap();
        let db = MaintenanceDb::at(&tmp.path().join("maintenance"));
        db.record_run("keep", &outcome(StepMode::Quick, "completed", 900))
            .unwrap();
        db.record_run("keep", &outcome(StepMode::Quick, "completed", 100))
            .unwrap(); // old
        db.record_run("gone", &outcome(StepMode::Quick, "completed", 900))
            .unwrap();
        db.record_tick(&TickSummary {
            started_at_ms: 100,
            ..Default::default()
        })
        .unwrap();
        db.record_tick(&TickSummary {
            started_at_ms: 900,
            ..Default::default()
        })
        .unwrap();
        // Incomplete scan (None): only age pruning — "gone" keeps its fresh row.
        let (runs, ticks) = db.prune(1_000, 500, None).unwrap();
        assert_eq!((runs, ticks), (1, 1));
        assert_eq!(db.recent_runs(Some("gone"), 10).len(), 1);
        // Complete scan: vanished-repo rows go too.
        let (runs, ticks) = db.prune(1_000, 500, Some(&["keep".to_string()])).unwrap();
        assert_eq!((runs, ticks), (1, 0));
        let remaining = db.recent_runs(None, 10);
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].repo_id, "keep");
        assert_eq!(remaining[0].outcome.started_at_ms, 900);
    }
}
