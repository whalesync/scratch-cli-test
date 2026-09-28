//! Live Export run store storage — one SQLite database per routine run.
//!
//! A run store is a disposable, generic key/value store that one Live Export routine run uses
//! instead of git and Postgres for every per-record byte it works on (see `docs/RUN_STORE.md` and
//! `docs/plans/2026-09-25-live-export-git-free-run-store/`). It lives at
//! `{staging_dir}/le-<routineRunId>/run.db`, inside the staging dir, so `GET /api/staging`
//! (listing, sizes), the boot-time sweep and the server's hourly reaper all see it.
//!
//! The store holds named COLLECTIONS; each is an ordered map of string keys to entries with a
//! small JSON `meta` object and an optional `body` string:
//!
//! ```sql
//! entries(collection TEXT, key TEXT, meta TEXT DEFAULT '{}', body_bytes INTEGER DEFAULT 0,
//!         body TEXT, PRIMARY KEY (collection, key)) WITHOUT ROWID
//! ```
//!
//! `body` is deliberately the LAST column: in a WITHOUT ROWID table a row is stored in primary-key
//! order followed by the other columns in declaration order, and a multi-KB body spills to overflow
//! pages. With the body last, a keys+meta read (`includeBodies=false`) and the summary's
//! `SUM(body_bytes)` never touch those overflow pages.
//!
//! Connections: each open store keeps one writer connection (all writes, `BEGIN IMMEDIATE`) plus a
//! few idle reader connections (WAL lets readers run alongside the writer), cached in
//! [`RunStoreState`] and dropped before the store is cleared or deleted. All of this is blocking
//! code — callers run it on the blocking pool (`spawn_blocking`).

use dashmap::DashMap;
use rusqlite::config::DbConfig;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::path::{Path as StdPath, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use crate::service::error::AppError;
use crate::service::routes::staging::{dir_size_bytes, remove_staging_dir_with_retry};

/// Staging keys starting with this prefix are Live Export run stores, not pull/sync staging dirs.
pub const RUN_STORE_KEY_PREFIX: &str = "le-";

/// The run store's SQLite database, at `{staging_dir}/le-<routineRunId>/run.db`.
pub const RUN_STORE_DATABASE_FILE_NAME: &str = "run.db";

/// Default for `GIT_LE_RUN_STORE_MAX_BYTES`: the total on-disk budget for every `le-` dir
/// together (5 GiB: room for the largest known export, ~1.2 GB, several times over).
pub const DEFAULT_RUN_STORE_MAX_BYTES: u64 = 5 * 1024 * 1024 * 1024;

/// Age after which the boot-time sweep (`reap_stale_staging_dirs`) and the server's hourly reaper
/// treat an `le-` dir as orphaned. A Live Export run is never resumed a day later — the routine
/// simply runs again — so this is much shorter than the 72 h pull/sync staging threshold.
pub const RUN_STORE_STAGING_REAP_MAX_AGE: Duration = Duration::from_secs(24 * 3600);

/// How long a connection waits on a concurrent writer before failing with SQLITE_BUSY. Only one
/// writer connection exists per store, so this mostly covers checkpoints and stray openers.
const RUN_STORE_DATABASE_BUSY_TIMEOUT: Duration = Duration::from_secs(30);

/// Idle reader connections kept per open store. More concurrent readers than this still work —
/// the extra connections are opened on demand and closed after use.
const MAXIMUM_IDLE_READER_CONNECTIONS_PER_RUN_STORE: usize = 4;

/// Page cache per connection (negative = KiB for SQLite's `cache_size`): 32 MiB.
const RUN_STORE_CONNECTION_CACHE_SIZE_KIB: i64 = 32 * 1024;

/// Truncate the WAL back to this size after a checkpoint, so one huge bulk transaction doesn't
/// leave a huge `-wal` file behind for the rest of the run.
const RUN_STORE_WAL_SIZE_LIMIT_BYTES: i64 = 64 * 1024 * 1024;

/// Longest collection name accepted (collection names are URL path segments).
pub const MAXIMUM_COLLECTION_NAME_CHARACTERS: usize = 200;

/// Schema of a run store database (see the module docs for the column order rationale).
const RUN_STORE_DATABASE_SCHEMA_SQL: &str = "
    CREATE TABLE IF NOT EXISTS entries (
        collection TEXT NOT NULL,
        key        TEXT NOT NULL,
        meta       TEXT NOT NULL DEFAULT '{}',
        body_bytes INTEGER NOT NULL DEFAULT 0,
        body       TEXT,
        PRIMARY KEY (collection, key)
    ) WITHOUT ROWID;
";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/// True when a staging key belongs to the Live Export run-store namespace.
pub fn is_run_store_key(staging_key: &str) -> bool {
    staging_key.starts_with(RUN_STORE_KEY_PREFIX)
}

/// Validate that `run_store_key` is `le-` followed by 1–128 of `[A-Za-z0-9_-]`. The key becomes a
/// directory name under `{staging_dir}`, so anything path-like is refused.
pub fn validate_run_store_key(run_store_key: &str) -> Result<(), AppError> {
    let Some(routine_run_id) = run_store_key.strip_prefix(RUN_STORE_KEY_PREFIX) else {
        return Err(AppError::bad_request(format!(
            "'{}' is not a run store key: run store keys start with '{}'",
            run_store_key, RUN_STORE_KEY_PREFIX
        )));
    };
    let routine_run_id_is_valid = !routine_run_id.is_empty()
        && routine_run_id.len() <= 128
        && routine_run_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '-'
        });
    if !routine_run_id_is_valid {
        return Err(AppError::bad_request(format!(
            "Invalid run store key '{}': expected 'le-' followed by 1-128 characters of [A-Za-z0-9_-]",
            run_store_key
        )));
    }
    Ok(())
}

