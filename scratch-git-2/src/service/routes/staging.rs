use axum::extract::{Path, Query, State};
use axum::response::Response;
use axum::Json;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::Path as StdPath;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::service::envelope::{envelope, envelope_error};
use crate::service::error::AppError;
use crate::service::git::repo::GitRepo;
use crate::service::state::AppState;
use crate::service::types::*;

// ---------------------------------------------------------------------------
// SQLite staging index
//
// Each pull-all job gets a SQLite database at `{staging_dir}/{jobId}/index.db`
// that tracks every staged file's lifecycle:
//
//   staged → processed (indexed in Postgres) → committed (written to git)
//
// This replaces the previous approach of walking the staging directory tree
// on every paginated read, which was O(n² log n) total for n files and
// caused a production outage on 2026-04-17 by saturating disk I/O.
//
// With SQLite, reads are O(batch) per call and O(n) total. The index also
// enables crash resumability: if the server dies mid-job, unprocessed and
// uncommitted files are picked up on restart.
//
// The database is created lazily on the first `stage_files` call and deleted
// along with the rest of the staging directory by `cleanup_staging`.
// ---------------------------------------------------------------------------

/// Open (or create) the SQLite staging index for a job.
///
/// Uses WAL mode for concurrent read/write during Phase 1, where multiple
/// folders may call `stage_files` in parallel.
fn open_staging_db(staging_job_dir: &StdPath) -> Result<Connection, AppError> {
    let db_path = staging_job_dir.join("index.db");
    let conn = Connection::open(&db_path)
        .map_err(|e| AppError::internal(format!("Failed to open staging index: {}", e)))?;

    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS staged_files (
             path      TEXT NOT NULL,      -- relative to the folder dir (e.g. 'file.json')
             folder    TEXT NOT NULL,      -- staging folder name (e.g. 'Products')
             processed INTEGER NOT NULL DEFAULT 0,  -- 1 = indexed in Postgres
             committed INTEGER NOT NULL DEFAULT 0,  -- 1 = committed to git
             -- PK is (folder, path), NOT path alone: the same filename legitimately
             -- occurs in different folders (e.g. a Contact and a Conversation both
             -- named after 'Ivan Dimitrov' → 'ivan-dimitrov.json'). With a path-only
             -- PK the second folder's INSERT OR IGNORE silently dropped that file,
             -- so a folder pulled concurrently could commit nothing (empty folder).
             PRIMARY KEY (folder, path)
         );
         CREATE INDEX IF NOT EXISTS idx_unprocessed ON staged_files(folder, processed);
         CREATE INDEX IF NOT EXISTS idx_uncommitted ON staged_files(folder, committed);",
    )
    .map_err(|e| AppError::internal(format!("Failed to initialize staging index: {}", e)))?;

    Ok(conn)
}

// ---------------------------------------------------------------------------
// POST /api/staging/{jobId}/files — write a batch of files to staging
//
// Called during Phase 1 (fetch). Writes file content to disk AND records
// each path in the SQLite index so Phase 2 can read them back efficiently.
// The index.db is created lazily on the first call for a given jobId.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct StageFilesBody {
    pub folder: String,
    pub files: Vec<StageFileInput>,
}

#[derive(Deserialize)]
pub struct StageFileInput {
    pub path: String,
    pub content: String,
}

pub async fn stage_files(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
    Json(body): Json<StageFilesBody>,
) -> Response {
    let folder = body.folder;
    let files = body.files;
    let staging_dir = state.staging_job_path(&job_id);
    let folder_dir = staging_dir.join(&folder);

    let result: Result<serde_json::Value, AppError> = tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&folder_dir)
            .map_err(|e| AppError::internal(format!("Failed to create staging dir: {}", e)))?;

        let count = files.len();
        for file in &files {
            let file_path = folder_dir.join(&file.path);
            // Ensure parent dirs exist (for nested paths)
            if let Some(parent) = file_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    AppError::internal(format!("Failed to create parent dir: {}", e))
                })?;
            }
            std::fs::write(&file_path, &file.content)
                .map_err(|e| AppError::internal(format!("Failed to write staged file: {}", e)))?;
        }

        // Record paths in the SQLite index. INSERT OR IGNORE handles duplicate
        // paths from retried batches (e.g. after a crash mid-Phase-1).
        let conn = open_staging_db(&staging_dir)?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| AppError::internal(format!("Failed to begin transaction: {}", e)))?;
        for file in &files {
            tx.execute(
                "INSERT OR IGNORE INTO staged_files (path, folder) VALUES (?1, ?2)",
                params![file.path, folder],
            )
            .map_err(|e| AppError::internal(format!("Failed to index staged file: {}", e)))?;
        }
        tx.commit().map_err(|e| {
            AppError::internal(format!("Failed to commit index transaction: {}", e))
        })?;

        Ok(json!({ "count": count }))
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))
    .and_then(|r| r);

    match result {
        Ok(data) => envelope(&state, None, data),
        Err(err) => envelope_error(&state, None, err),
    }
}

// ---------------------------------------------------------------------------
// GET /api/staging/{jobId}/files?folder=X&limit=100
//
// Called during Phase 2 (process). Returns the next batch of unprocessed
// files from the SQLite index. The caller marks them processed via
// POST /processed after updating Postgres indexes.
//
// Returns `{ files, remaining }` where `remaining` is the count of
// unprocessed files AFTER this batch (so the caller knows when to stop).
//
// Previously this endpoint walked the entire staging directory tree and
// sorted all paths on every call, making it O(n log n) per call and
// O(n² log n) total. With SQLite, each call is O(batch).
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ReadStagedFilesQuery {
    pub folder: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
}

fn default_limit() -> usize {
    100
}

