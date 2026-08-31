//! Background repo maintenance — the scratch-git side of DEV-11316 (phase 2).
//!
//! A 60 s tick that, **when enabled**, scans every repo under `repos_dir` (a handful of
//! `stat`s per repo, no git process), decides per repo whether it needs a *quick* step
//! (pack loose objects + geometric roll-up: deletes nothing, safe next to live writers) or a
//! *full* step (`git gc --prune=<grace>`: one pack, garbage older than the grace reclaimed), and
//! runs the due steps one repo at a time. Nothing waits on it: jobs keep calling `POST /gc` as
//! before, and that handler short-circuits to `skipped` while maintenance is on, so exactly one
//! place knows the switch.
//!
//! **The switch** is in memory: read once at boot from `<root>/maintenance/maintenance.sqlite`
//! (missing DB or row ⇒ **off**) and changed through `PUT /api/maintenance/config` (the server's
//! admin dev tool), which writes the DB first. Never by env — coworkers' local stacks stay off
//! until the default is deliberately changed.
//!
//! **Per-repo state is derived from files git already writes**, never stored: last full =
//! mtime of `objects/info/commit-graph` (only `git gc` writes it), last quick = newest
//! `objects/pack/*.pack` mtime, "written since" = ref-directory mtimes, loose / pack counts from
//! `objects/`. The SQLite DB is a throw-away cache + journal (outcomes, ticks, the switch): delete
//! it and the next tick does exactly the same work. A restart loses nothing and a killed step is
//! simply redone — every git step writes to a temp file and renames at the end.
//!
//! **Why no `git maintenance run` / `gc --auto`:** on git 2.39 (the prod image) the
//! `loose-objects` batch size is fixed and a stale `objects/maintenance.lock` makes
//! `maintenance run` exit 0 having done nothing. Every step here is verified by counting
//! objects before and after, and by the exit status.

use std::fs;
#[cfg(unix)]
use std::os::unix::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::sync::watch;

use crate::service::error::AppError;
use crate::service::gc_marker::GcMarkerGuard;
use crate::service::maintenance_db::{MaintenanceDb, RUN_RETENTION_MS};
use crate::service::routes::manage::gc_prune_expiry;
use crate::service::state::AppState;

/// Advisory lock taken for the duration of a step so the blue/green partner container (which
/// shares the disk) never works on the same repo at the same time.
pub const REPO_STEP_LOCK_FILE: &str = "scratch-git-maintenance.lock";
/// `git pack-objects` / `repack` temp files left behind by a killed step are removed once older
/// than this.
/// Only `pack-objects` / `repack` (ours, or a manual `/gc` — both under the same lock) and
/// `index-pack` (a `git push` being received) write `objects/pack/tmp_*`. A push cannot take a
/// day, so a temp file this old belongs to a process that is gone.
const TMP_PACK_MAX_AGE: Duration = Duration::from_secs(24 * 3600);

const MS_PER_HOUR: i64 = 3_600_000;
const MS_PER_DAY: i64 = 24 * MS_PER_HOUR;

// ---------------------------------------------------------------------------------------------
// Settings + persisted config
// ---------------------------------------------------------------------------------------------

/// Tunables of the sweep. Not persisted (constants for now); tests override them.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceSettings {
    pub tick_interval_secs: u64,
    /// A repo gets at most one quick step per this interval.
    pub quick_min_interval_ms: i64,
    /// A repo gets at most one full step per this interval …
    pub full_min_interval_ms: i64,
    /// … and at least one per this interval (pruning floor), if it was written since the last.
    pub full_max_interval_ms: i64,
    /// Quick step when the repo has at least this many loose objects.
    pub loose_threshold: u64,
    /// Quick (roll-up) — and full — when the repo has more packs than this.
    pub max_packs: u64,
    /// Full when this share of packed bytes sits outside the largest pack.
    pub small_pack_share_threshold: f64,
    pub quick_budget_secs: u64,
    pub full_budget_secs: u64,
    /// Run `git fsck` after every full step and report it (rollout canary).
    pub fsck_after_full: bool,
}

impl Default for MaintenanceSettings {
    fn default() -> Self {
        Self {
            tick_interval_secs: 60,
            quick_min_interval_ms: MS_PER_HOUR,
            full_min_interval_ms: MS_PER_DAY,
            full_max_interval_ms: 7 * MS_PER_DAY,
            loose_threshold: 500,
            max_packs: 10,
            small_pack_share_threshold: 0.15,
            quick_budget_secs: 30 * 60,
            full_budget_secs: 60 * 60,
            fsck_after_full: true,
        }
    }
}

/// The one setting: the switch, as returned by `GET/PUT /api/maintenance/config`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceSwitch {
    pub enabled: bool,
    /// When the switch was last flipped (ms since epoch); `None` when never persisted.
    #[serde(default)]
    pub updated_at_ms: Option<i64>,
}

/// The repo the sweep is working on right now.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CurrentRun {
    pub repo_id: String,
    pub mode: StepMode,
    pub started_at_ms: i64,
}

/// One tick's summary, kept for `GET /api/maintenance/status` and logged.
#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TickSummary {
    pub started_at_ms: i64,
    pub duration_ms: u128,
    pub scan_ms: u128,
    pub repos_scanned: usize,
    pub repos_unreadable: usize,
    pub due_quick: usize,
    pub due_full: usize,
    pub ran: Vec<RepoStepRecord>,
    /// Set when the tick was cut short by shutdown.
    pub aborted: bool,
}

/// Process-wide maintenance state: the switch, the tunables, and what the loop is doing.
pub struct MaintenanceState {
    db: MaintenanceDb,
    enabled: AtomicBool,
    updated_at_ms: Mutex<Option<i64>>,
    pub settings: MaintenanceSettings,
    tick_in_progress: AtomicBool,
    current: Mutex<Option<CurrentRun>>,
    last_tick: Mutex<Option<TickSummary>>,
}

impl MaintenanceState {
    /// Read the switch once from `<maintenance_dir>/maintenance.sqlite`. Missing DB or row ⇒
    /// off. Creates nothing on disk.
    pub fn load(maintenance_dir: &Path) -> Self {
        Self::load_with_settings(maintenance_dir, MaintenanceSettings::default())
    }

    pub fn load_with_settings(maintenance_dir: &Path, settings: MaintenanceSettings) -> Self {
        let db = MaintenanceDb::at(maintenance_dir);
        let (enabled, updated_at_ms) = db.read_enabled();
        tracing::info!(
            "[GC] maintenance switch loaded from {}: enabled={}",
            db.path().display(),
            enabled
        );
        Self {
            db,
            enabled: AtomicBool::new(enabled),
            updated_at_ms: Mutex::new(updated_at_ms),
            settings,
            tick_in_progress: AtomicBool::new(false),
            current: Mutex::new(None),
            last_tick: Mutex::new(None),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    pub fn db(&self) -> &MaintenanceDb {
        &self.db
    }

    /// Re-read the switch from the DB and adopt it if it changed. Called once per tick: both
    /// blue/green containers run permanently and a `PUT /config` only reaches the one behind the
    /// proxy, so the other must converge within a tick — especially for DISABLE. A missing or
    /// unreadable DB reads as off, so deleting the DB also stops running loops within a tick.
    pub fn reload_switch_from_db(&self) {
        let (enabled, updated_at_ms) = self.db.read_enabled();
        let mut guard = self.updated_at_ms.lock().unwrap();
        if enabled != self.is_enabled() || updated_at_ms != *guard {
            tracing::info!(
                "[GC] maintenance switch changed in {}: enabled={} (was {})",
                self.db.path().display(),
                enabled,
                self.is_enabled()
            );
            self.enabled.store(enabled, Ordering::SeqCst);
            *guard = updated_at_ms;
        }
    }

    pub fn config(&self) -> MaintenanceSwitch {
        MaintenanceSwitch {
            enabled: self.is_enabled(),
            updated_at_ms: *self.updated_at_ms.lock().unwrap(),
        }
    }

    /// Flip the switch: the DB row is written first (creating the DB if needed), memory second,
    /// so a failed write never leaves the two disagreeing. Concurrent flips are serialized by
    /// the mutex held across the write.
    ///
    /// Note: the switch is read from the DB only at boot. During a blue/green cutover the
    /// draining container keeps the value it booted with for its last ~60 s.
    pub fn set_enabled(&self, enabled: bool) -> Result<MaintenanceSwitch, AppError> {
        let mut updated_at_ms = self.updated_at_ms.lock().unwrap();
        let now = now_ms();
        self.db.write_enabled(enabled, now).map_err(|e| {
            AppError::internal(format!(
                "Failed to persist maintenance switch to {}: {}",
                self.db.path().display(),
                e
            ))
        })?;
        self.enabled.store(enabled, Ordering::SeqCst);
        *updated_at_ms = Some(now);
        tracing::info!(
            "[GC] maintenance switch set enabled={} (persisted to {})",
            enabled,
            self.db.path().display()
        );
        Ok(MaintenanceSwitch {
            enabled,
            updated_at_ms: Some(now),
        })
    }

    pub fn db_path(&self) -> &Path {
        self.db.path()
    }

    pub fn status(&self) -> MaintenanceStatus {
        MaintenanceStatus {
            enabled: self.is_enabled(),
            db_path: self.db.path().to_string_lossy().to_string(),
            settings: self.settings.clone(),
            tick_in_progress: self.tick_in_progress.load(Ordering::SeqCst),
            current: self.current.lock().unwrap().clone(),
            last_tick: self.last_tick.lock().unwrap().clone(),
        }
    }

    fn set_current(&self, run: Option<CurrentRun>) {
        *self.current.lock().unwrap() = run;
    }

    fn record_tick(&self, summary: TickSummary) {
        *self.last_tick.lock().unwrap() = Some(summary);
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceStatus {
    pub enabled: bool,
    pub db_path: String,
    pub settings: MaintenanceSettings,
    pub tick_in_progress: bool,
    pub current: Option<CurrentRun>,
    pub last_tick: Option<TickSummary>,
}

// ---------------------------------------------------------------------------------------------
// Per-repo state — derived from files git writes
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StepMode {
    Quick,
    Full,
}

impl std::fmt::Display for StepMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StepMode::Quick => write!(f, "quick"),
            StepMode::Full => write!(f, "full"),
        }
    }
}

/// `loose` / `packs` / packed bytes at one instant — recorded before and after a step.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ObjectCounts {
    pub loose: u64,
    /// Total bytes of the loose object files. Not journaled per run (`0` in journal rows).
    #[serde(default)]
    pub loose_bytes: u64,
    pub packs: u64,
    pub pack_bytes: u64,
    pub largest_pack_bytes: u64,
}

impl ObjectCounts {
    /// Share of packed bytes that sit outside the largest pack — 0.0 for a single-pack repo.
    pub fn small_pack_share(&self) -> f64 {
        if self.pack_bytes == 0 {
            0.0
        } else {
            1.0 - (self.largest_pack_bytes as f64 / self.pack_bytes as f64)
        }
    }
}

pub const STATE_FSCK_FAILED: &str = "fsck_failed";
pub const STATE_FSCK_INCONCLUSIVE: &str = "fsck_inconclusive";

