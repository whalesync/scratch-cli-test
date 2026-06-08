use axum::extract::{Path, Query, State};
use axum::response::Response;
use axum::Json;
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::json;
use std::path::Path as StdPath;

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
    let result = {
        let repos_dir = state.repos_dir.clone();
        let write_locks = state.write_locks.clone();
        let branch_clone = branch.clone();
        let repo_id_clone = repo_id.clone();

        write_locks
            .with_lock(&repo_id_clone, &branch_clone, || {
                let repos_dir = repos_dir.clone();
                let repo_id = repo_id_clone.clone();
                let branch = branch_clone.clone();
                let folder_name = folder_name.clone();
                async move {
                    tokio::task::spawn_blocking(move || {
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
                    })
                    .await
                    .map_err(|e| AppError::internal(e.to_string()))?
                }
            })
            .await
    };

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

    use crate::service::git::lock::WriteLockManager;
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
            write_locks: Arc::new(WriteLockManager::new()),
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
}