pub async fn read_staged_files(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
    Query(query): Query<ReadStagedFilesQuery>,
) -> Response {
    let staging_dir = state.staging_job_path(&job_id);
    let folder_dir = staging_dir.join(&query.folder);
    let folder = query.folder;
    let limit = query.limit;

    let result: Result<serde_json::Value, AppError> = tokio::task::spawn_blocking(move || {
        let db_path = staging_dir.join("index.db");
        if !db_path.exists() {
            return Ok(json!({ "files": [], "remaining": 0 }));
        }

        let conn = open_staging_db(&staging_dir)?;

        // Query unprocessed files from SQLite index
        let mut stmt = conn
            .prepare("SELECT path FROM staged_files WHERE folder = ?1 AND processed = 0 LIMIT ?2")
            .map_err(|e| AppError::internal(format!("Failed to query staged files: {}", e)))?;

        let paths: Vec<String> = stmt
            .query_map(params![folder, limit as i64], |row| row.get(0))
            .map_err(|e| AppError::internal(format!("Failed to read staged files: {}", e)))?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|e| AppError::internal(format!("Failed to collect staged paths: {}", e)))?;

        // Read content from disk by direct path (O(1) per file)
        let files: Vec<serde_json::Value> = paths
            .iter()
            .map(|rel_path| {
                let full_path = folder_dir.join(rel_path);
                let content = std::fs::read_to_string(&full_path).unwrap_or_default();
                json!({ "path": rel_path, "content": content })
            })
            .collect();

        // Count total remaining unprocessed (including this batch)
        let total_unprocessed: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM staged_files WHERE folder = ?1 AND processed = 0",
                params![folder],
                |row| row.get(0),
            )
            .map_err(|e| AppError::internal(format!("Failed to count remaining: {}", e)))?;

        let remaining = (total_unprocessed as usize).saturating_sub(files.len());

        Ok(json!({ "files": files, "remaining": remaining }))
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))
    .and_then(|r| r);

    match result {
        Ok(data) => envelope(&state, None, data),
        Err(err) => envelope_error(&state, None, err),
    }
}

// ---------------------------------------------------------------------------
// POST /api/staging/{jobId}/processed — mark staged files as processed
//
// Called during Phase 2 after the NestJS server has indexed a batch of files
// in Postgres (file index, file references, asset index). Marking files as
// processed excludes them from future read_staged_files queries.
//
// This is what makes the job resumable: if the server crashes, only
// unprocessed files will be returned on the next read_staged_files call.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct MarkProcessedBody {
    pub folder: String,
    pub paths: Vec<String>,
}

pub async fn mark_staged_files_processed(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
    Json(body): Json<MarkProcessedBody>,
) -> Response {
    let staging_dir = state.staging_job_path(&job_id);
    let folder = body.folder;
    let paths = body.paths;

    let result: Result<serde_json::Value, AppError> = tokio::task::spawn_blocking(move || {
        let conn = open_staging_db(&staging_dir)?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| AppError::internal(format!("Failed to begin transaction: {}", e)))?;

        let mut count = 0usize;
        for path in &paths {
            let updated = tx
                .execute(
                    "UPDATE staged_files SET processed = 1 WHERE folder = ?1 AND path = ?2",
                    params![folder, path],
                )
                .map_err(|e| AppError::internal(format!("Failed to mark file processed: {}", e)))?;
            count += updated;
        }

        tx.commit()
            .map_err(|e| AppError::internal(format!("Failed to commit transaction: {}", e)))?;

        Ok(json!({ "count": count }))
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))
    .and_then(|r| r);

    match result {
        Ok(data) => envelope(&state, None, data),
        Err(err) => envelope_error(&state, None, err),
    }
}

// ---------------------------------------------------------------------------
// POST /api/staging/{jobId}/commit — commit staged folder to git
//
// Called during Phase 2 after all files have been processed (indexed in
// Postgres). Commits up to `batchSize` uncommitted files to git per call.
// The NestJS server calls this in a loop until `committed == 0`.
//
// Each call: query SQLite for uncommitted paths → read content from disk →
// commit to git → mark committed in SQLite → return stats.
//
// Previously committed ALL files in a single call with an internal batch
// loop, but that meant one HTTP request could block for minutes on large
// folders. Now the caller controls the batch size and can checkpoint
// progress between calls.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitStagedBody {
    pub repo_id: String,
    pub branch: Option<String>,
    pub folder: String,
    pub message: Option<String>,
    pub batch_size: Option<usize>,
}

pub async fn commit_staged(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
    Json(body): Json<CommitStagedBody>,
) -> Response {
    let branch = body.branch.unwrap_or_else(|| MAIN_BRANCH.to_string());
    let staging_dir = state.staging_job_path(&job_id);
    let folder_dir = staging_dir.join(&body.folder);
    let repo_id = body.repo_id.clone();
    let message = body
        .message
        .unwrap_or_else(|| format!("Commit staged files for {}", body.folder));
    let batch_size = body.batch_size.unwrap_or(1000);

    let folder_name = body.folder.clone();
    let result = state
        .repo_locks
        .run_write(&repo_id, &branch, {
            let repos_dir = state.repos_dir.clone();
            let repo_id = repo_id.clone();
            let branch = branch.clone();
            move || {
                        let git_repo = GitRepo::open(&repos_dir, &repo_id)?;

                        // No index.db means phase 1 had nothing to stage (e.g. an
                        // empty connector). Return empty success so the caller can
                        // still finalize stale-file deletion and GC without a 404.
                        let db_path = staging_dir.join("index.db");
                        if !db_path.exists() {
                            return Ok(json!({
                                "success": true,
                                "committed": 0,
                                "remaining": 0,
                                "created": [],
                                "updated": [],
                                "unchanged": [],
                            }));
                        }

                        let conn = open_staging_db(&staging_dir)?;

                        // Query uncommitted files from SQLite index
                        let mut stmt = conn
                            .prepare(
                                "SELECT path FROM staged_files WHERE folder = ?1 AND committed = 0 LIMIT ?2",
                            )
                            .map_err(|e| {
                                AppError::internal(format!("Failed to query uncommitted files: {}", e))
                            })?;

                        let paths: Vec<String> = stmt
                            .query_map(params![folder_name, batch_size as i64], |row| row.get(0))
                            .map_err(|e| {
                                AppError::internal(format!("Failed to read uncommitted files: {}", e))
                            })?
                            .collect::<Result<Vec<String>, _>>()
                            .map_err(|e| {
                                AppError::internal(format!("Failed to collect uncommitted paths: {}", e))
                            })?;

                        if paths.is_empty() {
                            return Ok(json!({
                                "success": true,
                                "committed": 0,
                                "remaining": 0,
                                "created": [],
                                "updated": [],
                                "unchanged": [],
                            }));
                        }

                        // Read content from disk and build FileChange objects.
                        // Paths in SQLite are relative to the folder (e.g. "file.json"),
                        // but git paths need the folder prefix (e.g. "Products/file.json").
                        let changes: Vec<FileChange> = paths
                            .iter()
                            .map(|rel_path| {
                                let full_path = folder_dir.join(rel_path);
                                let content = std::fs::read_to_string(&full_path).map_err(|e| {
                                    AppError::internal(format!(
                                        "Failed to read staged file: {}",
                                        e
                                    ))
                                })?;
                                Ok(FileChange {
                                    path: format!("{}/{}", folder_name, rel_path),
                                    content: Some(content),
                                    oid: None,
                                    change_type: ChangeType::Modify,
                                })
                            })
                            .collect::<Result<Vec<_>, AppError>>()?;

                        let (_, stats) =
                            git_repo.commit_changes_to_ref(&branch, &changes, &message)?;

                        // Mark committed in SQLite
                        let tx = conn.unchecked_transaction().map_err(|e| {
                            AppError::internal(format!("Failed to begin transaction: {}", e))
                        })?;
                        for path in &paths {
                            tx.execute(
                                "UPDATE staged_files SET committed = 1 WHERE folder = ?1 AND path = ?2",
                                params![folder_name, path],
                            )
                            .map_err(|e| {
                                AppError::internal(format!("Failed to mark file committed: {}", e))
                            })?;
                        }
                        tx.commit().map_err(|e| {
                            AppError::internal(format!("Failed to commit transaction: {}", e))
                        })?;

                        // Count remaining uncommitted
                        let remaining: i64 = conn
                            .query_row(
                                "SELECT COUNT(*) FROM staged_files WHERE folder = ?1 AND committed = 0",
                                params![folder_name],
                                |row| row.get(0),
                            )
                            .map_err(|e| {
                                AppError::internal(format!("Failed to count remaining: {}", e))
                            })?;

                        Ok::<_, AppError>(json!({
                            "success": true,
                            "committed": paths.len(),
                            "remaining": remaining,
                            "created": stats.created,
                            "updated": stats.updated,
                            "unchanged": stats.unchanged,
                        }))
            }
        })
        .await;

    match result {
        Ok(data) => envelope(&state, Some(&repo_id), data),
        Err(err) => envelope_error(&state, Some(&repo_id), err),
    }
}