/// What one step did — journaled in the maintenance DB and logged.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StepOutcome {
    pub mode: StepMode,
    /// `completed` | `failed` | `timed_out` | `aborted` | `fsck_failed` | `fsck_inconclusive`
    pub state: String,
    pub reason: String,
    pub started_at_ms: i64,
    pub duration_ms: u128,
    pub before: ObjectCounts,
    pub after: ObjectCounts,
    /// The git commands that ran, in order.
    pub commands: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub stderr: String,
    /// Only for full steps with `fsck_after_full`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fsck_clean: Option<bool>,
}

/// When this repo was last maintained — **derived**, never stored:
///
/// - `last_full_at_ms` = mtime of `objects/info/commit-graph` (or the newest file of a split
///   `commit-graphs/` chain). Only `git gc` writes it — verified on git 2.39: `pack-objects`,
///   `prune-packed` and `repack --geometric` never do — so a manual `/gc` or `/repair` counts
///   too, as it should.
/// - `last_quick_at_ms` = newest `objects/pack/*.pack` mtime (every quick and every full
///   creates a pack). A received `git push` creates one as well, which at worst delays the next
///   quick step by an hour.
///
/// `None` = never. A repo restored from a snapshot therefore reads as the snapshot's state, not
/// as whatever a cache remembered.
#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoGcState {
    pub last_quick_at_ms: Option<i64>,
    pub last_full_at_ms: Option<i64>,
}

pub fn derive_repo_gc_state(repo_path: &Path) -> std::io::Result<RepoGcState> {
    let info = repo_path.join("objects/info");
    let mut last_full = mtime_ms(&info.join("commit-graph"));
    for entry in read_dir_entries(&info.join("commit-graphs"))? {
        last_full = last_full.max(mtime_ms(&entry.path()));
    }
    let mut newest_pack = None;
    for entry in read_dir_entries(&repo_path.join("objects/pack"))? {
        if entry.file_name().to_string_lossy().ends_with(".pack") {
            newest_pack = newest_pack.max(mtime_ms(&entry.path()));
        }
    }
    Ok(RepoGcState {
        last_quick_at_ms: newest_pack.max(last_full),
        last_full_at_ms: last_full,
    })
}

/// Take the per-repo cross-instance advisory lock (`flock` on `REPO_STEP_LOCK_FILE`). `Ok(None)`
/// when another process holds it. The lock lives as long as the returned file handle.
pub fn try_lock_repo_for_maintenance(repo_path: &Path) -> std::io::Result<Option<fs::File>> {
    let lock_file = fs::File::create(repo_path.join(REPO_STEP_LOCK_FILE))?;
    match lock_file.try_lock() {
        Ok(()) => Ok(Some(lock_file)),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(std::fs::TryLockError::Error(e)) => Err(e),
    }
}

// ---------------------------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------------------------

/// Everything the decision needs about one repo, read with a few `stat`s and `readdir`s.
#[derive(Clone, Debug)]
pub struct RepoScan {
    pub repo_id: String,
    pub repo_path: PathBuf,
    pub counts: ObjectCounts,
    /// Newest mtime among `refs/heads`, `refs/tags`, `packed-refs` (ms since epoch) — every ref
    /// update renames a lock file into one of those directories, which bumps its mtime.
    pub last_write_at_ms: i64,
    pub state: RepoGcState,
}

/// Enumerate bare repos under `repos_dir`: any directory named `*.git` that has an `objects/`
/// dir, up to four levels deep (`org/wkb/coa.git`). Repo id = relative path without `.git`.
#[derive(Debug, Default)]
pub struct RepoListing {
    pub repos: Vec<(String, PathBuf)>,
    /// Directories the walk could not read (permissions, transient I/O). Surfaced in the tick
    /// summary so a subtree silently receiving no maintenance is visible.
    pub unreadable_dirs: usize,
}

pub fn list_repos(repos_dir: &Path) -> RepoListing {
    let mut listing = RepoListing::default();
    walk_for_repos(repos_dir, repos_dir, 0, &mut listing);
    listing.repos.sort();
    listing
}

fn walk_for_repos(root: &Path, dir: &Path, depth: usize, listing: &mut RepoListing) {
    if depth > 4 {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            tracing::warn!("[GC] cannot read {}: {}", dir.display(), e);
            listing.unreadable_dirs += 1;
            return;
        }
    };
    for entry in entries {
        // A mid-iteration error (EIO, permissions) must count too: the rest of this directory's
        // subtree is invisible to the sweep, and `flatten()` would have hidden that.
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                tracing::warn!("[GC] error while reading {}: {}", dir.display(), e);
                listing.unreadable_dirs += 1;
                continue;
            }
        };
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            listing.unreadable_dirs += 1;
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if let Some(stem) = name.strip_suffix(".git") {
            if path.join("objects").is_dir() {
                let rel = path
                    .parent()
                    .and_then(|p| p.strip_prefix(root).ok())
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default();
                let repo_id = if rel.is_empty() {
                    stem.to_string()
                } else {
                    format!("{}/{}", rel, stem)
                };
                listing.repos.push((repo_id, path));
            }
            continue;
        }
        walk_for_repos(root, &path, depth + 1, listing);
    }
}

fn mtime_ms(path: &Path) -> Option<i64> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as i64)
}

/// Every entry of `dir`, or the first error — a partial listing must never pass for a full one,
/// because a decision made on it (e.g. "this repo is compact") would be wrong silently.
/// A directory that does not exist reads as empty (git removes emptied `objects/xx` dirs).
fn read_dir_entries(dir: &Path) -> std::io::Result<Vec<fs::DirEntry>> {
    match fs::read_dir(dir) {
        Ok(entries) => entries.collect(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

fn is_hex_of_len(name: &str, len: usize) -> bool {
    name.len() == len && name.chars().all(|c| c.is_ascii_hexdigit())
}

/// Count loose objects and packs by walking `objects/`. Exact, not sampled: 256 `readdir`s on
/// mostly-empty dirs is ~ms; on a 200 k-loose repo ~50 ms. `Err` when any part of the walk is
/// unreadable.
pub fn count_objects_on_disk(repo_path: &Path) -> std::io::Result<ObjectCounts> {
    let objects = repo_path.join("objects");
    let mut counts = ObjectCounts::default();
    if !objects.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("{} is not a directory", objects.display()),
        ));
    }
    for entry in read_dir_entries(&objects)? {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_hex_of_len(&name, 2) {
            for file in read_dir_entries(&entry.path())? {
                if is_hex_of_len(&file.file_name().to_string_lossy(), 38) {
                    counts.loose += 1;
                    counts.loose_bytes += file.metadata().map(|m| m.len()).unwrap_or(0);
                }
            }
        }
    }
    for entry in read_dir_entries(&objects.join("pack"))? {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".pack") {
            let bytes = entry.metadata()?.len();
            counts.packs += 1;
            counts.pack_bytes += bytes;
            counts.largest_pack_bytes = counts.largest_pack_bytes.max(bytes);
        }
    }
    Ok(counts)
}

/// The 40-hex ids of every loose object, for `git pack-objects` on stdin. `Err` when any
/// `objects/xx` dir is unreadable — packing a subset and calling it done would be a lie.
fn loose_object_ids(repo_path: &Path) -> std::io::Result<Vec<String>> {
    let objects = repo_path.join("objects");
    let mut ids = Vec::new();
    for entry in read_dir_entries(&objects)? {
        let prefix = entry.file_name().to_string_lossy().to_string();
        if !is_hex_of_len(&prefix, 2) {
            continue;
        }
        for file in read_dir_entries(&entry.path())? {
            let rest = file.file_name().to_string_lossy().to_string();
            if is_hex_of_len(&rest, 38) {
                ids.push(format!("{}{}", prefix, rest));
            }
        }
    }
    Ok(ids)
}

/// Newest mtime of `dir` and every directory below it (bounded depth). A ref update renames a
/// lock file into the ref's *own* directory — `refs/tags/plan/x` bumps `refs/tags/plan`, not
/// `refs/tags` — so the whole `refs/` tree has to be looked at.
fn newest_dir_mtime_ms(dir: &Path, depth: usize) -> std::io::Result<Option<i64>> {
    let mut newest = mtime_ms(dir);
    if depth == 0 {
        return Ok(newest);
    }
    for entry in read_dir_entries(dir)? {
        if entry.file_type()?.is_dir() {
            newest = newest.max(newest_dir_mtime_ms(&entry.path(), depth - 1)?);
        }
    }
    Ok(newest)
}

/// `Err` when the repo cannot be read well enough to decide anything about it; the tick counts
/// it as unreadable instead of treating a partial view as the truth.
pub fn scan_repo(repo_id: &str, repo_path: &Path) -> std::io::Result<RepoScan> {
    let last_write_at_ms = newest_dir_mtime_ms(&repo_path.join("refs"), 6)?
        .max(mtime_ms(&repo_path.join("packed-refs")))
        .unwrap_or(0);
    Ok(RepoScan {
        repo_id: repo_id.to_string(),
        repo_path: repo_path.to_path_buf(),
        counts: count_objects_on_disk(repo_path)?,
        last_write_at_ms,
        state: derive_repo_gc_state(repo_path)?,
    })
}

// ---------------------------------------------------------------------------------------------
// Decide
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Plan {
    Nothing,
    Quick { reason: String },
    Full { reason: String },
}

/// Pure decision, so it can be table-tested. First match wins:
///
/// ```text
/// FULL   if activity since last full (a ref moved, or a quick step ran)
///        and now − last_full ≥ full_min_interval
///        and (small_pack_share ≥ threshold  or  packs > max_packs  or  now − last_full ≥ full_max_interval)
/// QUICK  if now − last_quick ≥ quick_min_interval
///        and (loose ≥ loose_threshold  or  packs > max_packs)
/// ```
///
/// "Last full" for a repo that was never maintained is "never", so the first enable gives every
/// written repo one full step; the loop serializes them.
pub fn decide(scan: &RepoScan, settings: &MaintenanceSettings, now_ms: i64) -> Plan {
    let counts = &scan.counts;
    if counts.loose == 0 && counts.packs == 0 {
        // Nothing to pack or prune; also keeps an unborn repo (no commit-graph ever) from
        // reading as "never maintained" on every tick.
        return Plan::Nothing;
    }
    let last_full = scan.state.last_full_at_ms;
    let last_quick = scan.state.last_quick_at_ms.max(last_full);
    // "Something happened since the last full": a ref moved, or a quick step found loose objects
    // to pack (object-only / failed writes never touch a ref, but the garbage they leave is
    // packed by quick and must eventually be pruned by a full).
    let activity_since_full = last_full.is_none_or(|t| {
        scan.last_write_at_ms > t || scan.state.last_quick_at_ms.is_some_and(|q| q > t)
    });
    // A repo that cannot produce a commit-graph (e.g. no reachable commits) never gets a
    // `last_full`; rate-limit its fulls by the newest pack instead — every full writes a pack,
    // so this bounds it to one per interval instead of one per tick.
    let full_age_ok = match last_full {
        Some(t) => now_ms - t >= settings.full_min_interval_ms,
        None => last_quick.is_none_or(|q| now_ms - q >= settings.full_min_interval_ms),
    };
    if activity_since_full && full_age_ok {
        let share = counts.small_pack_share();
        if share >= settings.small_pack_share_threshold {
            return Plan::Full {
                reason: format!("smallPackShare={:.2}", share),
            };
        }
        if counts.packs > settings.max_packs {
            return Plan::Full {
                reason: format!("packs={}", counts.packs),
            };
        }
        if last_full.is_none_or(|t| now_ms - t >= settings.full_max_interval_ms) {
            return Plan::Full {
                reason: match last_full {
                    None => "neverMaintained".to_string(),
                    Some(t) => format!("lastFullAgeH={}", (now_ms - t) / MS_PER_HOUR),
                },
            };
        }
    }
    let quick_age_ok = last_quick.is_none_or(|t| now_ms - t >= settings.quick_min_interval_ms);
    if quick_age_ok {
        if counts.loose >= settings.loose_threshold {
            return Plan::Quick {
                reason: format!("loose={}", counts.loose),
            };
        }
        if counts.packs > settings.max_packs {
            return Plan::Quick {
                reason: format!("packs={}", counts.packs),
            };
        }
    }
    Plan::Nothing
}