/// Validate a collection name: 1–200 of `[A-Za-z0-9_.:-]`, and not `.` or `..` (it is a URL path
/// segment, where those two would be normalized away).
pub fn validate_collection_name(collection: &str) -> Result<(), AppError> {
    let collection_name_is_valid = !collection.is_empty()
        && collection.len() <= MAXIMUM_COLLECTION_NAME_CHARACTERS
        && collection != "."
        && collection != ".."
        && collection.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | ':' | '-')
        });
    if !collection_name_is_valid {
        return Err(AppError::bad_request(format!(
            "Invalid run store collection name '{}': expected 1-{} characters of [A-Za-z0-9_.:-] (not '.' or '..')",
            collection, MAXIMUM_COLLECTION_NAME_CHARACTERS
        )));
    }
    Ok(())
}

fn sqlite_error(context: &str) -> impl Fn(rusqlite::Error) -> AppError + '_ {
    move |error| AppError::internal(format!("Run store {}: {}", context, error))
}

fn run_store_not_found(run_store_key: &str) -> AppError {
    AppError::not_found(format!(
        "Run store '{}' does not exist; create it with POST /api/run-store/{} first",
        run_store_key, run_store_key
    ))
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// One entry to insert or replace. `meta` omitted/null = `{}`; `body` omitted/null = no body.
#[derive(Debug, Deserialize)]
pub struct RunStoreEntryToPut {
    pub key: String,
    #[serde(default)]
    pub meta: Option<Box<RawValue>>,
    #[serde(default)]
    pub body: Option<String>,
}

/// One entry as read back. `body` is omitted unless the read asked for bodies, and then it is
/// `null` for an entry without one. `meta` is the stored JSON text, embedded verbatim.
#[derive(Debug, Serialize)]
pub struct RunStoreEntry {
    pub key: String,
    pub meta: Box<RawValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<Option<String>>,
}

/// One page of a collection plus the cursor for the next page (`None` after the last page).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStoreEntriesPage {
    pub entries: Vec<RunStoreEntry>,
    pub next_after_key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStoreEntriesByKeys {
    pub entries: Vec<RunStoreEntry>,
    pub missing_keys: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStoreEntryMetaPatch {
    pub key: String,
    pub meta_patch: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStoreCollectionSummary {
    pub collection: String,
    pub entry_count: i64,
    pub body_bytes: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStoreSummary {
    pub key: String,
    pub collections: Vec<RunStoreCollectionSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedRunStore {
    pub key: String,
    /// True when the store already existed and was emptied.
    pub cleared: bool,
    pub bytes_in_use_by_other_run_stores: i64,
    pub run_store_max_bytes: u64,
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

fn open_run_store_connection(
    database_path: &StdPath,
    create_if_missing: bool,
) -> rusqlite::Result<Connection> {
    let mut open_flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    if create_if_missing {
        open_flags |= OpenFlags::SQLITE_OPEN_CREATE;
    }
    let connection = Connection::open_with_flags(database_path, open_flags)?;
    connection.busy_timeout(RUN_STORE_DATABASE_BUSY_TIMEOUT)?;
    // `journal_mode` answers with a row, so it can't go through `execute_batch`.
    let _journal_mode: String =
        connection.query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))?;
    connection.execute_batch(&format!(
        "PRAGMA synchronous=NORMAL;
         PRAGMA cache_size=-{RUN_STORE_CONNECTION_CACHE_SIZE_KIB};
         PRAGMA journal_size_limit={RUN_STORE_WAL_SIZE_LIMIT_BYTES};
         PRAGMA temp_store=MEMORY;"
    ))?;
    Ok(connection)
}

/// The cached connections of one open run store.
pub struct OpenRunStoreDatabase {
    database_path: PathBuf,
    writer_connection: Mutex<Connection>,
    idle_reader_connections: Mutex<Vec<Connection>>,
}

fn lock_ignoring_poison<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic mid-operation drops its `Transaction`, which rolls back — the connection is fine.
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl OpenRunStoreDatabase {
    fn new(database_path: PathBuf, writer_connection: Connection) -> Self {
        Self {
            database_path,
            writer_connection: Mutex::new(writer_connection),
            idle_reader_connections: Mutex::new(Vec::new()),
        }
    }

    /// Run `write_operation` in one `BEGIN IMMEDIATE` transaction on the writer connection and
    /// commit it; an error rolls the whole call back.
    pub fn write<T>(
        &self,
        write_operation: impl FnOnce(&rusqlite::Transaction) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let mut writer_connection = lock_ignoring_poison(&self.writer_connection);
        let transaction = writer_connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_error("failed to begin write transaction"))?;
        let result = write_operation(&transaction)?;
        transaction
            .commit()
            .map_err(sqlite_error("failed to commit"))?;
        Ok(result)
    }

    /// Run `read_operation` in one read transaction (a consistent snapshot) on a reader connection.
    pub fn read<T>(
        &self,
        read_operation: impl FnOnce(&rusqlite::Transaction) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let idle_reader_connection = lock_ignoring_poison(&self.idle_reader_connections).pop();
        let mut reader_connection = match idle_reader_connection {
            Some(connection) => connection,
            None => open_run_store_connection(&self.database_path, false)
                .map_err(sqlite_error("failed to open a reader connection"))?,
        };
        let result = (|| {
            let transaction = reader_connection
                .transaction_with_behavior(TransactionBehavior::Deferred)
                .map_err(sqlite_error("failed to begin read transaction"))?;
            let result = read_operation(&transaction)?;
            transaction
                .commit()
                .map_err(sqlite_error("failed to end read transaction"))?;
            Ok(result)
        })();
        let mut idle_reader_connections = lock_ignoring_poison(&self.idle_reader_connections);
        if idle_reader_connections.len() < MAXIMUM_IDLE_READER_CONNECTIONS_PER_RUN_STORE {
            idle_reader_connections.push(reader_connection);
        }
        result
    }

    /// Stop every cached connection from checkpointing the WAL into the database file when it
    /// closes — used right before the store's files are deleted, where that work is wasted.
    fn skip_checkpoint_on_close(&self) {
        let disable = |connection: &Connection| {
            let _ = connection.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true);
        };
        disable(&lock_ignoring_poison(&self.writer_connection));
        for connection in lock_ignoring_poison(&self.idle_reader_connections).iter() {
            disable(connection);
        }
    }
}

/// On-disk bytes of every `le-` dir under `staging_dir` except `excluded_run_store_key`. Only the
/// run store dirs are walked — pull staging dirs can hold hundreds of thousands of files.
fn sizes_of_other_run_store_dirs(staging_dir: &StdPath, excluded_run_store_key: &str) -> Vec<i64> {
    let Ok(staging_entries) = std::fs::read_dir(staging_dir) else {
        return Vec::new();
    };
    staging_entries
        .flatten()
        .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter(|entry| {
            let dir_name = entry.file_name().to_string_lossy().to_string();
            is_run_store_key(&dir_name) && dir_name != excluded_run_store_key
        })
        .map(|entry| dir_size_bytes(&entry.path()))
        .collect()
}

/// Process-wide run store state: the byte budget and the cache of open stores.
pub struct RunStoreState {
    /// Total on-disk budget for every run store (`{staging_dir}/le-*`) together
    /// (`GIT_LE_RUN_STORE_MAX_BYTES`, default 5 GiB). Creating a store is refused with 507 once
    /// the OTHER run stores already use this much; `GET /api/staging` reports it so the server's
    /// hourly reaper enforces the same number.
    pub max_bytes: u64,
    open_run_store_databases_by_key: DashMap<String, Arc<OpenRunStoreDatabase>>,
    /// Serializes create / clear / delete / first open, so a store is never re-opened (and
    /// re-cached) while it is being deleted.
    lifecycle_lock: Mutex<()>,
}

impl Default for RunStoreState {
    fn default() -> Self {
        Self::new(DEFAULT_RUN_STORE_MAX_BYTES)
    }
}

impl RunStoreState {
    pub fn new(max_bytes: u64) -> Self {
        Self {
            max_bytes,
            open_run_store_databases_by_key: DashMap::new(),
            lifecycle_lock: Mutex::new(()),
        }
    }

    fn run_store_database_path(staging_dir: &StdPath, run_store_key: &str) -> PathBuf {
        staging_dir
            .join(run_store_key)
            .join(RUN_STORE_DATABASE_FILE_NAME)
    }

    /// Drop the cached connections of a store (in-flight operations keep theirs until they finish).
    fn evict_cached_connections(&self, run_store_key: &str) {
        if let Some((_, open_database)) = self.open_run_store_databases_by_key.remove(run_store_key)
        {
            open_database.skip_checkpoint_on_close();
        }
    }

    /// The open store for `run_store_key`, opening (and caching) it on first use. A store that was
    /// never created — or was deleted — is a 404: writes can't bypass the create-time budget check.
    pub fn open_existing_run_store(
        &self,
        staging_dir: &StdPath,
        run_store_key: &str,
    ) -> Result<Arc<OpenRunStoreDatabase>, AppError> {
        if let Some(open_database) = self.open_run_store_databases_by_key.get(run_store_key) {
            return Ok(open_database.clone());
        }
        let _lifecycle_guard = lock_ignoring_poison(&self.lifecycle_lock);
        if let Some(open_database) = self.open_run_store_databases_by_key.get(run_store_key) {
            return Ok(open_database.clone());
        }
        let database_path = Self::run_store_database_path(staging_dir, run_store_key);
        if !database_path.exists() {
            return Err(run_store_not_found(run_store_key));
        }
        let writer_connection = open_run_store_connection(&database_path, false).map_err(|e| {
            if database_path.exists() {
                sqlite_error("failed to open")(e)
            } else {
                run_store_not_found(run_store_key)
            }
        })?;
        let open_database = Arc::new(OpenRunStoreDatabase::new(database_path, writer_connection));
        self.open_run_store_databases_by_key
            .insert(run_store_key.to_string(), open_database.clone());
        Ok(open_database)
    }

    /// Create the store, or recreate it empty if it exists (a fresh file, so a cleared store
    /// doesn't keep a large file's pages). Refused with 507 when the OTHER `le-` dirs already use
    /// the whole byte budget — the run fails its first step instead of filling the data disk.
    pub fn create_or_clear_run_store(
        &self,
        staging_dir: &StdPath,
        run_store_key: &str,
    ) -> Result<CreatedRunStore, AppError> {
        validate_run_store_key(run_store_key)?;
        let _lifecycle_guard = lock_ignoring_poison(&self.lifecycle_lock);

        let other_run_store_dir_sizes = sizes_of_other_run_store_dirs(staging_dir, run_store_key);
        let bytes_in_use_by_other_run_stores: i64 = other_run_store_dir_sizes.iter().sum();
        if bytes_in_use_by_other_run_stores.max(0) as u64 >= self.max_bytes {
            return Err(AppError::insufficient_storage(format!(
                "Live Export run store budget exhausted: {} other run store(s) already use {} bytes of the \
                 {}-byte budget (GIT_LE_RUN_STORE_MAX_BYTES); refusing to create '{}'",
                other_run_store_dir_sizes.len(),
                bytes_in_use_by_other_run_stores,
                self.max_bytes,
                run_store_key
            )));
        }

        self.evict_cached_connections(run_store_key);
        let run_store_dir = staging_dir.join(run_store_key);
        let run_store_already_existed = run_store_dir.exists();
        if run_store_already_existed {
            remove_staging_dir_with_retry(&run_store_dir)
                .map_err(|e| AppError::internal(format!("Failed to clear run store: {}", e)))?;
        }
        std::fs::create_dir_all(&run_store_dir)
            .map_err(|e| AppError::internal(format!("Failed to create run store dir: {}", e)))?;

        let database_path = Self::run_store_database_path(staging_dir, run_store_key);
        let writer_connection = open_run_store_connection(&database_path, true)
            .map_err(sqlite_error("failed to create database"))?;
        writer_connection
            .execute_batch(RUN_STORE_DATABASE_SCHEMA_SQL)
            .map_err(sqlite_error("failed to create schema"))?;
        self.open_run_store_databases_by_key.insert(
            run_store_key.to_string(),
            Arc::new(OpenRunStoreDatabase::new(database_path, writer_connection)),
        );

        Ok(CreatedRunStore {
            key: run_store_key.to_string(),
            cleared: run_store_already_existed,
            bytes_in_use_by_other_run_stores,
            run_store_max_bytes: self.max_bytes,
        })
    }

    /// Delete the store's directory (database, WAL and all). Deleting a missing store succeeds;
    /// returns whether there was anything to delete.
    pub fn delete_run_store(
        &self,
        staging_dir: &StdPath,
        run_store_key: &str,
    ) -> Result<bool, AppError> {
        validate_run_store_key(run_store_key)?;
        let _lifecycle_guard = lock_ignoring_poison(&self.lifecycle_lock);
        self.evict_cached_connections(run_store_key);
        let run_store_dir = staging_dir.join(run_store_key);
        if !run_store_dir.exists() {
            return Ok(false);
        }
        remove_staging_dir_with_retry(&run_store_dir)
            .map_err(|e| AppError::internal(format!("Failed to delete run store: {}", e)))?;
        Ok(true)
    }

    /// Summary of an existing store; `Ok(None)` when it doesn't exist.
    pub fn summarize_run_store(
        &self,
        staging_dir: &StdPath,
        run_store_key: &str,
    ) -> Result<Option<RunStoreSummary>, AppError> {
        validate_run_store_key(run_store_key)?;
        let open_database = match self.open_existing_run_store(staging_dir, run_store_key) {
            Ok(open_database) => open_database,
            Err(AppError::NotFound(_)) => return Ok(None),
            Err(error) => return Err(error),
        };
        let collections = open_database.read(|transaction| summarize_collections(transaction))?;
        Ok(Some(RunStoreSummary {
            key: run_store_key.to_string(),
            collections,
        }))
    }
}

// ---------------------------------------------------------------------------
// Operations on an open store (called inside `OpenRunStoreDatabase::read` / `write`)
// ---------------------------------------------------------------------------

/// Every non-empty collection with its entry count and total body bytes, by collection name.
pub fn summarize_collections(
    connection: &Connection,
) -> Result<Vec<RunStoreCollectionSummary>, AppError> {
    let mut statement = connection
        .prepare(
            "SELECT collection, COUNT(*), COALESCE(SUM(body_bytes), 0) FROM entries \
             GROUP BY collection ORDER BY collection",
        )
        .map_err(sqlite_error("failed to prepare summary"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(RunStoreCollectionSummary {
                collection: row.get(0)?,
                entry_count: row.get(1)?,
                body_bytes: row.get(2)?,
            })
        })
        .map_err(sqlite_error("failed to summarize"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sqlite_error("failed to summarize"))
}

/// The stored meta text for an entry being put: `{}` when omitted/null; must be a JSON object.
fn meta_text_to_store(entry: &RunStoreEntryToPut) -> Result<&str, AppError> {
    let Some(meta) = &entry.meta else {
        return Ok("{}");
    };
    let meta_text = meta.get();
    if !meta_text.trim_start().starts_with('{') {
        return Err(AppError::bad_request(format!(
            "Run store entry '{}': meta must be a JSON object",
            entry.key
        )));
    }
    Ok(meta_text)
}

/// Insert or replace every entry (whole entry: meta and body) with one prepared statement.
pub fn put_entries(
    transaction: &rusqlite::Transaction,
    collection: &str,
    entries: &[RunStoreEntryToPut],
) -> Result<usize, AppError> {
    let mut statement = transaction
        .prepare_cached(
            "INSERT OR REPLACE INTO entries (collection, key, meta, body_bytes, body) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .map_err(sqlite_error("failed to prepare put"))?;
    for entry in entries {
        let meta_text = meta_text_to_store(entry)?;
        let body_bytes = entry.body.as_ref().map(|body| body.len()).unwrap_or(0) as i64;
        statement
            .execute(params![
                collection, entry.key, meta_text, body_bytes, entry.body
            ])
            .map_err(sqlite_error("failed to put entry"))?;
    }
    Ok(entries.len())
}

fn stored_meta_to_raw_value(key: &str, meta_text: String) -> Result<Box<RawValue>, AppError> {
    RawValue::from_string(meta_text).map_err(|e| {
        AppError::internal(format!(
            "Run store entry '{}' has unreadable meta: {}",
            key, e
        ))
    })
}

/// Read one entry row laid out as `key, meta[, body]`.
fn entry_from_row(row: &rusqlite::Row, include_bodies: bool) -> rusqlite::Result<RawEntryRow> {
    Ok(RawEntryRow {
        key: row.get(0)?,
        meta_text: row.get(1)?,
        body: if include_bodies {
            Some(row.get(2)?)
        } else {
            None
        },
    })
}

struct RawEntryRow {
    key: String,
    meta_text: String,
    body: Option<Option<String>>,
}

impl RawEntryRow {
    fn into_entry(self) -> Result<RunStoreEntry, AppError> {
        Ok(RunStoreEntry {
            meta: stored_meta_to_raw_value(&self.key, self.meta_text)?,
            key: self.key,
            body: self.body,
        })
    }
}

/// One page in ascending key order (BINARY collation: UTF-8 byte order), strictly after
/// `after_key`. `next_after_key` is the page's last key when more entries follow.
pub fn read_entries_page(
    connection: &Connection,
    collection: &str,
    after_key: Option<&str>,
    limit: usize,
    include_bodies: bool,
) -> Result<RunStoreEntriesPage, AppError> {
    let selected_columns = if include_bodies {
        "key, meta, body"
    } else {
        "key, meta"
    };
    // Two statements rather than `(?2 IS NULL OR key > ?2)`, which would defeat the range scan.
    let sql = match after_key {
        Some(_) => format!(
            "SELECT {selected_columns} FROM entries WHERE collection = ?1 AND key > ?2 \
             ORDER BY key LIMIT ?3"
        ),
        None => format!(
            "SELECT {selected_columns} FROM entries WHERE collection = ?1 \
             ORDER BY key LIMIT ?2"
        ),
    };
    let mut statement = connection
        .prepare_cached(&sql)
        .map_err(sqlite_error("failed to prepare page read"))?;
    // One extra row tells us whether another page follows.
    let limit_plus_one = (limit + 1) as i64;
    let map_row = |row: &rusqlite::Row| entry_from_row(row, include_bodies);
    let rows: Vec<RawEntryRow> = match after_key {
        Some(after_key) => statement
            .query_map(params![collection, after_key, limit_plus_one], map_row)
            .and_then(|rows| rows.collect()),
        None => statement
            .query_map(params![collection, limit_plus_one], map_row)
            .and_then(|rows| rows.collect()),
    }
    .map_err(sqlite_error("failed to read page"))?;

    let has_more_entries = rows.len() > limit;
    let entries = rows
        .into_iter()
        .take(limit)
        .map(RawEntryRow::into_entry)
        .collect::<Result<Vec<_>, _>>()?;
    let next_after_key = if has_more_entries {
        entries.last().map(|entry| entry.key.clone())
    } else {
        None
    };
    Ok(RunStoreEntriesPage {
        entries,
        next_after_key,
    })
}

/// The entries with these keys, in request order (duplicates repeat); absent keys are listed in
/// `missing_keys`, also in request order.
pub fn read_entries_by_keys(
    connection: &Connection,
    collection: &str,
    keys: &[String],
    include_bodies: bool,
) -> Result<RunStoreEntriesByKeys, AppError> {
    let sql = if include_bodies {
        "SELECT key, meta, body FROM entries WHERE collection = ?1 AND key = ?2"
    } else {
        "SELECT key, meta FROM entries WHERE collection = ?1 AND key = ?2"
    };
    let mut statement = connection
        .prepare_cached(sql)
        .map_err(sqlite_error("failed to prepare read by keys"))?;
    let mut entries = Vec::with_capacity(keys.len());
    let mut missing_keys = Vec::new();
    for key in keys {
        let row = statement
            .query_row(params![collection, key], |row| {
                entry_from_row(row, include_bodies)
            })
            .optional()
            .map_err(sqlite_error("failed to read by key"))?;
        match row {
            Some(row) => entries.push(row.into_entry()?),
            None => missing_keys.push(key.clone()),
        }
    }
    Ok(RunStoreEntriesByKeys {
        entries,
        missing_keys,
    })
}

/// Shallow-merge each patch into its entry's meta: a field set to `null` is removed, any other
/// value replaces the field wholesale (nested objects are NOT merged — unlike SQLite's
/// `json_patch`, which is RFC 7396 recursive). Keys with no entry are returned.
pub fn patch_entry_meta(
    transaction: &rusqlite::Transaction,
    collection: &str,
    patches: &[RunStoreEntryMetaPatch],
) -> Result<Vec<String>, AppError> {
    let mut select_statement = transaction
        .prepare_cached("SELECT meta FROM entries WHERE collection = ?1 AND key = ?2")
        .map_err(sqlite_error("failed to prepare meta read"))?;
    let mut update_statement = transaction
        .prepare_cached("UPDATE entries SET meta = ?3 WHERE collection = ?1 AND key = ?2")
        .map_err(sqlite_error("failed to prepare meta update"))?;
    let mut missing_keys = Vec::new();
    for patch in patches {
        let stored_meta_text: Option<String> = select_statement
            .query_row(params![collection, patch.key], |row| row.get(0))
            .optional()
            .map_err(sqlite_error("failed to read meta"))?;
        let Some(stored_meta_text) = stored_meta_text else {
            missing_keys.push(patch.key.clone());
            continue;
        };
        let mut meta: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(&stored_meta_text).map_err(|e| {
                AppError::internal(format!(
                    "Run store entry '{}' has unreadable meta: {}",
                    patch.key, e
                ))
            })?;
        for (field, value) in &patch.meta_patch {
            if value.is_null() {
                meta.shift_remove(field);
            } else {
                meta.insert(field.clone(), value.clone());
            }
        }
        let patched_meta_text = serde_json::to_string(&meta)
            .map_err(|e| AppError::internal(format!("Failed to serialize meta: {}", e)))?;
        update_statement
            .execute(params![collection, patch.key, patched_meta_text])
            .map_err(sqlite_error("failed to update meta"))?;
    }
    Ok(missing_keys)
}

/// Move every entry of `from_collection` into `to_collection` (replacing same-key entries) and
/// empty `from_collection`, in the caller's transaction. Returns the number of entries moved.
pub fn merge_collection_into(
    transaction: &rusqlite::Transaction,
    from_collection: &str,
    to_collection: &str,
) -> Result<usize, AppError> {
    if from_collection == to_collection {
        return Err(AppError::bad_request(format!(
            "Cannot merge run store collection '{}' into itself",
            from_collection
        )));
    }
    transaction
        .execute(
            "INSERT OR REPLACE INTO entries (collection, key, meta, body_bytes, body) \
             SELECT ?2, key, meta, body_bytes, body FROM entries WHERE collection = ?1",
            params![from_collection, to_collection],
        )
        .map_err(sqlite_error("failed to merge collections"))?;
    transaction
        .execute(
            "DELETE FROM entries WHERE collection = ?1",
            params![from_collection],
        )
        .map_err(sqlite_error("failed to empty merged collection"))
}

/// Remove every entry of a collection. Returns the number removed.
pub fn delete_collection(
    transaction: &rusqlite::Transaction,
    collection: &str,
) -> Result<usize, AppError> {
    transaction
        .execute(
            "DELETE FROM entries WHERE collection = ?1",
            params![collection],
        )
        .map_err(sqlite_error("failed to delete collection"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_store_key_validation() {
        assert!(validate_run_store_key("le-rrn_abc123XYZ").is_ok());
        assert!(validate_run_store_key("le-a-b_c").is_ok());
        assert!(validate_run_store_key("le-").is_err());
        assert!(validate_run_store_key("rrn_abc").is_err());
        assert!(validate_run_store_key("le-../etc").is_err());
        assert!(validate_run_store_key("le-a/b").is_err());
        assert!(validate_run_store_key(&format!("le-{}", "a".repeat(128))).is_ok());
        assert!(validate_run_store_key(&format!("le-{}", "a".repeat(129))).is_err());
    }

    #[test]
    fn collection_name_validation() {
        assert!(validate_collection_name("source:Products.v1_x-y").is_ok());
        assert!(validate_collection_name(&"a".repeat(200)).is_ok());
        assert!(validate_collection_name(&"a".repeat(201)).is_err());
        assert!(validate_collection_name("").is_err());
        assert!(validate_collection_name(".").is_err());
        assert!(validate_collection_name("..").is_err());
        assert!(validate_collection_name("a/b").is_err());
        assert!(validate_collection_name("a b").is_err());
        assert!(validate_collection_name("é").is_err());
    }
}