// ---------------------------------------------------------------------------
// POST /api/staging/{jobId}/commit-atomic — commit ALL staged files as ONE commit
//
// Unlike /commit (one git commit per call, looped by the caller until
// drained), this folds every uncommitted staged file for the folder into a
// single tree — reading from SQLite + disk in bounded batches — and writes
// exactly ONE commit whose parent is the current branch tip. Until the final
// ref update nothing is visible on the branch, so the caller gets
// all-or-nothing semantics however many files are staged, with no HTTP body
// limit in play (content streams from the staging dir, not the request).
//
// Built for the sync engine (DEV-11193): a table sync stages transformed
// records page by page to keep server memory flat, but must land them
// atomically — per-batch commits would leave a partially-synced table on the
// dirty branch when a later batch fails.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitStagedAtomicBody {
    pub repo_id: String,
    pub branch: Option<String>,
    pub folder: String,
    pub message: Option<String>,
    /// Files read from disk per tree-fold step. Bounds peak memory only —
    /// the result is always exactly zero or one commit. Each fold iterates
    /// the destination folder's full tree, so larger batches also mean fewer
    /// O(folder-size) passes; the default trades ~tens of MB of content in
    /// memory for 5× fewer folds than the /commit endpoint's batch size.
    pub batch_size: Option<usize>,
}

pub async fn commit_staged_atomic(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
    Json(body): Json<CommitStagedAtomicBody>,
) -> Response {
    let branch = body.branch.unwrap_or_else(|| MAIN_BRANCH.to_string());
    let staging_dir = state.staging_job_path(&job_id);
    let folder_dir = staging_dir.join(&body.folder);
    let repo_id = body.repo_id.clone();
    let message = body
        .message
        .unwrap_or_else(|| format!("Commit staged files for {}", body.folder));
    let batch_size = body.batch_size.unwrap_or(5000);

    let folder_name = body.folder.clone();
    let result = state
        .repo_locks
        .run_write(&repo_id, &branch, {
            let repos_dir = state.repos_dir.clone();
            let repo_id = repo_id.clone();
            let branch = branch.clone();
            move || {
                let git_repo = GitRepo::open(&repos_dir, &repo_id)?;

                // No index.db means nothing was ever staged — report an
                // empty success rather than a 404 so callers can treat
                // "no writes" uniformly.
                let db_path = staging_dir.join("index.db");
                if !db_path.exists() {
                    return Ok(json!({
                        "success": true,
                        "committed": 0,
                        "createdCount": 0,
                        "updatedCount": 0,
                        "unchangedCount": 0,
                    }));
                }

                let conn = open_staging_db(&staging_dir)?;

                // Resolve the tip ONCE; every batch folds into a tree that
                // descends from it, and the single commit at the end gets it
                // as sole parent. The write lock held around this closure is
                // what keeps the tip from moving underneath us.
                let parent_oid = git_repo.resolve_ref(&branch)?;
                let tip_tree_oid = git_repo.get_commit_tree_oid(parent_oid)?;

                let mut current_tree_oid = tip_tree_oid;
                let mut total_committed = 0usize;
                let mut created_count = 0usize;
                let mut updated_count = 0usize;
                let mut unchanged_count = 0usize;

                // Walk uncommitted rows by rowid so batching stays stable —
                // rows are only marked committed after the ref moves.
                let mut last_rowid: i64 = 0;
                loop {
                    let mut stmt = conn
                        .prepare(
                            "SELECT rowid, path FROM staged_files \
                                     WHERE folder = ?1 AND committed = 0 AND rowid > ?2 \
                                     ORDER BY rowid LIMIT ?3",
                        )
                        .map_err(|e| {
                            AppError::internal(format!("Failed to query uncommitted files: {}", e))
                        })?;

                    let rows: Vec<(i64, String)> = stmt
                        .query_map(params![folder_name, last_rowid, batch_size as i64], |row| {
                            Ok((row.get(0)?, row.get(1)?))
                        })
                        .map_err(|e| {
                            AppError::internal(format!("Failed to read uncommitted files: {}", e))
                        })?
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|e| {
                            AppError::internal(format!(
                                "Failed to collect uncommitted paths: {}",
                                e
                            ))
                        })?;

                    if rows.is_empty() {
                        break;
                    }
                    last_rowid = rows.last().map(|(rowid, _)| *rowid).unwrap_or(last_rowid);

                    let changes: Vec<FileChange> = rows
                        .iter()
                        .map(|(_, rel_path)| {
                            let full_path = folder_dir.join(rel_path);
                            let content = std::fs::read_to_string(&full_path).map_err(|e| {
                                AppError::internal(format!("Failed to read staged file: {}", e))
                            })?;
                            Ok(FileChange {
                                path: format!("{}/{}", folder_name, rel_path),
                                content: Some(content),
                                oid: None,
                                change_type: ChangeType::Modify,
                            })
                        })
                        .collect::<Result<Vec<_>, AppError>>()?;

                    let (next_tree_oid, stats) =
                        git_repo.apply_changes_to_tree(current_tree_oid, &changes, "")?;
                    current_tree_oid = next_tree_oid;
                    total_committed += rows.len();
                    created_count += stats.created.len();
                    updated_count += stats.updated.len();
                    unchanged_count += stats.unchanged.len();
                }

                // Write the single commit — skipped when every staged file
                // matched the tip byte-for-byte (tree unchanged), mirroring
                // commit_changes_to_ref's no-op behavior.
                if total_committed > 0 && current_tree_oid != tip_tree_oid {
                    let new_commit_oid =
                        git_repo.write_commit(current_tree_oid, &[parent_oid], &message)?;
                    // Compare-and-swap: if the tip moved while this build
                    // ran, fail rather than erase the newer commits. The
                    // write lock now lives inside this blocking task
                    // (`RepoLocks::run_write`), so this is belt-and-braces
                    // against any future lock gap rather than the primary
                    // defence it used to be.
                    git_repo.force_ref_expecting_current(&branch, new_commit_oid, parent_oid)?;
                }

                // Mark everything committed only after the ref moved, so a
                // crash mid-fold re-commits (idempotent) instead of dropping
                // files.
                if total_committed > 0 {
                    conn.execute(
                        "UPDATE staged_files SET committed = 1 WHERE folder = ?1 AND committed = 0",
                        params![folder_name],
                    )
                    .map_err(|e| {
                        AppError::internal(format!("Failed to mark files committed: {}", e))
                    })?;
                }

                Ok::<_, AppError>(json!({
                    "success": true,
                    "committed": total_committed,
                    "createdCount": created_count,
                    "updatedCount": updated_count,
                    "unchangedCount": unchanged_count,
                }))
            }
        })
        .await;

    match result {
        Ok(data) => envelope(&state, Some(&repo_id), data),
        Err(err) => envelope_error(&state, Some(&repo_id), err),
    }
}