// ---------------------------------------------------------------------------------------------
// Overview (dev tools): every repo as the sweep sees it right now
// ---------------------------------------------------------------------------------------------

/// One repo as `GET /api/maintenance/repos` reports it: the derived state plus what the next
/// tick would do. `error` is set (and the counts zero) for a repo the scan could not read.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoOverviewRow {
    pub repo_id: String,
    /// Filesystem creation (birth) time of the repo directory, ms since epoch; `None` where the
    /// filesystem does not record it. Works on APFS (dev) and ext4 via statx (the VM).
    pub created_at_ms: Option<i64>,
    pub loose: u64,
    pub loose_bytes: u64,
    pub packs: u64,
    pub pack_bytes: u64,
    pub largest_pack_bytes: u64,
    pub small_pack_share: f64,
    pub last_write_at_ms: i64,
    pub last_quick_at_ms: Option<i64>,
    pub last_full_at_ms: Option<i64>,
    /// `quick` | `full` | `nothing`
    pub plan: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn repo_dir_created_at_ms(repo_path: &Path) -> Option<i64> {
    fs::metadata(repo_path)
        .ok()?
        .created()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as i64)
}

/// Scan every repo the way a tick does and report the decision each would get right now.
/// Read-only — no marker, no lock, nothing runs.
pub fn repo_overview(
    repos_dir: &Path,
    settings: &MaintenanceSettings,
    now_ms: i64,
) -> Vec<RepoOverviewRow> {
    list_repos(repos_dir)
        .repos
        .into_iter()
        .map(|(repo_id, path)| match scan_repo(&repo_id, &path) {
            Ok(scan) => {
                let (plan, reason) = match decide(&scan, settings, now_ms) {
                    Plan::Nothing => ("nothing".to_string(), String::new()),
                    Plan::Quick { reason } => ("quick".to_string(), reason),
                    Plan::Full { reason } => ("full".to_string(), reason),
                };
                RepoOverviewRow {
                    repo_id: scan.repo_id,
                    created_at_ms: repo_dir_created_at_ms(&path),
                    loose: scan.counts.loose,
                    loose_bytes: scan.counts.loose_bytes,
                    packs: scan.counts.packs,
                    pack_bytes: scan.counts.pack_bytes,
                    largest_pack_bytes: scan.counts.largest_pack_bytes,
                    small_pack_share: scan.counts.small_pack_share(),
                    last_write_at_ms: scan.last_write_at_ms,
                    last_quick_at_ms: scan.state.last_quick_at_ms,
                    last_full_at_ms: scan.state.last_full_at_ms,
                    plan,
                    reason,
                    error: None,
                }
            }
            Err(e) => RepoOverviewRow {
                repo_id,
                created_at_ms: repo_dir_created_at_ms(&path),
                loose: 0,
                loose_bytes: 0,
                packs: 0,
                pack_bytes: 0,
                largest_pack_bytes: 0,
                small_pack_share: 0.0,
                last_write_at_ms: 0,
                last_quick_at_ms: None,
                last_full_at_ms: None,
                plan: "nothing".to_string(),
                reason: String::new(),
                error: Some(e.to_string()),
            },
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------------------------

#[derive(Debug)]
enum GitStepError {
    Spawn(String),
    NonZeroExit {
        exit_code: Option<i32>,
        stderr: String,
    },
    TimedOut,
    Aborted,
}

struct GitStepOk {
    stderr: String,
}

/// Run one git command in `repo_path` under a wall-clock budget. The child is spawned with
/// `kill_on_drop`, so hitting the budget or the shutdown signal kills it; every command used here
/// writes to a temp file and renames at the end, so a kill leaves the repo unchanged.
async fn run_git_step(
    repo_path: &Path,
    args: &[&str],
    stdin_lines: Option<Vec<String>>,
    budget: Duration,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<GitStepOk, GitStepError> {
    let mut cmd = crate::shared::git_exec::git_command_async();
    cmd.args(args).current_dir(repo_path);
    run_command_step(cmd, stdin_lines, budget, shutdown).await
}

/// The budget/kill mechanics behind [`run_git_step`], over any command (tests use `sleep`).
async fn run_command_step(
    mut cmd: tokio::process::Command,
    stdin_lines: Option<Vec<String>>,
    budget: Duration,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<GitStepOk, GitStepError> {
    cmd.stdin(if stdin_lines.is_some() {
        std::process::Stdio::piped()
    } else {
        std::process::Stdio::null()
    })
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::piped())
    .kill_on_drop(true);
    // Own process group: `git gc` spawns `repack` → `pack-objects`. Killing only the leader on
    // timeout/shutdown would leave those rewriting packs after we released the marker and lock.
    #[cfg(unix)]
    cmd.as_std_mut().process_group(0);
    let mut child = cmd
        .spawn()
        .map_err(|e| GitStepError::Spawn(e.to_string()))?;
    let leader_pid = child.id();
    // Feed stdin from its own task so the write happens *under* the same budget/shutdown select
    // as the wait: a stalled child with a full pipe must not hang us past the budget.
    let stdin_task = match stdin_lines {
        Some(lines) => match child.stdin.take() {
            Some(mut stdin) => Some(tokio::spawn(async move {
                let mut buf = String::with_capacity(lines.len() * 41);
                for line in lines {
                    buf.push_str(&line);
                    buf.push('\n');
                }
                let written = stdin.write_all(buf.as_bytes()).await;
                drop(stdin); // EOF
                written.map_err(|e| e.to_string())
            })),
            None => {
                kill_process_group(leader_pid, &mut child).await;
                return Err(GitStepError::Spawn("stdin not piped".to_string()));
            }
        },
        None => None,
    };
    // Drain stderr concurrently so a chatty child can never block on a full pipe.
    let stderr_task = child.stderr.take().map(|mut pipe| {
        tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf).await;
            buf
        })
    });
    let waited = tokio::select! {
        result = tokio::time::timeout(budget, child.wait()) => Some(result),
        _ = shutdown.changed() => None,
    };
    let status = match waited {
        Some(Ok(Ok(status))) => status,
        Some(Ok(Err(e))) => {
            kill_process_group(leader_pid, &mut child).await;
            if let Some(task) = stdin_task {
                task.abort();
            }
            return Err(GitStepError::Spawn(e.to_string()));
        }
        Some(Err(_elapsed)) => {
            kill_process_group(leader_pid, &mut child).await;
            if let Some(task) = stdin_task {
                task.abort();
            }
            return Err(GitStepError::TimedOut);
        }
        None => {
            kill_process_group(leader_pid, &mut child).await;
            if let Some(task) = stdin_task {
                task.abort();
            }
            return Err(GitStepError::Aborted);
        }
    };
    // The child exited: the feed is finished or moot. A child that exited 0 without taking all
    // its input is not a success we can vouch for.
    if let Some(task) = stdin_task {
        if let Ok(Err(e)) = task.await {
            if status.success() {
                return Err(GitStepError::Spawn(format!("writing stdin: {}", e)));
            }
        }
    }
    let stderr = match stderr_task {
        Some(task) => String::from_utf8_lossy(&task.await.unwrap_or_default())
            .trim()
            .to_string(),
        None => String::new(),
    };
    if !status.success() {
        return Err(GitStepError::NonZeroExit {
            exit_code: status.code(),
            stderr,
        });
    }
    Ok(GitStepOk { stderr })
}

/// How long a git process group gets to clean up after SIGTERM before SIGKILL.
const KILL_GRACE: Duration = Duration::from_secs(5);

/// Stop the child's whole process group (its pgid is the leader's pid, see `process_group(0)`):
/// SIGTERM first — git's lockfile/tempfile machinery removes `packed-refs.lock`, ref locks and
/// `tmp_pack_*` on SIGTERM, but not on SIGKILL — then SIGKILL after [`KILL_GRACE`] for anything
/// still alive; then reap the leader. Uses the `kill` binary so no libc dependency is needed.
async fn kill_process_group(leader_pid: Option<u32>, child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = leader_pid {
        signal_process_group(pid, "-TERM").await;
        if tokio::time::timeout(KILL_GRACE, child.wait())
            .await
            .is_err()
        {
            signal_process_group(pid, "-KILL").await;
        }
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

#[cfg(unix)]
async fn signal_process_group(leader_pid: u32, signal: &str) {
    // `sh -c kill` — the shell BUILTIN kill, so this works on slim images without procps.
    let _ = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(format!("kill {} -{}", signal, leader_pid))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await;
}

/// Remove `objects/pack/tmp_*` files older than [`TMP_PACK_MAX_AGE`] — leftovers of a killed
/// `pack-objects` / `repack`. Git never reads a pack without its `.idx`, so these are inert.
fn remove_stale_tmp_packs(repo_path: &Path) -> usize {
    let mut removed = 0;
    let Ok(entries) = fs::read_dir(repo_path.join("objects/pack")) else {
        return 0;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("tmp_") {
            continue;
        }
        let old_enough = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .map(|age| age >= TMP_PACK_MAX_AGE)
            .unwrap_or(false);
        if old_enough && fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// A step that could not even read the repo: `failed`, nothing ran.
fn unreadable_outcome(mut outcome: StepOutcome, e: std::io::Error) -> StepOutcome {
    outcome.state = "failed".to_string();
    outcome.stderr = format!("repo unreadable: {}", e);
    outcome.after = outcome.before;
    outcome
}

fn finish_outcome(
    mut outcome: StepOutcome,
    result: Result<GitStepOk, GitStepError>,
    started: std::time::Instant,
    repo_path: &Path,
) -> StepOutcome {
    outcome.duration_ms = started.elapsed().as_millis();
    outcome.after = match count_objects_on_disk(repo_path) {
        Ok(counts) => counts,
        Err(e) => {
            outcome.state = "failed".to_string();
            outcome.stderr = format!("repo unreadable after the step: {}", e);
            return outcome;
        }
    };
    match result {
        Ok(ok) => {
            outcome.state = "completed".to_string();
            outcome.stderr = ok.stderr;
            outcome.exit_code = Some(0);
        }
        Err(GitStepError::NonZeroExit { exit_code, stderr }) => {
            outcome.state = "failed".to_string();
            outcome.exit_code = exit_code;
            outcome.stderr = stderr;
        }
        Err(GitStepError::Spawn(msg)) => {
            outcome.state = "failed".to_string();
            outcome.stderr = msg;
        }
        Err(GitStepError::TimedOut) => outcome.state = "timed_out".to_string(),
        Err(GitStepError::Aborted) => outcome.state = "aborted".to_string(),
    }
    outcome
}

/// Quick step: pack every loose object (`pack-objects` fed the ids, then `prune-packed`), then
/// a geometric roll-up so the pack count stays logarithmic. Deletes no object.
pub async fn run_quick_step(
    repo_path: &Path,
    reason: &str,
    settings: &MaintenanceSettings,
    shutdown: &mut watch::Receiver<bool>,
) -> StepOutcome {
    let started = std::time::Instant::now();
    let budget = Duration::from_secs(settings.quick_budget_secs);
    let mut outcome = StepOutcome {
        mode: StepMode::Quick,
        state: String::new(),
        reason: reason.to_string(),
        started_at_ms: now_ms(),
        duration_ms: 0,
        before: ObjectCounts::default(),
        after: ObjectCounts::default(),
        commands: Vec::new(),
        exit_code: None,
        stderr: String::new(),
        fsck_clean: None,
    };
    outcome.before = match count_objects_on_disk(repo_path) {
        Ok(counts) => counts,
        Err(e) => return unreadable_outcome(outcome, e),
    };
    remove_stale_tmp_packs(repo_path);

    let ids = match loose_object_ids(repo_path) {
        Ok(ids) => ids,
        Err(e) => return unreadable_outcome(outcome, e),
    };
    let mut result: Result<GitStepOk, GitStepError> = Ok(GitStepOk {
        stderr: String::new(),
    });
    if !ids.is_empty() {
        outcome.commands.push(format!(
            "pack-objects -q objects/pack/loose- < {} ids",
            ids.len()
        ));
        result = run_git_step(
            repo_path,
            &["pack-objects", "-q", "objects/pack/loose-"],
            Some(ids),
            budget,
            shutdown,
        )
        .await;
        if result.is_ok() {
            outcome.commands.push("prune-packed -q".to_string());
            result = run_git_step(
                repo_path,
                &["prune-packed", "-q"],
                None,
                remaining(budget, started),
                shutdown,
            )
            .await;
        }
    }
    if result.is_ok()
        && count_objects_on_disk(repo_path)
            .map(|c| c.packs)
            .unwrap_or(0)
            > 1
    {
        outcome
            .commands
            .push("repack -d --geometric=2 --write-midx -q".to_string());
        result = run_git_step(
            repo_path,
            &["repack", "-d", "--geometric=2", "--write-midx", "-q"],
            None,
            remaining(budget, started),
            shutdown,
        )
        .await;
    }
    finish_outcome(outcome, result, started, repo_path)
}

/// Full step: `git gc --cruft --prune=<grace>` with bitmaps off, then (optionally) `fsck` as
/// the rollout canary. Safe next to writers by git's own model — the prune grace — which is why
/// it takes no exclusive lock.
///
/// `--cruft`: unreachable-but-young objects land in a *cruft pack* (a normal pack plus a
/// `.mtimes` sidecar with per-object timestamps) instead of being exploded back to loose files.
/// No loose leftovers after a full, and garbage keeps its true "abandoned since" age across
/// repacks, so it is deleted at the next full instead of ping-ponging between quick and full.
/// The geometric roll-up leaves cruft packs alone (verified on git 2.39).
pub async fn run_full_step(
    repo_path: &Path,
    reason: &str,
    settings: &MaintenanceSettings,
    shutdown: &mut watch::Receiver<bool>,
) -> StepOutcome {
    let started = std::time::Instant::now();
    let budget = Duration::from_secs(settings.full_budget_secs);
    let prune_arg = format!("--prune={}", gc_prune_expiry());
    let mut outcome = StepOutcome {
        mode: StepMode::Full,
        state: String::new(),
        reason: reason.to_string(),
        started_at_ms: now_ms(),
        duration_ms: 0,
        before: ObjectCounts::default(),
        after: ObjectCounts::default(),
        commands: vec![format!(
            "-c repack.writeBitmaps=false -c gc.writeCommitGraph=true gc --cruft {}",
            prune_arg
        )],
        exit_code: None,
        stderr: String::new(),
        fsck_clean: None,
    };
    outcome.before = match count_objects_on_disk(repo_path) {
        Ok(counts) => counts,
        Err(e) => return unreadable_outcome(outcome, e),
    };
    remove_stale_tmp_packs(repo_path);
    let result = run_git_step(
        repo_path,
        &[
            "-c",
            "repack.writeBitmaps=false",
            "-c",
            "gc.writeCommitGraph=true",
            "gc",
            "--cruft",
            &prune_arg,
        ],
        None,
        budget,
        shutdown,
    )
    .await;
    let mut outcome = finish_outcome(outcome, result, started, repo_path);
    if outcome.state == "completed" && settings.fsck_after_full {
        // Same budget and shutdown handling as the gc itself: a stuck fsck must not pin the
        // marker and the lock, nor block a deploy.
        outcome
            .commands
            .push("fsck --connectivity-only --no-progress".to_string());
        let fsck = run_git_step(
            repo_path,
            &["fsck", "--connectivity-only", "--no-progress"],
            None,
            remaining(budget, started),
            shutdown,
        )
        .await;
        // The gc itself succeeded whatever fsck says; the state names the canary's verdict so
        // nothing paints an unverified full green: `fsck_failed` (repo needs a look) or
        // `fsck_inconclusive` (fsck could not finish). Both still advance the timestamps —
        // re-running the same gc would not change the answer.
        outcome.fsck_clean = match fsck {
            Ok(_) => Some(true),
            Err(GitStepError::NonZeroExit { stderr, .. }) => {
                outcome.state = STATE_FSCK_FAILED.to_string();
                outcome.stderr = stderr;
                Some(false)
            }
            Err(GitStepError::TimedOut) => {
                outcome.state = STATE_FSCK_INCONCLUSIVE.to_string();
                outcome.stderr = "fsck timed out".to_string();
                None
            }
            Err(GitStepError::Aborted) => {
                outcome.state = "aborted".to_string();
                None
            }
            Err(GitStepError::Spawn(msg)) => {
                outcome.state = STATE_FSCK_INCONCLUSIVE.to_string();
                outcome.stderr = format!("fsck could not run: {}", msg);
                None
            }
        };
        outcome.duration_ms = started.elapsed().as_millis();
    }
    outcome
}

fn remaining(budget: Duration, started: std::time::Instant) -> Duration {
    budget
        .checked_sub(started.elapsed())
        .unwrap_or(Duration::from_millis(1))
}

/// One repo's row in a tick summary.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStepRecord {
    pub repo_id: String,
    pub outcome: StepOutcome,
}

fn log_outcome(repo_id: &str, outcome: &StepOutcome) {
    let line = format!(
        "[GC] repo={} mode={} reason={} state={} loose {}→{} packs {}→{} packBytes {}→{} ms={}{}{}",
        repo_id,
        outcome.mode,
        outcome.reason,
        outcome.state,
        outcome.before.loose,
        outcome.after.loose,
        outcome.before.packs,
        outcome.after.packs,
        outcome.before.pack_bytes,
        outcome.after.pack_bytes,
        outcome.duration_ms,
        match outcome.fsck_clean {
            Some(true) => " fsck=clean",
            Some(false) => " fsck=DIRTY",
            None => "",
        },
        if outcome.stderr.is_empty() {
            String::new()
        } else {
            format!(" stderr={:?}", outcome.stderr)
        }
    );
    if outcome.state == "completed" && outcome.fsck_clean != Some(false) {
        tracing::info!("{}", line);
    } else {
        tracing::error!("{}", line);
    }
}

/// Run one step on one repo: marker (so a manual `/gc` and this never overlap), advisory
/// file lock (so the blue/green partner never does), the step, then the journal.
///
/// `redecide_under_lock`: the tick passes `true` — its scan may be minutes old, so the plan is
/// recomputed on fresh state once the lock is held and dropped if no longer due. A manual run
/// passes `false`: the human decided, the given mode runs regardless of the thresholds.
async fn maintain_repo(
    state: &AppState,
    scan: &RepoScan,
    plan: &Plan,
    redecide_under_lock: bool,
    shutdown: &mut watch::Receiver<bool>,
) -> Option<StepOutcome> {
    // The tick's plan only tells us the mode for the skip logs below; the real decision is
    // taken again on a fresh scan once the lock is held.
    let mode = match plan {
        Plan::Quick { .. } => StepMode::Quick,
        Plan::Full { .. } => StepMode::Full,
        Plan::Nothing => return None,
    };
    let Some(_marker) = GcMarkerGuard::try_acquire(&state.gc_state, &scan.repo_id) else {
        tracing::info!(
            "[GC] repo={} mode={} skipped: gc already in progress on this instance",
            scan.repo_id,
            mode
        );
        return None;
    };
    let _lock_held_for_the_step = match try_lock_repo_for_maintenance(&scan.repo_path) {
        Ok(Some(lock_file)) => lock_file,
        Ok(None) => {
            tracing::info!(
                "[GC] repo={} mode={} skipped: another instance holds {}",
                scan.repo_id,
                mode,
                REPO_STEP_LOCK_FILE
            );
            return None;
        }
        Err(e) => {
            tracing::warn!(
                "[GC] repo={} mode={} skipped: cannot take {}: {}",
                scan.repo_id,
                mode,
                REPO_STEP_LOCK_FILE,
                e
            );
            return None;
        }
    };

    // Re-read the repo now that we hold the cross-instance lock, so the outcome's before-counts
    // are accurate and (for the tick) the decision can be retaken on fresh state.
    let scan: RepoScan = {
        let repo_id = scan.repo_id.clone();
        let repo_path = scan.repo_path.clone();
        match tokio::task::spawn_blocking(move || scan_repo(&repo_id, &repo_path)).await {
            Ok(Ok(fresh)) => fresh,
            Ok(Err(e)) => {
                tracing::warn!(
                    "[GC] repo={} mode={} skipped: unreadable under the lock: {}",
                    scan.repo_id,
                    mode,
                    e
                );
                return None;
            }
            Err(_) => scan.clone(),
        }
    };
    let (mode, reason) = if redecide_under_lock {
        match decide(&scan, &state.maintenance.settings, now_ms()) {
            Plan::Quick { reason } => (StepMode::Quick, reason),
            Plan::Full { reason } => (StepMode::Full, reason),
            Plan::Nothing => {
                tracing::info!(
                    "[GC] repo={} mode={} skipped: no longer due after re-scan under the lock",
                    scan.repo_id,
                    mode
                );
                return None;
            }
        }
    } else {
        let reason = match plan {
            Plan::Quick { reason } | Plan::Full { reason } => reason.clone(),
            Plan::Nothing => unreachable!("checked above"),
        };
        (mode, reason)
    };

    state.maintenance.set_current(Some(CurrentRun {
        repo_id: scan.repo_id.clone(),
        mode,
        started_at_ms: now_ms(),
    }));
    tracing::info!(
        "[GC] repo={} mode={} reason={} start loose={} packs={} packBytes={}",
        scan.repo_id,
        mode,
        reason,
        scan.counts.loose,
        scan.counts.packs,
        scan.counts.pack_bytes
    );
    let outcome = match mode {
        StepMode::Quick => {
            run_quick_step(
                &scan.repo_path,
                &reason,
                &state.maintenance.settings,
                shutdown,
            )
            .await
        }
        StepMode::Full => {
            run_full_step(
                &scan.repo_path,
                &reason,
                &state.maintenance.settings,
                shutdown,
            )
            .await
        }
    };
    state.maintenance.set_current(None);
    log_outcome(&scan.repo_id, &outcome);

    // Journal the outcome (creates the DB if needed). Nothing here feeds the next decision —
    // the timestamps come from the files the step wrote. Note: a step that failed part-way may
    // already have written a pack, which advances the derived `last_quick` and defers the retry
    // by up to one rate-limit interval. Bounded, accepted: delayed recovery, never extra work.
    if let Err(e) = state.maintenance.db().record_run(&scan.repo_id, &outcome) {
        tracing::warn!(
            "[GC] repo={} could not journal the run to {}: {}",
            scan.repo_id,
            state.maintenance.db_path().display(),
            e
        );
    }
    Some(outcome)
}

/// Run one step on one repo **now**, regardless of the due-rules — the dev tool's play buttons.
/// Same marker, lock, budgets, kill semantics and journal as a tick step; the reason is
/// `manual`. Works with the switch off. `Ok(None)` = a GC already holds this repo's marker or
/// lock (here or in the partner container).
pub async fn run_manual_step(
    state: &AppState,
    repo_id: &str,
    mode: StepMode,
) -> Result<Option<StepOutcome>, AppError> {
    if repo_id.is_empty()
        || repo_id.starts_with('/')
        || repo_id.contains("..")
        || repo_id.contains('\\')
    {
        return Err(AppError::bad_request(format!(
            "Invalid repo id: {:?}",
            repo_id
        )));
    }
    let repo_path = state.repo_path(repo_id);
    if !repo_path.exists() {
        return Err(AppError::not_found(format!(
            "Repository not found: {}",
            repo_id
        )));
    }
    let scan = {
        let repo_id = repo_id.to_string();
        let repo_path = repo_path.clone();
        tokio::task::spawn_blocking(move || scan_repo(&repo_id, &repo_path))
            .await
            .map_err(|e| AppError::internal(e.to_string()))?
            .map_err(|e| AppError::internal(format!("Repo unreadable: {}", e)))?
    };
    let plan = match mode {
        StepMode::Quick => Plan::Quick {
            reason: "manual".to_string(),
        },
        StepMode::Full => Plan::Full {
            reason: "manual".to_string(),
        },
    };
    let mut shutdown = crate::service::graceful_shutdown::subscribe();
    Ok(maintain_repo(state, &scan, &plan, false, &mut shutdown).await)
}

// ---------------------------------------------------------------------------------------------
// Tick + loop
// ---------------------------------------------------------------------------------------------

/// One tick: scan every repo (blocking, off the runtime), decide, run due steps serially —
/// full steps after quick ones, each group oldest-written first so a chronically busy repo
/// cannot starve the rest. Returns the summary; also stored on the state for `status`.
pub async fn run_tick(state: &AppState, shutdown: &mut watch::Receiver<bool>) -> TickSummary {
    let tick_started = std::time::Instant::now();
    let mut summary = TickSummary {
        started_at_ms: now_ms(),
        ..Default::default()
    };
    state
        .maintenance
        .tick_in_progress
        .store(true, Ordering::SeqCst);

    let repos_dir = state.repos_dir.clone();
    let (scans, unreadable, existing_repo_ids) = tokio::task::spawn_blocking(move || {
        let listing = list_repos(&repos_dir);
        let mut unreadable = listing.unreadable_dirs;
        let mut scans = Vec::with_capacity(listing.repos.len());
        let mut existing_repo_ids = Vec::with_capacity(listing.repos.len());
        for (id, path) in listing.repos {
            existing_repo_ids.push(id.clone());
            match scan_repo(&id, &path) {
                Ok(scan) => scans.push(scan),
                Err(e) => {
                    unreadable += 1;
                    tracing::warn!("[GC] repo={} unreadable, skipped: {}", id, e);
                }
            }
        }
        (scans, unreadable, existing_repo_ids)
    })
    .await
    .unwrap_or_default();
    summary.scan_ms = tick_started.elapsed().as_millis();
    summary.repos_scanned = scans.len();
    summary.repos_unreadable = unreadable;

    let now = now_ms();
    let mut quick: Vec<(RepoScan, Plan)> = Vec::new();
    let mut full: Vec<(RepoScan, Plan)> = Vec::new();
    for scan in scans {
        match decide(&scan, &state.maintenance.settings, now) {
            Plan::Nothing => {}
            plan @ Plan::Quick { .. } => quick.push((scan, plan)),
            plan @ Plan::Full { .. } => full.push((scan, plan)),
        }
    }
    quick.sort_by_key(|(s, _)| s.last_write_at_ms);
    full.sort_by_key(|(s, _)| s.last_write_at_ms);
    summary.due_quick = quick.len();
    summary.due_full = full.len();
    tracing::info!(
        "[GC] tick repos={} unreadableDirs={} scanMs={} dueQuick={} dueFull={}",
        summary.repos_scanned,
        summary.repos_unreadable,
        summary.scan_ms,
        summary.due_quick,
        summary.due_full
    );

    'steps: for (scan, plan) in quick.into_iter().chain(full) {
        if *shutdown.borrow() || !state.maintenance.is_enabled() {
            summary.aborted = *shutdown.borrow();
            break 'steps;
        }
        if let Some(outcome) = maintain_repo(state, &scan, &plan, true, shutdown).await {
            let aborted = outcome.state == "aborted";
            summary.ran.push(RepoStepRecord {
                repo_id: scan.repo_id.clone(),
                outcome,
            });
            if aborted {
                summary.aborted = true;
                break 'steps;
            }
        }
    }

    summary.duration_ms = tick_started.elapsed().as_millis();
    tracing::info!(
        "[GC] tick done ran={} ms={}{}",
        summary.ran.len(),
        summary.duration_ms,
        if summary.aborted { " aborted=true" } else { "" }
    );
    state
        .maintenance
        .tick_in_progress
        .store(false, Ordering::SeqCst);
    state.maintenance.record_tick(summary.clone());
    // Journal the tick and keep the journal bounded (both create the DB if it is missing; a
    // failure here is logged and changes nothing about maintenance itself).
    let db = state.maintenance.db().clone();
    let summary_for_db = summary.clone();
    let _ = tokio::task::spawn_blocking(move || {
        if let Err(e) = db.record_tick(&summary_for_db) {
            tracing::warn!("[GC] could not journal the tick: {}", e);
        }
        // Vanished-repo pruning only after a COMPLETE scan: an unreadable directory hides its
        // repos from `existing_repo_ids`, and pruning on that view would delete their history.
        let complete_scan_repo_ids =
            (summary_for_db.repos_unreadable == 0).then_some(existing_repo_ids);
        if let Err(e) = db.prune(
            now_ms(),
            RUN_RETENTION_MS,
            complete_scan_repo_ids.as_deref(),
        ) {
            tracing::warn!("[GC] could not prune the maintenance journal: {}", e);
        }
    })
    .await;
    summary
}

/// Spawn the 60 s loop. A tick that is still running when the next interval fires simply
/// makes that interval wait (single task, no overlap). While the switch is off the loop stays
/// alive and does nothing, so flipping it on needs no restart.
pub fn spawn_maintenance_loop(
    state: AppState,
    mut shutdown: watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let period = Duration::from_secs(state.maintenance.settings.tick_interval_secs.max(1));
        let mut interval = tokio::time::interval(period);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut was_enabled = state.maintenance.is_enabled();
        tracing::info!(
            "[GC] maintenance loop started: enabled={} tickSecs={}",
            was_enabled,
            period.as_secs()
        );
        loop {
            tokio::select! {
                _ = interval.tick() => {}
                _ = shutdown.changed() => {
                    tracing::info!("[GC] maintenance loop stopping (shutdown)");
                    return;
                }
            }
            state.maintenance.reload_switch_from_db();
            let enabled = state.maintenance.is_enabled();
            if enabled != was_enabled {
                tracing::info!("[GC] maintenance switch is now enabled={}", enabled);
                was_enabled = enabled;
            }
            if !enabled {
                continue;
            }
            run_tick(&state, &mut shutdown).await;
            if *shutdown.borrow() {
                return;
            }
        }
    })
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::git::repo::GitRepo;
    use crate::service::maintenance_db::MAINTENANCE_DB_FILE_NAME;
    use std::io::Write as _;
    use std::sync::Arc;

    fn unique_repo_id(tag: &str) -> String {
        use std::sync::atomic::AtomicU32;
        static N: AtomicU32 = AtomicU32::new(0);
        format!(
            "org_m/wkb_m/coa_{}_{}",
            tag,
            N.fetch_add(1, Ordering::SeqCst)
        )
    }

    fn fast_settings() -> MaintenanceSettings {
        MaintenanceSettings {
            loose_threshold: 3,
            max_packs: 2,
            fsck_after_full: true,
            ..MaintenanceSettings::default()
        }
    }

    fn make_state(repos_dir: &Path, settings: MaintenanceSettings) -> AppState {
        AppState {
            repos_dir: repos_dir.to_path_buf(),
            index_dir: repos_dir.to_path_buf(),
            staging_dir: repos_dir.to_path_buf(),
            build_version: "test".to_string(),
            gc_state: Arc::new(dashmap::DashMap::new()),
            repo_locks: Arc::new(crate::service::git::lock::RepoLocks::new()),
            maintenance: Arc::new(MaintenanceState::load_with_settings(
                &repos_dir.join("maintenance"),
                settings,
            )),
        }
    }

    /// Git with a fixed identity — CI runners have no global user.name/email, and
    /// `commit-tree` refuses to run without one.
    fn git(repo_path: &Path, args: &[&str]) -> String {
        let out = crate::shared::git_exec::git_command()
            .env("GIT_AUTHOR_NAME", "maintenance-test")
            .env("GIT_AUTHOR_EMAIL", "maintenance-test@example.com")
            .env("GIT_COMMITTER_NAME", "maintenance-test")
            .env("GIT_COMMITTER_EMAIL", "maintenance-test@example.com")
            .args(args)
            .current_dir(repo_path)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// Write `n` distinct loose blobs; returns their ids.
    fn write_loose_blobs(repo_path: &Path, n: usize, tag: &str) -> Vec<String> {
        (0..n)
            .map(|i| {
                let mut cmd = crate::shared::git_exec::git_command();
                cmd.args(["hash-object", "-w", "--stdin"])
                    .current_dir(repo_path)
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped());
                let mut child = cmd.spawn().unwrap();
                child
                    .stdin
                    .take()
                    .unwrap()
                    .write_all(format!("{}-{}\n", tag, i).as_bytes())
                    .unwrap();
                let out = child.wait_with_output().unwrap();
                String::from_utf8_lossy(&out.stdout).trim().to_string()
            })
            .collect()
    }

    /// A commit on `main` pointing at one tracked file, so the repo has reachable history.
    /// (`commit-tree` goes through `git()`, which pins the identity for CI.)
    fn commit_a_file(repo_path: &Path, content: &str) {
        let blob = {
            let mut cmd = crate::shared::git_exec::git_command();
            cmd.args(["hash-object", "-w", "--stdin"])
                .current_dir(repo_path)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped());
            let mut child = cmd.spawn().unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(content.as_bytes())
                .unwrap();
            let out = child.wait_with_output().unwrap();
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        let tree = {
            let mut cmd = crate::shared::git_exec::git_command();
            cmd.args(["mktree"])
                .current_dir(repo_path)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped());
            let mut child = cmd.spawn().unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(format!("100644 blob {}\tf.json\n", blob).as_bytes())
                .unwrap();
            let out = child.wait_with_output().unwrap();
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        let commit = git(repo_path, &["commit-tree", &tree, "-m", "m"]);
        git(repo_path, &["update-ref", "refs/heads/main", &commit]);
    }

    fn init_repo(repos_dir: &Path, tag: &str) -> (String, PathBuf) {
        let id = unique_repo_id(tag);
        GitRepo::init(repos_dir, &id).unwrap();
        (id.clone(), repos_dir.join(format!("{}.git", id)))
    }

    fn shutdown_rx() -> watch::Receiver<bool> {
        let (tx, rx) = watch::channel(false);
        std::mem::forget(tx);
        rx
    }

    fn scan_with(counts: ObjectCounts, last_write: i64, state: RepoGcState) -> RepoScan {
        RepoScan {
            repo_id: "r".into(),
            repo_path: PathBuf::from("/nonexistent"),
            counts,
            last_write_at_ms: last_write,
            state,
        }
    }

    // ---- switch persistence ----

    #[test]
    fn missing_db_means_off_and_creates_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("maintenance");
        let state = MaintenanceState::load(&dir);
        assert!(!state.is_enabled());
        assert_eq!(state.config().updated_at_ms, None);
        assert!(!dir.exists(), "load must not create the dir");
    }

    #[test]
    fn set_enabled_persists_and_survives_restart() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("maintenance");
        let state = MaintenanceState::load(&dir);
        let persisted = state.set_enabled(true).unwrap();
        assert!(persisted.enabled);
        assert!(persisted.updated_at_ms.is_some());
        assert!(dir.join(MAINTENANCE_DB_FILE_NAME).exists());
        assert!(state.is_enabled());

        let reloaded = MaintenanceState::load(&dir);
        assert!(reloaded.is_enabled());
        assert_eq!(reloaded.config().updated_at_ms, persisted.updated_at_ms);

        state.set_enabled(false).unwrap();
        assert!(!MaintenanceState::load(&dir).is_enabled());
    }

    #[test]
    fn deleting_the_db_turns_the_switch_off_at_next_start() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("maintenance");
        let state = MaintenanceState::load(&dir);
        state.set_enabled(true).unwrap();
        fs::remove_file(dir.join(MAINTENANCE_DB_FILE_NAME)).unwrap();
        assert!(
            !MaintenanceState::load(&dir).is_enabled(),
            "missing means off"
        );
        // …and the running instance can still flip it, recreating the DB.
        state.set_enabled(true).unwrap();
        assert!(MaintenanceState::load(&dir).is_enabled());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unreadable_repo_is_counted_not_maintained() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let repos_dir = tmp.path().join("repos");
        fs::create_dir_all(&repos_dir).unwrap();
        let state = make_state(&repos_dir, fast_settings());
        state.maintenance.set_enabled(true).unwrap();
        let (id, path) = init_repo(&repos_dir, "sealed");
        commit_a_file(&path, "x");
        let objects = path.join("objects");
        fs::set_permissions(&objects, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read_dir(&objects).is_ok() {
            // Running as root (CI): chmod 000 does not make anything unreadable — skip.
            fs::set_permissions(&objects, fs::Permissions::from_mode(0o755)).unwrap();
            eprintln!("skipped: euid can read chmod-000 dirs");
            return;
        }
        let scan = scan_repo(&id, &path);
        let mut rx = shutdown_rx();
        let summary = run_tick(&state, &mut rx).await;
        fs::set_permissions(&objects, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(scan.is_err(), "objects/ unreadable ⇒ scan fails");
        assert_eq!(summary.repos_scanned, 0);
        assert_eq!(summary.repos_unreadable, 1);
        assert!(summary.ran.is_empty());
    }

    #[tokio::test]
    async fn large_stdin_feed_completes_without_deadlock() {
        // 300 000 lines ≈ 12 MB, far beyond the pipe buffer: proves stdin is fed concurrently
        // with waiting (and stderr draining), not before it.
        let lines: Vec<String> = (0..300_000).map(|i| format!("{:040x}", i)).collect();
        let mut cmd = tokio::process::Command::new("cat");
        let mut rx = shutdown_rx();
        let result = run_command_step(
            cmd_with_null_stdout(&mut cmd),
            Some(lines),
            Duration::from_secs(60),
            &mut rx,
        )
        .await;
        assert!(result.is_ok(), "{:?}", result.err());
    }

    fn cmd_with_null_stdout(cmd: &mut tokio::process::Command) -> tokio::process::Command {
        let mut owned = tokio::process::Command::new(cmd.as_std().get_program());
        owned.stdout(std::process::Stdio::null());
        owned
    }

    #[test]
    fn unreadable_db_means_off() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("maintenance");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(MAINTENANCE_DB_FILE_NAME), b"not a database").unwrap();
        assert!(!MaintenanceState::load(&dir).is_enabled());
    }

    // ---- scan ----

    #[test]
    fn list_repos_finds_nested_bare_repos_and_ignores_the_rest() {
        let tmp = tempfile::tempdir().unwrap();
        let (id_a, _) = init_repo(tmp.path(), "list");
        let (id_b, _) = init_repo(tmp.path(), "list");
        fs::create_dir_all(tmp.path().join("org_m/wkb_m/not-a-repo.git")).unwrap(); // no objects/
        fs::write(tmp.path().join("org_m/wkb_m/coa_x.db"), b"").unwrap();
        fs::create_dir_all(tmp.path().join(".hidden/x.git/objects")).unwrap();
        let listing = list_repos(tmp.path());
        let found: Vec<String> = listing.repos.into_iter().map(|(id, _)| id).collect();
        assert!(
            found.contains(&id_a) && found.contains(&id_b),
            "{:?}",
            found
        );
        assert_eq!(found.len(), 2, "{:?}", found);
        assert_eq!(listing.unreadable_dirs, 0);
    }

    #[cfg(unix)]
    #[test]
    fn list_repos_counts_unreadable_dirs_instead_of_hiding_them() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let (id_a, _) = init_repo(tmp.path(), "readable");
        let sealed = tmp.path().join("org_sealed");
        fs::create_dir_all(sealed.join("wkb_x/coa_y.git/objects")).unwrap();
        fs::set_permissions(&sealed, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read_dir(&sealed).is_ok() {
            // Running as root (CI): chmod 000 does not make anything unreadable — skip.
            fs::set_permissions(&sealed, fs::Permissions::from_mode(0o755)).unwrap();
            eprintln!("skipped: euid can read chmod-000 dirs");
            return;
        }
        let listing = list_repos(tmp.path());
        fs::set_permissions(&sealed, fs::Permissions::from_mode(0o755)).unwrap();
        let found: Vec<String> = listing.repos.into_iter().map(|(id, _)| id).collect();
        assert_eq!(found, vec![id_a]);
        assert_eq!(listing.unreadable_dirs, 1);
    }

    #[test]
    fn switch_written_by_another_process_is_seen_by_the_next_start() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("maintenance");
        let partner = MaintenanceState::load(&dir);
        partner.set_enabled(true).unwrap();
        let ours = MaintenanceState::load(&dir);
        assert!(ours.is_enabled());
        assert_eq!(ours.config(), partner.config());
    }

    /// Both blue/green containers run permanently; a flip through one must reach the other's
    /// loop within a tick — and deleting the DB must stop a running loop.
    #[test]
    fn switch_flips_and_db_deletion_reach_a_running_instance_via_tick_reload() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("maintenance");
        let ours = MaintenanceState::load(&dir);
        let partner = MaintenanceState::load(&dir);
        partner.set_enabled(true).unwrap();
        ours.reload_switch_from_db();
        assert!(ours.is_enabled());
        partner.set_enabled(false).unwrap();
        ours.reload_switch_from_db();
        assert!(!ours.is_enabled(), "disable must reach the other instance");
        partner.set_enabled(true).unwrap();
        ours.reload_switch_from_db();
        fs::remove_file(dir.join(MAINTENANCE_DB_FILE_NAME)).unwrap();
        ours.reload_switch_from_db();
        assert!(!ours.is_enabled(), "deleted DB reads as off");
    }

    #[tokio::test]
    async fn run_manual_step_rejects_path_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        let state = make_state(tmp.path(), fast_settings());
        for bad in ["../outside", "/abs/path", "a/../../b", ""] {
            let err = run_manual_step(&state, bad, StepMode::Quick)
                .await
                .unwrap_err();
            assert!(
                matches!(err, AppError::BadRequest(_)),
                "{:?} → {:?}",
                bad,
                err
            );
        }
    }

    #[test]
    fn repo_gc_state_is_derived_from_commit_graph_and_packs() {
        let tmp = tempfile::tempdir().unwrap();
        let (_, path) = init_repo(tmp.path(), "derive");
        commit_a_file(&path, "d");
        assert_eq!(derive_repo_gc_state(&path).unwrap(), RepoGcState::default());

        // A quick-style pack: last_quick set, last_full still never.
        git(&path, &["repack", "-d", "-q"]);
        let after_quick = derive_repo_gc_state(&path).unwrap();
        assert!(after_quick.last_quick_at_ms.is_some());
        assert_eq!(after_quick.last_full_at_ms, None);

        // A full gc writes the commit-graph: last_full set, last_quick ≥ it.
        std::thread::sleep(Duration::from_millis(1100));
        git(&path, &["gc", "-q", "--prune=1.hour.ago"]);
        let after_full = derive_repo_gc_state(&path).unwrap();
        let full = after_full
            .last_full_at_ms
            .expect("commit-graph written by gc");
        assert!(full > after_quick.last_quick_at_ms.unwrap());
        assert!(after_full.last_quick_at_ms.unwrap() >= full);
    }

    #[test]
    fn scan_counts_loose_packs_and_last_write() {
        let tmp = tempfile::tempdir().unwrap();
        let (id, path) = init_repo(tmp.path(), "scan");
        let seeded_by_init = count_objects_on_disk(&path).unwrap().loose; // empty tree + initial commit
        write_loose_blobs(&path, 5, "s");
        let scan = scan_repo(&id, &path).unwrap();
        assert_eq!(scan.counts.loose, seeded_by_init + 5);
        assert_eq!(scan.counts.packs, 0);
        assert_eq!(scan.state, RepoGcState::default());
        let before_write = scan.last_write_at_ms;

        std::thread::sleep(Duration::from_millis(1100)); // coarse mtimes on some filesystems
        commit_a_file(&path, "hello");
        let scan = scan_repo(&id, &path).unwrap();
        assert!(
            scan.last_write_at_ms > before_write,
            "ref update must bump last_write ({} → {})",
            before_write,
            scan.last_write_at_ms
        );

        // A nested ref (plan tags live under refs/tags/<group>/…) bumps its own directory only.
        let before_tag = scan.last_write_at_ms;
        std::thread::sleep(Duration::from_millis(1100));
        let head = git(&path, &["rev-parse", "refs/heads/main"]);
        git(&path, &["update-ref", "refs/tags/plan/p1", &head]);
        let scan = scan_repo(&id, &path).unwrap();
        assert!(
            scan.last_write_at_ms > before_tag,
            "nested ref update must bump last_write"
        );

        git(&path, &["repack", "-d", "-q"]);
        let scan = scan_repo(&id, &path).unwrap();
        assert_eq!(scan.counts.packs, 1);
        assert!(scan.counts.pack_bytes > 0);
        assert_eq!(scan.counts.largest_pack_bytes, scan.counts.pack_bytes);
        assert_eq!(scan.counts.small_pack_share(), 0.0);
    }

    // ---- decide ----

    #[test]
    fn decide_table() {
        let s = MaintenanceSettings::default();
        let now = 100 * MS_PER_DAY;
        let compact = ObjectCounts {
            loose: 10,
            loose_bytes: 0,
            packs: 1,
            pack_bytes: 1000,
            largest_pack_bytes: 1000,
        };
        let recently_full = RepoGcState {
            last_quick_at_ms: Some(now - MS_PER_HOUR),
            last_full_at_ms: Some(now - MS_PER_HOUR),
        };

        // Never maintained + written ⇒ full ("neverMaintained").
        assert!(matches!(
            decide(&scan_with(compact, now - 1, RepoGcState::default()), &s, now),
            Plan::Full { ref reason } if reason == "neverMaintained"
        ));
        // Compact, quick and full both recent ⇒ nothing.
        assert_eq!(
            decide(&scan_with(compact, now - 1, recently_full.clone()), &s, now),
            Plan::Nothing
        );
        // Loose over threshold but quick ran 30 min ago ⇒ nothing (rate limit).
        let loose = ObjectCounts {
            loose: 5000,
            loose_bytes: 0,
            ..compact
        };
        let quick_30m = RepoGcState {
            last_quick_at_ms: Some(now - MS_PER_HOUR / 2),
            last_full_at_ms: Some(now - MS_PER_HOUR),
        };
        assert_eq!(
            decide(&scan_with(loose, now - 1, quick_30m), &s, now),
            Plan::Nothing
        );
        // Loose over threshold, quick 2 h ago ⇒ quick.
        let quick_2h = RepoGcState {
            last_quick_at_ms: Some(now - 2 * MS_PER_HOUR),
            last_full_at_ms: Some(now - 2 * MS_PER_HOUR),
        };
        assert!(matches!(
            decide(&scan_with(loose, now - 1, quick_2h.clone()), &s, now),
            Plan::Quick { ref reason } if reason == "loose=5000"
        ));
        // Full 2 days ago but NOT written since ⇒ nothing (and no quick: compact).
        let full_2d = RepoGcState {
            last_quick_at_ms: Some(now - 2 * MS_PER_DAY),
            last_full_at_ms: Some(now - 2 * MS_PER_DAY),
        };
        assert_eq!(
            decide(
                &scan_with(compact, now - 3 * MS_PER_DAY, full_2d.clone()),
                &s,
                now
            ),
            Plan::Nothing
        );
        // Full 2 days ago, written since, but packs are good ⇒ nothing (metric says skip).
        assert_eq!(
            decide(&scan_with(compact, now - 1, full_2d.clone()), &s, now),
            Plan::Nothing
        );
        // Full 2 days ago, written since, 30 % of bytes outside the big pack ⇒ full.
        let fragmented = ObjectCounts {
            loose: 10,
            loose_bytes: 0,
            packs: 3,
            pack_bytes: 1000,
            largest_pack_bytes: 700,
        };
        assert!(matches!(
            decide(&scan_with(fragmented, now - 1, full_2d.clone()), &s, now),
            Plan::Full { ref reason } if reason.starts_with("smallPackShare=0.30")
        ));
        // Full 8 days ago, written since, packs perfect ⇒ full anyway (prune floor).
        let full_8d = RepoGcState {
            last_quick_at_ms: Some(now - 8 * MS_PER_DAY),
            last_full_at_ms: Some(now - 8 * MS_PER_DAY),
        };
        assert!(matches!(
            decide(&scan_with(compact, now - 1, full_8d), &s, now),
            Plan::Full { ref reason } if reason == "lastFullAgeH=192"
        ));
        // Graph-less repo (never a commit-graph, e.g. no reachable commits): fulls are
        // rate-limited by the newest pack instead of firing every tick.
        let graphless_recent_pack = RepoGcState {
            last_quick_at_ms: Some(now - MS_PER_HOUR),
            last_full_at_ms: None,
        };
        let packed_only = ObjectCounts {
            loose: 0,
            loose_bytes: 0,
            packs: 1,
            pack_bytes: 1000,
            largest_pack_bytes: 1000,
        };
        assert_eq!(
            decide(
                &scan_with(packed_only, now - 1, graphless_recent_pack),
                &s,
                now
            ),
            Plan::Nothing,
            "a full just ran (fresh pack, no graph) — do not spam another"
        );
        let graphless_old_pack = RepoGcState {
            last_quick_at_ms: Some(now - 2 * MS_PER_DAY),
            last_full_at_ms: None,
        };
        assert!(matches!(
            decide(
                &scan_with(packed_only, now - 1, graphless_old_pack),
                &s,
                now
            ),
            Plan::Full { .. }
        ));

        // Full 8 days ago, no ref moved since, but a quick ran after it (object-only writes left
        // garbage that quick packed) ⇒ full is due so that garbage is eventually pruned.
        let quick_after_old_full = RepoGcState {
            last_quick_at_ms: Some(now - MS_PER_HOUR),
            last_full_at_ms: Some(now - 8 * MS_PER_DAY),
        };
        assert!(matches!(
            decide(
                &scan_with(compact, now - 9 * MS_PER_DAY, quick_after_old_full),
                &s,
                now
            ),
            Plan::Full { .. }
        ));
        // Too many packs, full 12 h ago ⇒ quick (roll-up), not full.
        let many_packs = ObjectCounts {
            loose: 0,
            loose_bytes: 0,
            packs: 20,
            pack_bytes: 1000,
            largest_pack_bytes: 990,
        };
        let full_12h = RepoGcState {
            last_quick_at_ms: Some(now - 12 * MS_PER_HOUR),
            last_full_at_ms: Some(now - 12 * MS_PER_HOUR),
        };
        assert!(matches!(
            decide(&scan_with(many_packs, now - 1, full_12h), &s, now),
            Plan::Quick { ref reason } if reason == "packs=20"
        ));
    }

    // ---- steps ----

    #[tokio::test]
    async fn quick_step_packs_all_loose_including_unreachable_and_rolls_up() {
        let tmp = tempfile::tempdir().unwrap();
        let (_, path) = init_repo(tmp.path(), "quick");
        commit_a_file(&path, "reachable");
        let unreachable = write_loose_blobs(&path, 4, "garbage");
        git(&path, &["repack", "-d", "-q"]); // one pack holding the commit …
        write_loose_blobs(&path, 3, "more"); // … plus new loose objects on top
        fs::write(path.join("objects/pack/tmp_pack_stale"), b"x").unwrap();
        let stale = path.join("objects/pack/tmp_pack_stale");
        let older_than_a_day = SystemTime::now() - Duration::from_secs(25 * 3600);
        fs::File::open(&stale)
            .unwrap()
            .set_modified(older_than_a_day)
            .unwrap();

        let before = count_objects_on_disk(&path).unwrap();
        assert!(before.loose >= 7 && before.packs == 1, "{:?}", before);

        let mut rx = shutdown_rx();
        let outcome = run_quick_step(&path, "test", &fast_settings(), &mut rx).await;
        assert_eq!(outcome.state, "completed", "{:?}", outcome);
        assert_eq!(outcome.after.loose, 0, "{:?}", outcome);
        assert_eq!(outcome.after.packs, 1, "rolled into one: {:?}", outcome);
        assert!(!stale.exists(), "stale tmp pack removed");
        for oid in unreachable {
            git(&path, &["cat-file", "-e", &oid]); // still there — quick deletes nothing
        }
        assert_eq!(
            outcome.commands,
            vec![
                "pack-objects -q objects/pack/loose- < 7 ids".to_string(),
                "prune-packed -q".to_string(),
                "repack -d --geometric=2 --write-midx -q".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn quick_step_on_compact_repo_runs_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let (_, path) = init_repo(tmp.path(), "noop");
        commit_a_file(&path, "x");
        git(&path, &["repack", "-a", "-d", "-q"]);
        git(&path, &["prune-packed", "-q"]);
        let mut rx = shutdown_rx();
        let outcome = run_quick_step(&path, "test", &fast_settings(), &mut rx).await;
        assert_eq!(outcome.state, "completed");
        assert!(outcome.commands.is_empty(), "{:?}", outcome.commands);
    }

    #[tokio::test]
    async fn full_step_keeps_young_unreachable_objects_and_reports_fsck() {
        let tmp = tempfile::tempdir().unwrap();
        let (_gix_id, path) = init_repo(tmp.path(), "full");
        commit_a_file(&path, "reachable");
        let young_garbage = write_loose_blobs(&path, 2, "young");
        let mut rx = shutdown_rx();
        let outcome = run_full_step(&path, "test", &fast_settings(), &mut rx).await;
        assert_eq!(outcome.state, "completed", "{:?}", outcome);
        assert_eq!(outcome.fsck_clean, Some(true));
        // --cruft: reachable pack + cruft pack, and NO loose leftovers — young garbage sits in
        // the cruft pack with its own recorded age (.mtimes) instead of exploding to loose.
        assert_eq!(outcome.after.packs, 2, "{:?}", outcome);
        assert_eq!(outcome.after.loose, 0, "{:?}", outcome);
        assert_eq!(
            fs::read_dir(path.join("objects/pack"))
                .unwrap()
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().ends_with(".mtimes"))
                .count(),
            1,
            "one cruft pack"
        );
        for oid in young_garbage {
            git(&path, &["cat-file", "-e", &oid]); // younger than the grace ⇒ survives
        }
        assert!(outcome.commands[0].contains("gc --cruft --prune="));
        // gix must read a repo whose objects live in a cruft-pack layout (pack + .mtimes + midx-less).
        let gix_repo = GitRepo::open(tmp.path(), &_gix_id).unwrap();
        assert_eq!(
            gix_repo
                .get_file_content("main", "f.json")
                .unwrap()
                .as_deref(),
            Some("reachable")
        );
    }

    fn sleep_command(secs: &str) -> tokio::process::Command {
        let mut cmd = tokio::process::Command::new("sleep");
        cmd.arg(secs);
        cmd
    }

    #[tokio::test]
    async fn step_budget_kills_the_child() {
        let mut rx = shutdown_rx();
        let started = std::time::Instant::now();
        let result = run_command_step(
            sleep_command("30"),
            None,
            Duration::from_millis(300),
            &mut rx,
        )
        .await;
        assert!(
            matches!(result, Err(GitStepError::TimedOut)),
            "{:?}",
            result.err()
        );
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "the child must be killed at the budget (0.3 s), not waited for (30 s); generous \
             bound for slow CI runners"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn step_budget_kills_the_whole_process_group_not_just_the_leader() {
        let tmp = tempfile::tempdir().unwrap();
        let pid_file = tmp.path().join("grandchild.pid");
        // A leader that spawns a long-lived grandchild and waits — the shape of `git gc`.
        let mut cmd = tokio::process::Command::new("sh");
        cmd.arg("-c")
            .arg(format!("sleep 30 & echo $! > {}; wait", pid_file.display()));
        let mut rx = shutdown_rx();
        let result = run_command_step(cmd, None, Duration::from_millis(500), &mut rx).await;
        assert!(
            matches!(result, Err(GitStepError::TimedOut)),
            "{:?}",
            result.err()
        );
        let grandchild_pid = fs::read_to_string(&pid_file).unwrap().trim().to_string();
        assert!(!grandchild_pid.is_empty());
        // `kill -0` succeeds only while the process exists.
        let mut alive = true;
        for _ in 0..40 {
            alive = std::process::Command::new("kill")
                .args(["-0", &grandchild_pid])
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if !alive {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            !alive,
            "grandchild {} survived the group kill",
            grandchild_pid
        );
    }

    #[tokio::test]
    async fn shutdown_aborts_a_running_step() {
        let (tx, mut rx) = watch::channel(false);
        let handle = tokio::spawn(async move {
            run_command_step(sleep_command("30"), None, Duration::from_secs(60), &mut rx).await
        });
        tokio::time::sleep(Duration::from_millis(200)).await;
        tx.send(true).unwrap();
        let result = handle.await.unwrap();
        assert!(
            matches!(result, Err(GitStepError::Aborted)),
            "{:?}",
            result.err()
        );
    }

    #[tokio::test]
    async fn failing_git_command_reports_exit_code_and_stderr() {
        let tmp = tempfile::tempdir().unwrap();
        let (_, path) = init_repo(tmp.path(), "fail");
        let mut rx = shutdown_rx();
        let result = run_git_step(
            &path,
            &["cat-file", "-e", "0000000000000000000000000000000000000000"],
            None,
            Duration::from_secs(30),
            &mut rx,
        )
        .await;
        match result {
            Err(GitStepError::NonZeroExit { exit_code, .. }) => assert_ne!(exit_code, Some(0)),
            other => panic!("expected NonZeroExit, got {:?}", other.err()),
        }
    }

    // ---- tick ----

    #[tokio::test]
    async fn tick_maintains_only_due_repos_and_records_state_files() {
        let tmp = tempfile::tempdir().unwrap();
        let repos_dir = tmp.path().join("repos");
        fs::create_dir_all(&repos_dir).unwrap();
        let state = make_state(&repos_dir, fast_settings());
        state.maintenance.set_enabled(true).unwrap();

        let (dirty_id, dirty_path) = init_repo(&repos_dir, "dirty");
        commit_a_file(&dirty_path, "d");
        write_loose_blobs(&dirty_path, 6, "d");

        let (clean_id, clean_path) = init_repo(&repos_dir, "clean");
        commit_a_file(&clean_path, "c");
        git(&clean_path, &["repack", "-a", "-d", "-q"]);
        git(&clean_path, &["prune-packed", "-q"]);
        // A real full gc just now (commit-graph + pack) ⇒ nothing is due for the clean repo.
        git(&clean_path, &["gc", "-q", "--prune=1.hour.ago"]);

        let mut rx = shutdown_rx();
        let summary = run_tick(&state, &mut rx).await;
        assert_eq!(summary.repos_scanned, 2);
        // The dirty repo was never maintained ⇒ its first step is a full.
        assert_eq!(summary.due_full, 1, "{:?}", summary);
        assert_eq!(summary.due_quick, 0, "{:?}", summary);
        assert_eq!(summary.ran.len(), 1);
        assert_eq!(summary.ran[0].repo_id, dirty_id);
        assert_eq!(summary.ran[0].outcome.mode, StepMode::Full);
        assert_eq!(summary.ran[0].outcome.state, "completed");

        let dirty_state = derive_repo_gc_state(&dirty_path).unwrap();
        assert!(
            dirty_state.last_full_at_ms.is_some(),
            "gc wrote the commit-graph"
        );
        assert!(dirty_state.last_quick_at_ms.is_some());
        let journaled = state.maintenance.db().last_run(&dirty_id).unwrap();
        assert_eq!(journaled.outcome.mode, StepMode::Full);
        assert_eq!(journaled.outcome.state, "completed");
        assert!(state.maintenance.db().last_run(&clean_id).is_none());
        // reachable pack + cruft pack (the 6 young garbage blobs), 0 loose
        let after = count_objects_on_disk(&dirty_path).unwrap();
        assert_eq!(after.packs, 2);
        assert_eq!(after.loose, 0);

        // Second tick right away: nothing is due any more — and that stays true with the DB
        // thrown away, because the decision never depended on it.
        fs::remove_file(state.maintenance.db_path()).unwrap();
        let summary = run_tick(&state, &mut rx).await;
        assert_eq!(summary.ran.len(), 0, "{:?}", summary);
        assert!(
            state.maintenance.db_path().exists(),
            "the tick journal recreated the db"
        );
        assert!(state.maintenance.status().last_tick.is_some());
        assert!(!state.maintenance.status().tick_in_progress);
        assert!(state.gc_state.is_empty(), "markers released");
    }

    /// The tick's scan is stale by the time the lock is taken: another instance maintained the
    /// repo in between. The fresh decision under the lock must win, and the stale plan must not
    /// overwrite the newer state file.
    #[tokio::test]
    async fn maintain_repo_rescans_under_the_lock_and_drops_a_stale_plan() {
        let tmp = tempfile::tempdir().unwrap();
        let repos_dir = tmp.path().join("repos");
        fs::create_dir_all(&repos_dir).unwrap();
        let state = make_state(&repos_dir, fast_settings());
        let (id, path) = init_repo(&repos_dir, "stale");
        commit_a_file(&path, "s");
        let stale_scan = scan_repo(&id, &path).unwrap(); // never maintained ⇒ Full would be due
        assert!(matches!(
            decide(&stale_scan, &state.maintenance.settings, now_ms()),
            Plan::Full { .. }
        ));
        // Meanwhile "the partner" runs a full on it (commit-graph + pack written).
        git(&path, &["gc", "-q", "--prune=1.hour.ago"]);

        let mut rx = shutdown_rx();
        let plan = Plan::Full {
            reason: "neverMaintained".to_string(),
        };
        let outcome = maintain_repo(&state, &stale_scan, &plan, true, &mut rx).await;
        assert!(outcome.is_none(), "{:?}", outcome);
        assert!(
            state.maintenance.db().last_run(&id).is_none(),
            "no run journaled for a dropped plan"
        );
        assert!(state.gc_state.is_empty(), "marker released");
    }

    #[test]
    fn repo_overview_reports_derived_state_and_the_pending_decision() {
        let tmp = tempfile::tempdir().unwrap();
        let repos_dir = tmp.path().join("repos");
        fs::create_dir_all(&repos_dir).unwrap();
        let (never_id, never_path) = init_repo(&repos_dir, "ov-never");
        commit_a_file(&never_path, "n");
        let (done_id, done_path) = init_repo(&repos_dir, "ov-done");
        commit_a_file(&done_path, "d");
        git(&done_path, &["gc", "-q", "--prune=1.hour.ago"]);
        let rows = repo_overview(&repos_dir, &fast_settings(), now_ms());
        assert_eq!(rows.len(), 2);
        let never = rows.iter().find(|r| r.repo_id == never_id).unwrap();
        assert_eq!(never.plan, "full");
        assert_eq!(never.reason, "neverMaintained");
        assert_eq!(never.last_full_at_ms, None);
        let done = rows.iter().find(|r| r.repo_id == done_id).unwrap();
        assert!(done.created_at_ms.is_some(), "APFS records dir birth time");
        assert_eq!(done.plan, "nothing");
        assert!(done.last_full_at_ms.is_some());
        assert_eq!(done.packs, 1);
        assert!(done.error.is_none());
    }

    /// A manual run forces the step even when the due-rules say nothing, and journals it with
    /// reason `manual`. A held marker makes it a no-op (`None`), not an error.
    #[tokio::test]
    async fn run_manual_step_forces_a_quick_and_respects_the_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let repos_dir = tmp.path().join("repos");
        fs::create_dir_all(&repos_dir).unwrap();
        let state = make_state(&repos_dir, fast_settings());
        let (id, path) = init_repo(&repos_dir, "manual");
        commit_a_file(&path, "m");
        // 2 loose objects — below even the fast_settings threshold of 3, so a tick would skip.
        assert!(matches!(
            decide(
                &scan_repo(&id, &path).unwrap(),
                &state.maintenance.settings,
                now_ms()
            ),
            Plan::Full { .. } // never maintained ⇒ full would be due, but force QUICK instead
        ));
        let outcome = run_manual_step(&state, &id, StepMode::Quick)
            .await
            .unwrap()
            .expect("not blocked");
        assert_eq!(outcome.mode, StepMode::Quick);
        assert_eq!(outcome.state, "completed");
        assert_eq!(outcome.reason, "manual");
        assert_eq!(outcome.after.loose, 0);
        let journaled = state.maintenance.db().last_run(&id).unwrap();
        assert_eq!(journaled.outcome.reason, "manual");

        // Held marker ⇒ None, nothing journaled on top.
        let _held = GcMarkerGuard::try_acquire(&state.gc_state, &id).unwrap();
        let blocked = run_manual_step(&state, &id, StepMode::Full).await.unwrap();
        assert!(blocked.is_none());

        // Missing repo ⇒ 404-shaped error.
        let err = run_manual_step(&state, "org_x/wkb_x/coa_missing", StepMode::Quick)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)), "{:?}", err);
    }

    #[tokio::test]
    async fn tick_skips_a_repo_whose_marker_is_held() {
        let tmp = tempfile::tempdir().unwrap();
        let repos_dir = tmp.path().join("repos");
        fs::create_dir_all(&repos_dir).unwrap();
        let state = make_state(&repos_dir, fast_settings());
        state.maintenance.set_enabled(true).unwrap();
        let (id, path) = init_repo(&repos_dir, "held");
        commit_a_file(&path, "h");
        let _held = GcMarkerGuard::try_acquire(&state.gc_state, &id).unwrap();
        let mut rx = shutdown_rx();
        let summary = run_tick(&state, &mut rx).await;
        assert_eq!(summary.due_full, 1);
        assert!(summary.ran.is_empty());
        assert!(state.maintenance.db().last_run(&id).is_none());
        let _ = path;
    }

    #[tokio::test]
    async fn tick_stops_when_switched_off_mid_run() {
        let tmp = tempfile::tempdir().unwrap();
        let repos_dir = tmp.path().join("repos");
        fs::create_dir_all(&repos_dir).unwrap();
        let state = make_state(&repos_dir, fast_settings());
        // Switch is OFF: run_tick itself does not consult the switch before scanning (the loop
        // does), but it must not run any step once it sees the switch is off.
        let (_, path) = init_repo(&repos_dir, "off");
        commit_a_file(&path, "o");
        let mut rx = shutdown_rx();
        let summary = run_tick(&state, &mut rx).await;
        assert_eq!(summary.due_full, 1);
        assert!(summary.ran.is_empty());
    }
}