// ---------------------------------------------------------------------------
// DELETE /api/staging/{jobId} — remove staging directory for a job
//
// On macOS, `remove_dir_all` can transiently fail with "Directory not empty"
// (os error 66) if a file was recently closed (e.g. SQLite WAL). Retry once
// after a short pause to handle this.
// ---------------------------------------------------------------------------

pub async fn cleanup_staging(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
) -> Response {
    let staging_dir = state.staging_job_path(&job_id);

    let result: Result<serde_json::Value, AppError> = tokio::task::spawn_blocking(move || {
        if staging_dir.exists() {
            if let Err(_first_err) = std::fs::remove_dir_all(&staging_dir) {
                // Retry once after a brief pause — handles transient macOS "Directory not empty"
                std::thread::sleep(std::time::Duration::from_millis(100));
                std::fs::remove_dir_all(&staging_dir).map_err(|e| {
                    AppError::internal(format!("Failed to remove staging dir: {}", e))
                })?;
            }
        }
        Ok(json!({ "success": true }))
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))
    .and_then(|r| r);

    match result {
        Ok(data) => envelope(&state, None, data),
        Err(err) => envelope_error(&state, None, err),
    }
}

// ---------------------------------------------------------------------------
// Staging observability + reaper (DEV-11317)
//
// Staging dirs (`{staging_dir}/{jobId}`) are normally removed by the caller's
// `finally` after a commit. A crash/redeploy between `stage_files` and that
// DELETE strands the dir forever (no Drop, no TTL). `list_staging` exposes each
// dir's age and size so the server's hourly cron can reap age + job-liveness
// orphans; `reap_stale_staging_dirs` is an age-only boot-time backstop for dirs
// orphaned by a redeploy before the cron next ticks. Neither is a boot-wipe:
// both respect the deliberate crash-resume design above via a generous max age.
// ---------------------------------------------------------------------------

/// One entry of the `GET /api/staging` listing: a `{staging_dir}/{jobId}` directory,
/// its last-modified time (millis since the Unix epoch), and its total on-disk size.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagingDirInfo {
    pub job_id: String,
    pub mtime_ms: i64,
    pub size_bytes: i64,
}

/// Outcome of an age-only staging sweep, for logging.
#[derive(Debug, Default)]
pub struct StagingReapSummary {
    pub scanned: usize,
    pub reaped_job_ids: Vec<String>,
    pub reaped_bytes: i64,
}

/// Milliseconds since the Unix epoch for a filesystem mtime, or 0 if it predates the epoch.
fn system_time_to_millis(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Total size in bytes of all regular files under `path`, recursively. A directory's own
/// `len()` is not its tree size, so we descend and sum file lengths. Best-effort: an
/// unreadable entry is skipped rather than failing the whole scan, since this feeds
/// observability (the orphan-bytes gauge), not correctness.
fn dir_size_bytes(path: &StdPath) -> i64 {
    let mut total: i64 = 0;
    let Ok(entries) = std::fs::read_dir(path) else {
        return total;
    };
    for entry in entries.flatten() {
        match entry.file_type() {
            Ok(file_type) if file_type.is_dir() => total += dir_size_bytes(&entry.path()),
            Ok(_) => {
                if let Ok(metadata) = entry.metadata() {
                    total += metadata.len() as i64;
                }
            }
            Err(_) => {}
        }
    }
    total
}

/// Enumerate the immediate child directories of `staging_dir` (one per job), returning each
/// job's id (directory name), mtime, and recursive size. A missing/unreadable staging root
/// yields an empty list (nothing has been staged yet). An entry whose mtime can't be read is
/// reported with `mtime_ms == 0` so the reaper can treat it as unknown rather than ancient.
fn scan_staging_dirs(staging_dir: &StdPath) -> Vec<StagingDirInfo> {
    let mut dirs = Vec::new();
    let Ok(entries) = std::fs::read_dir(staging_dir) else {
        return dirs;
    };
    for entry in entries.flatten() {
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if !is_dir {
            continue;
        }
        let job_id = entry.file_name().to_string_lossy().to_string();
        let mtime_ms = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(system_time_to_millis)
            .unwrap_or(0);
        dirs.push(StagingDirInfo {
            size_bytes: dir_size_bytes(&entry.path()),
            job_id,
            mtime_ms,
        });
    }
    dirs
}

/// Age-only reap of orphaned staging dirs: remove every `{staging_dir}/{jobId}` whose mtime is
/// older than `max_age`. This is the git service's boot-time backstop — it has no knowledge of
/// BullMQ/DbJob, so it cannot check liveness; the generous `max_age` (default 72h,
/// `GIT_STAGING_REAP_MAX_AGE_HOURS`) is what keeps it from racing the crash-resume design. The
/// server's hourly cron does the age + job-liveness reap. A dir whose mtime we couldn't read
/// (`mtime_ms == 0`) is skipped, never assumed ancient.
pub fn reap_stale_staging_dirs(staging_dir: &StdPath, max_age: Duration) -> StagingReapSummary {
    let mut summary = StagingReapSummary::default();
    let now_ms = system_time_to_millis(SystemTime::now());
    let max_age_ms = max_age.as_millis() as i64;

    for info in scan_staging_dirs(staging_dir) {
        summary.scanned += 1;

        if info.mtime_ms <= 0 {
            // Unknown mtime — don't risk deleting a dir we couldn't stat.
            continue;
        }
        // `saturating_sub` makes a future-dated mtime (clock skew) read as age 0 → left alone.
        let age_ms = now_ms.saturating_sub(info.mtime_ms);
        if age_ms <= max_age_ms {
            continue;
        }

        let job_dir = staging_dir.join(&info.job_id);
        // Mirror `cleanup_staging`: retry once after a brief pause for the transient macOS
        // "Directory not empty" (os error 66) from a just-closed SQLite WAL.
        if let Err(_first_err) = std::fs::remove_dir_all(&job_dir) {
            std::thread::sleep(Duration::from_millis(100));
            if let Err(second_err) = std::fs::remove_dir_all(&job_dir) {
                tracing::warn!(
                    "Failed to reap stale staging dir {:?}: {}",
                    job_dir,
                    second_err
                );
                continue;
            }
        }

        summary.reaped_bytes += info.size_bytes;
        summary.reaped_job_ids.push(info.job_id);
    }

    summary
}

// ---------------------------------------------------------------------------
// GET /api/staging — list staging directories (jobId + mtime + size) so the
// server's hourly reaper can find age + job-liveness orphans.
// ---------------------------------------------------------------------------

pub async fn list_staging(State(state): State<AppState>) -> Response {
    let staging_dir = state.staging_dir.clone();

    let result: Result<serde_json::Value, AppError> = tokio::task::spawn_blocking(move || {
        Ok(json!({ "stagingDirs": scan_staging_dirs(&staging_dir) }))
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))
    .and_then(|r| r);

    match result {
        Ok(data) => envelope(&state, None, data),
        Err(err) => envelope_error(&state, None, err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commit_path_prepends_folder_name() {
        let folder_name = "Products";
        let rel_path = "item-123.json";

        let committed_path = format!("{}/{}", folder_name, rel_path);

        assert_eq!(committed_path, "Products/item-123.json");
    }

    #[test]
    fn commit_path_prepends_folder_name_nested() {
        let folder_name = "Products";
        let rel_path = "sub/nested/item.json";

        let committed_path = format!("{}/{}", folder_name, rel_path);

        assert_eq!(committed_path, "Products/sub/nested/item.json");
    }

    // -----------------------------------------------------------------------
    // Handler-level tests. These exercise the full route functions
    // (AppState + axum extractors + a real git repo) end-to-end.
    // -----------------------------------------------------------------------

    use crate::service::git::lock::RepoLocks;
    use crate::service::git::repo::GitRepo;
    use crate::service::state::AppState;
    use axum::body::to_bytes;
    use axum::extract::{Path as AxumPath, Query as AxumQuery, State};
    use axum::http::StatusCode;
    use axum::Json;
    use dashmap::DashMap;
    use std::sync::Arc;
    use tempfile::TempDir;

    /// Build an `AppState` backed by fresh temp dirs and an initialized bare
    /// repo at `repo_id`. The temp dirs are returned so the caller can keep
    /// them alive for the duration of the test (dropping them deletes the
    /// underlying directories).
    fn make_state_with_repo(repo_id: &str) -> (AppState, TempDir, TempDir, TempDir) {
        let repos_dir = TempDir::new().unwrap();
        let staging_dir = TempDir::new().unwrap();
        let index_dir = TempDir::new().unwrap();

        GitRepo::init(repos_dir.path(), repo_id).unwrap();

        let state = AppState {
            repos_dir: repos_dir.path().to_path_buf(),
            index_dir: index_dir.path().to_path_buf(),
            staging_dir: staging_dir.path().to_path_buf(),
            build_version: "test".to_string(),
            gc_state: Arc::new(DashMap::new()),
            repo_locks: Arc::new(RepoLocks::new()),
        };

        (state, repos_dir, staging_dir, index_dir)
    }

    /// Read an axum response body and parse it as JSON. The handlers in this
    /// module always return JSON envelopes, so this is safe.
    async fn response_json(response: axum::response::Response) -> serde_json::Value {
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    /// Helper: call `stage_files` to write files to disk AND populate the SQLite index.
    async fn do_stage_files(
        state: &AppState,
        job_id: &str,
        folder: &str,
        files: Vec<(&str, &str)>,
    ) {
        let response = stage_files(
            State(state.clone()),
            AxumPath(job_id.to_string()),
            Json(StageFilesBody {
                folder: folder.to_string(),
                files: files
                    .into_iter()
                    .map(|(path, content)| StageFileInput {
                        path: path.to_string(),
                        content: content.to_string(),
                    })
                    .collect(),
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
    }

    // -----------------------------------------------------------------------
    // Staging reaper / listing (DEV-11317)
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn reap_stale_staging_dirs_removes_old_orphan() {
        let repo_id = "test-org/test-wkb/test-conn".to_string();
        let (state, _repos, _staging, _index) = make_state_with_repo(&repo_id);
        let job_id = "pull_job_old";
        do_stage_files(&state, job_id, "Products", vec![("a.json", r#"{"id":1}"#)]).await;

        let job_dir = state.staging_job_path(job_id);
        assert!(job_dir.exists());

        // Sleep so the dir's (millisecond-truncated) age is comfortably non-zero, then reap
        // everything older than 0 → this dir qualifies. Exercises the real dir-mtime read
        // without a mtime-backdating dependency.
        std::thread::sleep(Duration::from_millis(10));
        let summary = reap_stale_staging_dirs(&state.staging_dir, Duration::ZERO);

        assert!(
            !job_dir.exists(),
            "old orphaned staging dir should be reaped"
        );
        assert_eq!(summary.scanned, 1);
        assert_eq!(summary.reaped_job_ids, vec![job_id.to_string()]);
        assert!(
            summary.reaped_bytes > 0,
            "reaped bytes should reflect the staged file"
        );
    }

    #[tokio::test]
    async fn reap_stale_staging_dirs_keeps_fresh_dir() {
        let repo_id = "test-org/test-wkb/test-conn".to_string();
        let (state, _repos, _staging, _index) = make_state_with_repo(&repo_id);
        let job_id = "pull_job_fresh";
        do_stage_files(&state, job_id, "Products", vec![("a.json", r#"{"id":1}"#)]).await;

        let job_dir = state.staging_job_path(job_id);
        // A 24h max age dwarfs the dir's real age (a few ms) → it must be left alone.
        let summary = reap_stale_staging_dirs(&state.staging_dir, Duration::from_secs(24 * 3600));

        assert!(job_dir.exists(), "a fresh staging dir must not be reaped");
        assert_eq!(summary.scanned, 1);
        assert!(summary.reaped_job_ids.is_empty());
        assert_eq!(summary.reaped_bytes, 0);
    }

    #[tokio::test]
    async fn scan_staging_dirs_reports_job_id_mtime_and_size() {
        let repo_id = "test-org/test-wkb/test-conn".to_string();
        let (state, _repos, _staging, _index) = make_state_with_repo(&repo_id);
        let job_id = "pull_job_scan";
        do_stage_files(&state, job_id, "Products", vec![("a.json", r#"{"id":1}"#)]).await;

        let dirs = scan_staging_dirs(&state.staging_dir);
        assert_eq!(dirs.len(), 1);
        assert_eq!(dirs[0].job_id, job_id);
        assert!(dirs[0].size_bytes > 0);
        assert!(dirs[0].mtime_ms > 0);
    }

    #[tokio::test]
    async fn scan_staging_dirs_empty_when_nothing_staged() {
        let repo_id = "test-org/test-wkb/test-conn".to_string();
        let (state, _repos, _staging, _index) = make_state_with_repo(&repo_id);
        assert!(scan_staging_dirs(&state.staging_dir).is_empty());
    }

    #[tokio::test]
    async fn commit_staged_missing_folder_returns_empty_success() {
        let repo_id = "test-org/test-wkb/test-conn".to_string();
        let (state, _repos, _staging, _index) = make_state_with_repo(&repo_id);

        let response = commit_staged(
            State(state),
            AxumPath("job_does_not_exist".to_string()),
            Json(CommitStagedBody {
                repo_id: repo_id.clone(),
                branch: Some(MAIN_BRANCH.to_string()),
                folder: "Empty Folder".to_string(),
                message: Some("test".to_string()),
                batch_size: None,
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let json = response_json(response).await;
        assert_eq!(json["data"]["success"], true);
        assert_eq!(json["data"]["committed"], 0);
        assert_eq!(json["data"]["remaining"], 0);
        assert_eq!(json["data"]["created"], serde_json::json!([]));
        assert_eq!(json["data"]["updated"], serde_json::json!([]));
        assert_eq!(json["data"]["unchanged"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn commit_staged_empty_existing_folder_returns_empty_success() {
        let repo_id = "test-org/test-wkb/test-conn".to_string();
        let (state, _repos, _staging, _index) = make_state_with_repo(&repo_id);

        let job_id = "job_empty_dir";
        let folder = "Empty Folder";

        // Create job staging dir with index.db but no files staged
        let staging_dir = state.staging_job_path(job_id);
        std::fs::create_dir_all(&staging_dir).unwrap();
        open_staging_db(&staging_dir).unwrap();

        let response = commit_staged(
            State(state),
            AxumPath(job_id.to_string()),
            Json(CommitStagedBody {
                repo_id: repo_id.clone(),
                branch: Some(MAIN_BRANCH.to_string()),
                folder: folder.to_string(),
                message: Some("test".to_string()),
                batch_size: None,
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let json = response_json(response).await;
        assert_eq!(json["data"]["success"], true);
        assert_eq!(json["data"]["committed"], 0);
        assert_eq!(json["data"]["created"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn commit_staged_with_files_commits_under_folder_prefix() {
        let repo_id = "test-org/test-wkb/test-conn".to_string();
        let (state, _repos, _staging, _index) = make_state_with_repo(&repo_id);

        let job_id = "job_with_files";
        let folder = "Products";

        do_stage_files(
            &state,
            job_id,
            folder,
            vec![("a.json", r#"{"id":1}"#), ("b.json", r#"{"id":2}"#)],
        )
        .await;

        let response = commit_staged(
            State(state),
            AxumPath(job_id.to_string()),
            Json(CommitStagedBody {
                repo_id: repo_id.clone(),
                branch: Some(MAIN_BRANCH.to_string()),
                folder: folder.to_string(),
                message: Some("Add products".to_string()),
                batch_size: None,
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let json = response_json(response).await;
        assert_eq!(json["data"]["success"], true);
        assert_eq!(json["data"]["committed"], 2);
        assert_eq!(json["data"]["remaining"], 0);

        let created = json["data"]["created"].as_array().unwrap();
        let mut paths: Vec<&str> = created.iter().map(|v| v.as_str().unwrap()).collect();
        paths.sort();
        assert_eq!(paths, vec!["Products/a.json", "Products/b.json"]);
    }

    #[tokio::test]
    async fn commit_staged_respects_batch_size() {
        let repo_id = "test-org/test-wkb/test-conn".to_string();
        let (state, _repos, _staging, _index) = make_state_with_repo(&repo_id);

        let job_id = "job_batch";
        let folder = "Items";

        let files: Vec<(&str, String)> = (0..5)
            .map(|i| {
                let name: &'static str = Box::leak(format!("item-{}.json", i).into_boxed_str());
                let content = format!(r#"{{"id":{}}}"#, i);
                (name, content)
            })
            .collect();
        let file_refs: Vec<(&str, &str)> = files.iter().map(|(n, c)| (*n, c.as_str())).collect();
        do_stage_files(&state, job_id, folder, file_refs).await;

        // Commit with batchSize=2 — should commit 2 files, leave 3 remaining
        let response = commit_staged(
            State(state.clone()),
            AxumPath(job_id.to_string()),
            Json(CommitStagedBody {
                repo_id: repo_id.clone(),
                branch: Some(MAIN_BRANCH.to_string()),
                folder: folder.to_string(),
                message: Some("Batch 1".to_string()),
                batch_size: Some(2),
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let json = response_json(response).await;
        assert_eq!(json["data"]["committed"], 2);
        assert_eq!(json["data"]["remaining"], 3);

        // Commit another batch
        let response = commit_staged(
            State(state.clone()),
            AxumPath(job_id.to_string()),
            Json(CommitStagedBody {
                repo_id: repo_id.clone(),
                branch: Some(MAIN_BRANCH.to_string()),
                folder: folder.to_string(),
                message: Some("Batch 2".to_string()),
                batch_size: Some(2),
            }),
        )
        .await;

        let json = response_json(response).await;
        assert_eq!(json["data"]["committed"], 2);
        assert_eq!(json["data"]["remaining"], 1);

        // Final batch
        let response = commit_staged(
            State(state.clone()),
            AxumPath(job_id.to_string()),
            Json(CommitStagedBody {
                repo_id: repo_id.clone(),
                branch: Some(MAIN_BRANCH.to_string()),
                folder: folder.to_string(),
                message: Some("Batch 3".to_string()),
                batch_size: Some(2),
            }),
        )
        .await;

        let json = response_json(response).await;
        assert_eq!(json["data"]["committed"], 1);
        assert_eq!(json["data"]["remaining"], 0);

        // Verify all files are in git
        let git_repo = GitRepo::open(&state.repos_dir, &repo_id).unwrap();
        for i in 0..5 {
            let content = git_repo
                .get_file_content(MAIN_BRANCH, &format!("Items/item-{}.json", i))
                .unwrap();
            assert!(content.is_some(), "item-{}.json should exist in git", i);
        }
    }

    #[tokio::test]
    async fn read_staged_files_returns_unprocessed_only() {
        let repo_id = "test-org/test-wkb/test-conn".to_string();
        let (state, _repos, _staging, _index) = make_state_with_repo(&repo_id);

        let job_id = "job_read";
        let folder = "Products";

        do_stage_files(
            &state,
            job_id,
            folder,
            vec![
                ("a.json", r#"{"id":1}"#),
                ("b.json", r#"{"id":2}"#),
                ("c.json", r#"{"id":3}"#),
            ],
        )
        .await;

        // Read all unprocessed
        let response = read_staged_files(
            State(state.clone()),
            AxumPath(job_id.to_string()),
            AxumQuery(ReadStagedFilesQuery {
                folder: folder.to_string(),
                limit: 100,
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let json = response_json(response).await;
        assert_eq!(json["data"]["files"].as_array().unwrap().len(), 3);
        assert_eq!(json["data"]["remaining"], 0);

        // Read with limit=2
        let response = read_staged_files(
            State(state.clone()),
            AxumPath(job_id.to_string()),
            AxumQuery(ReadStagedFilesQuery {
                folder: folder.to_string(),
                limit: 2,
            }),
        )
        .await;

        let json = response_json(response).await;
        assert_eq!(json["data"]["files"].as_array().unwrap().len(), 2);
        assert_eq!(json["data"]["remaining"], 1);
    }

    #[tokio::test]
    async fn same_filename_in_different_folders_is_not_dropped() {
        // Regression: the staging index PK used to be `path` alone, so a filename
        // that legitimately occurs in two folders — e.g. a Contact and a
        // Conversation both named after 'Ivan Dimitrov' → 'ivan-dimitrov.json' —
        // collided: the second folder's INSERT OR IGNORE was silently dropped and
        // that folder committed nothing (empty folder). With a (folder, path) PK
        // both files must survive independently.
        let repo_id = "test-org/test-wkb/test-conn".to_string();
        let (state, _repos, _staging, _index) = make_state_with_repo(&repo_id);
        let job_id = "job_collision";

        do_stage_files(
            &state,
            job_id,
            "Contacts",
            vec![("ivan-dimitrov.json", r#"{"id":"c1"}"#)],
        )
        .await;
        do_stage_files(
            &state,
            job_id,
            "Conversations",
            vec![("ivan-dimitrov.json", r#"{"id":"v1"}"#)],
        )
        .await;

        for folder in ["Contacts", "Conversations"] {
            let response = read_staged_files(
                State(state.clone()),
                AxumPath(job_id.to_string()),
                AxumQuery(ReadStagedFilesQuery {
                    folder: folder.to_string(),
                    limit: 100,
                }),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            let json = response_json(response).await;
            assert_eq!(
                json["data"]["files"].as_array().unwrap().len(),
                1,
                "folder {folder} should still have its file staged despite the cross-folder filename collision"
            );
        }
    }

    #[tokio::test]
    async fn mark_processed_excludes_from_reads() {
        let repo_id = "test-org/test-wkb/test-conn".to_string();
        let (state, _repos, _staging, _index) = make_state_with_repo(&repo_id);

        let job_id = "job_mark";
        let folder = "Products";

        do_stage_files(
            &state,
            job_id,
            folder,
            vec![("a.json", r#"{"id":1}"#), ("b.json", r#"{"id":2}"#)],
        )
        .await;

        // Mark a.json as processed
        let response = mark_staged_files_processed(
            State(state.clone()),
            AxumPath(job_id.to_string()),
            Json(MarkProcessedBody {
                folder: folder.to_string(),
                paths: vec!["a.json".to_string()],
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let json = response_json(response).await;
        assert_eq!(json["data"]["count"], 1);

        // Read should only return b.json
        let response = read_staged_files(
            State(state.clone()),
            AxumPath(job_id.to_string()),
            AxumQuery(ReadStagedFilesQuery {
                folder: folder.to_string(),
                limit: 100,
            }),
        )
        .await;

        let json = response_json(response).await;
        let files = json["data"]["files"].as_array().unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0]["path"], "b.json");
        assert_eq!(json["data"]["remaining"], 0);
    }

    #[tokio::test]
    async fn read_staged_files_no_index_returns_empty() {
        let repo_id = "test-org/test-wkb/test-conn".to_string();
        let (state, _repos, _staging, _index) = make_state_with_repo(&repo_id);

        let response = read_staged_files(
            State(state),
            AxumPath("nonexistent_job".to_string()),
            AxumQuery(ReadStagedFilesQuery {
                folder: "Products".to_string(),
                limit: 100,
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let json = response_json(response).await;
        assert_eq!(json["data"]["files"].as_array().unwrap().len(), 0);
        assert_eq!(json["data"]["remaining"], 0);
    }

    // -----------------------------------------------------------------------
    // commit_staged_atomic — many staged batches must land as exactly ONE
    // commit on the branch (DEV-11193).
    // -----------------------------------------------------------------------

    async fn do_commit_staged_atomic(
        state: &AppState,
        job_id: &str,
        repo_id: &str,
        folder: &str,
        batch_size: Option<usize>,
    ) -> serde_json::Value {
        let response = commit_staged_atomic(
            State(state.clone()),
            AxumPath(job_id.to_string()),
            Json(CommitStagedAtomicBody {
                repo_id: repo_id.to_string(),
                branch: Some(MAIN_BRANCH.to_string()),
                folder: folder.to_string(),
                message: Some("Atomic commit".to_string()),
                batch_size,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        response_json(response).await
    }

    #[tokio::test]
    async fn commit_staged_atomic_missing_folder_returns_empty_success() {
        let repo_id = "test-org/test-wkb/test-conn".to_string();
        let (state, _repos, _staging, _index) = make_state_with_repo(&repo_id);

        let json =
            do_commit_staged_atomic(&state, "job_does_not_exist", &repo_id, "Empty", None).await;
        assert_eq!(json["data"]["success"], true);
        assert_eq!(json["data"]["committed"], 0);
        assert_eq!(json["data"]["createdCount"], 0);
    }

    #[tokio::test]
    async fn commit_staged_atomic_lands_many_batches_as_one_commit() {
        let repo_id = "test-org/test-wkb/test-conn".to_string();
        let (state, _repos, _staging, _index) = make_state_with_repo(&repo_id);

        let job_id = "job_atomic";
        let folder = "Charges";

        let files: Vec<(String, String)> = (0..5)
            .map(|i| (format!("charge-{}.json", i), format!(r#"{{"id":{}}}"#, i)))
            .collect();
        let file_refs: Vec<(&str, &str)> = files
            .iter()
            .map(|(n, c)| (n.as_str(), c.as_str()))
            .collect();
        do_stage_files(&state, job_id, folder, file_refs).await;

        let git_repo = GitRepo::open(&state.repos_dir, &repo_id).unwrap();
        let tip_before = git_repo.resolve_ref(MAIN_BRANCH).unwrap();

        // batch_size=2 forces three internal tree-fold steps — still one commit.
        let json = do_commit_staged_atomic(&state, job_id, &repo_id, folder, Some(2)).await;
        assert_eq!(json["data"]["success"], true);
        assert_eq!(json["data"]["committed"], 5);
        assert_eq!(json["data"]["createdCount"], 5);
        assert_eq!(json["data"]["updatedCount"], 0);

        // Exactly one commit: the new tip's sole parent is the old tip.
        let tip_after = git_repo.resolve_ref(MAIN_BRANCH).unwrap();
        assert_ne!(tip_after, tip_before);
        let info = git_repo.read_commit_info(tip_after).unwrap();
        assert_eq!(info.parents, vec![tip_before]);
        assert_eq!(info.message.trim(), "Atomic commit");

        // Every staged file is readable at the new tip, under the folder prefix.
        for i in 0..5 {
            let content = git_repo
                .get_file_content(MAIN_BRANCH, &format!("Charges/charge-{}.json", i))
                .unwrap();
            assert_eq!(
                content.as_deref(),
                Some(format!(r#"{{"id":{}}}"#, i).as_str())
            );
        }

        // Re-running commits nothing (all rows marked committed) and moves no ref.
        let json = do_commit_staged_atomic(&state, job_id, &repo_id, folder, Some(2)).await;
        assert_eq!(json["data"]["committed"], 0);
        assert_eq!(git_repo.resolve_ref(MAIN_BRANCH).unwrap(), tip_after);
    }

    #[tokio::test]
    async fn commit_staged_atomic_identical_content_moves_no_ref() {
        let repo_id = "test-org/test-wkb/test-conn".to_string();
        let (state, _repos, _staging, _index) = make_state_with_repo(&repo_id);

        let job_id = "job_atomic_noop";
        let folder = "Charges";

        do_stage_files(&state, job_id, folder, vec![("a.json", r#"{"id":1}"#)]).await;
        do_commit_staged_atomic(&state, job_id, &repo_id, folder, None).await;

        let git_repo = GitRepo::open(&state.repos_dir, &repo_id).unwrap();
        let tip_after_first = git_repo.resolve_ref(MAIN_BRANCH).unwrap();

        // Stage the SAME content again (fresh job, as a retried sync would).
        let job_id_2 = "job_atomic_noop_retry";
        do_stage_files(&state, job_id_2, folder, vec![("a.json", r#"{"id":1}"#)]).await;
        let json = do_commit_staged_atomic(&state, job_id_2, &repo_id, folder, None).await;

        // The staged file was processed but the tree is byte-identical, so no
        // commit is written — mirroring commit_changes_to_ref's no-op skip.
        assert_eq!(json["data"]["committed"], 1);
        assert_eq!(json["data"]["unchangedCount"], 1);
        assert_eq!(git_repo.resolve_ref(MAIN_BRANCH).unwrap(), tip_after_first);
    }
}
