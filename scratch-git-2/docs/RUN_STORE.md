# Live Export run store (`/api/run-store`, `le-<routineRunId>`)

A **run store** is a disposable key/value store that one Live Export routine run
(`Workbook.managedBy === ws_export`) uses instead of git and Postgres for every per-record byte it works
on: pulled source and destination records, table specs, match keys, the publish plan. It is one SQLite
database per run, hosted by scratch-git and reached over HTTP by the server's `HttpRunStoreClient`
(`server/src/live-export-run-store/http-run-store-client.ts`). Design and motivation:
[`docs/plans/2026-09-25-live-export-git-free-run-store/`](../../docs/plans/2026-09-25-live-export-git-free-run-store/2026-09-25-live-export-git-free-run-store.md).

**No git object is ever created for a run store.** Code: storage in `src/service/run_store.rs`, HTTP
routes in `src/service/routes/run_store.rs`.

The store is deliberately **generic**: it knows nothing about records, plans or folders. It holds named
**collections**; each collection is an ordered map of string keys to entries, and an entry is a small
JSON `meta` object plus an optional `body` string. The server's Live Export adapters (pull sink, sync
ports, publish plan store, table spec store) are all built from the same few operations, so this side
stays a small, well-tested key/value store and the per-record logic stays in the server.

## Key and layout

The store key is always `le-<routineRunId>`, e.g. `le-rrn_AdVkcKA70W`: `le-` followed by 1–128
characters of `[A-Za-z0-9_-]` (anything else is a 400). The RoutineRun id is used, not a job's `run_…`
RunContext id, because it stays the same when the routine executor re-enters a run after a redeploy;
every child job carries it in `runContext.routineRunId`.

```
{staging_dir}/le-<routineRunId>/
  run.db        the SQLite database (WAL mode)
  run.db-wal    its write-ahead log (truncated back to ≤ 64 MB after checkpoints)
  run.db-shm
```

The store lives **inside the staging dir** on purpose, beside the pull/sync staging dirs (`job_…`,
`sync-…`): `GET /api/staging` lists it with its size, `DELETE /api/staging/{key}` deletes it, and both
reapers (below) see it.

## Why one SQLite file per run

- **Deleting a run is deleting one directory of three files.** The first design wrote one JSON file per
  record; a 310k-record run meant ~600k files, and `DELETE /api/staging/{key}` took 33–42 s to unlink
  them. Dropping a run store is milliseconds (measured: 30–40 ms for 200k × 4 KB entries).
- **Bulk writes are one transaction.** A 5,000-entry batch is one `BEGIN IMMEDIATE` … `COMMIT` with a
  cached prepared statement — no per-file `open`/`write`/`fsync`/directory updates.
- **Paged reads are range scans.** The table is `WITHOUT ROWID` with primary key `(collection, key)`, so
  a page in key order is a b-tree range scan, never a sort, and a keys-only read never touches bodies.
- **The footprint is measurable.** One file per run makes the byte budget check a directory size.

## Schema

```sql
CREATE TABLE entries (
    collection TEXT NOT NULL,
    key        TEXT NOT NULL,
    meta       TEXT NOT NULL DEFAULT '{}',   -- a JSON object
    body_bytes INTEGER NOT NULL DEFAULT 0,   -- UTF-8 byte length of body (0 when none)
    body       TEXT,                         -- NULL = no body
    PRIMARY KEY (collection, key)
) WITHOUT ROWID;
```

`body` is the **last** column on purpose. In a `WITHOUT ROWID` table a row is stored as the primary key
followed by the other columns in declaration order, and a multi-KB body spills to overflow pages. With
the body last, reading keys + meta (`includeBodies=false`) and the summary's `SUM(body_bytes)` never
follow those overflow chains (measured: keys+meta of 100k entries in ~0.2 s versus ~1.5 s with bodies).

Keys compare with SQLite's default `BINARY` collation — **UTF-8 byte order**, which equals Unicode code
point order. This is *not* JavaScript's default string order (UTF-16 code units), which differs for keys
that mix astral characters (emoji) with U+E000–U+FFFF. The server exports `compareRunStoreKeys` for
sorting in the store's order, and `InMemoryRunStoreClient` uses it.

**Connections.** Each open store keeps one writer connection (every write is one `BEGIN IMMEDIATE`
transaction) and up to four idle reader connections (WAL lets reads run alongside a write), cached in
`AppState::run_store` (`RunStoreState`) behind mutexes. All database work runs on tokio's blocking pool
(`spawn_blocking`). Pragmas: `journal_mode=WAL`, `synchronous=NORMAL` (a crash can lose the last
transactions but never corrupts the file — acceptable for a store a failed run simply recreates),
`busy_timeout=30s`, `cache_size` 32 MiB, `journal_size_limit` 64 MB, `temp_store=MEMORY`.

Create/clear, delete and a store's first open are serialized by a lifecycle lock, and **clearing or
deleting a store drops its cached connections first** — with `SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE` so no
time is spent checkpointing a WAL that is about to be deleted. A store is never re-opened with
`SQLITE_OPEN_CREATE` outside create, so a write to a deleted store is a 404, never a silent write into a
fresh or unlinked file. `DELETE /api/staging/{key}` on an `le-` key goes through the same path.

## Endpoints

All routes are on the `:3100` API behind the same bearer-token auth as the rest of it. Responses use the
standard `{ data, status }` envelope; the shapes below show `data`. **Every endpoint except create,
delete and summary answers 404 when the store doesn't exist** (never created, or already deleted), so a
write can't skip the create-time budget check; the server client maps that 404 to
`RunStoreNotFoundError`.

Collection names are URL path segments: 1–200 characters of `[A-Za-z0-9_.:-]`, not `.` or `..` (400
otherwise). Clients percent-encode them (`encodeURIComponent`; `:` becomes `%3A`). Entry keys are
arbitrary UTF-8 strings and travel only in JSON bodies and the `afterKey` query parameter.

| method | path | request | response `data` |
|---|---|---|---|
| `POST` | `/api/run-store/{key}` | — | `{ key, cleared, bytesInUseByOtherRunStores, runStoreMaxBytes }` |
| `DELETE` | `/api/run-store/{key}` | — | `{ deleted }` (false when missing — still 200) |
| `GET` | `/api/run-store/{key}` | — | `{ key, collections: [{ collection, entryCount, bodyBytes }] }`, 404 when missing |
| `POST` | `/api/run-store/{key}/collections/{collection}/entries` | `{ entries: [{ key, meta?, body? }] }` | `{ written }` |
| `GET` | `/api/run-store/{key}/collections/{collection}/entries?afterKey=&limit=&includeBodies=` | — | `{ entries: [{ key, meta, body? }], nextAfterKey }` |
| `POST` | `/api/run-store/{key}/collections/{collection}/entries/by-keys` | `{ keys, includeBodies }` | `{ entries, missingKeys }` |
| `POST` | `/api/run-store/{key}/collections/{collection}/entries/patch-meta` | `{ patches: [{ key, metaPatch }] }` | `{ missingKeys }` |
| `POST` | `/api/run-store/{key}/collections/{from}/merge-into/{to}` | — | `{ moved }` |
| `DELETE` | `/api/run-store/{key}/collections/{collection}` | — | `{ deleted }` (a count) |

Details:

- **Create or clear** is idempotent: an existing store is deleted and recreated as a fresh, empty file
  (`cleared: true`) so a retried first step converges and a cleared store doesn't keep a large file's
  pages. It is **refused with 507 Insufficient Storage** when the *other* `le-` dirs together already
  use `GIT_LE_RUN_STORE_MAX_BYTES` or more; the message names the budget. The server client maps it to
  `RunStoreBudgetExceededError`. The store being cleared doesn't count toward the total.
- **Summary** lists only non-empty collections, sorted by name; `bodyBytes` is the sum of UTF-8 body
  lengths. Computed with one `GROUP BY` over the table.
- **Put** inserts or replaces whole entries (meta *and* body) with one prepared statement in one
  transaction; later duplicates in the same call win. `meta` omitted or null is `{}` and must otherwise
  be a JSON object (400); `body` omitted or null means no body. `meta` is stored verbatim as sent.
- **Page read** returns entries in ascending key order strictly after `afterKey` (exclusive; omit it for
  the first page; `afterKey=` — the empty string — is a real cursor that excludes the `""` key). `limit`
  defaults to 1000 and must be 1–10000 (400 otherwise, never silently clamped). `nextAfterKey` is the
  page's last key when more entries follow, otherwise `null` — including when the final page is exactly
  full. `body` is present only with `includeBodies=true`, and then `null` for an entry without one. A
  missing collection is an empty page.
- **Read by keys** returns found entries in request order (duplicates repeat) and the absent keys in
  `missingKeys`, in one read transaction. At most 10000 keys (400).
- **Patch meta** shallow-merges each `metaPatch` into the entry's meta in one transaction: a field set to
  `null` is removed, any other value replaces the field wholesale. Nested objects are **not** merged
  (unlike SQLite's `json_patch`, which is RFC 7396-recursive, so the merge is done in Rust). Bodies are
  untouched; keys with no entry are listed in `missingKeys`.
- **Merge into** runs `INSERT OR REPLACE … SELECT` from `from` into `to` then deletes `from`, in one
  transaction: same-key entries in `to` are replaced wholesale, `from` ends empty, and `moved` is the
  number of entries moved. A missing or empty `from` is a no-op (`moved: 0`). `from == to` is a 400.
- **Delete collection** removes a collection's entries; a missing collection succeeds with 0.

## Throughput: body limit and compression

These routes are the hot path of every Live Export run — they move whole tables per request — so they
carry their own layers, scoped to the run store router:

- **Body limit 512 MB** (decompressed), versus the API-wide 50 MB. The route-level
  `DefaultBodyLimit` is the inner layer, so it wins over the global one.
- **gzip request bodies**: send `Content-Encoding: gzip` (tower-http `RequestDecompressionLayer`). The
  server client gzips bodies of 64 KB or more at level 1.
- **gzip responses** when the client sends `Accept-Encoding: gzip` (`CompressionLayer`, fastest level).
  Node's `fetch` decompresses transparently.

Record JSON compresses about 5×: in the benchmark below, 445 MB of request JSON went over the wire as
85 MB. On loopback gzip costs a little CPU time; across the VPC it saves most of the transfer.

**Measured** (MacBook, release build, 100,000 entries with ~4 KB connector-shaped JSON bodies = 404 MB,
5,000 entries per request):

| path | no compression | gzip |
|---|---|---|
| in-process (router `oneshot`, `cargo test --release run_store_throughput_benchmark -- --ignored --nocapture`): write | 2.2–2.5 s (40–45k entries/s) | 3.3–4.1 s |
| in-process: read with bodies | 1.3–1.7 s (60–75k entries/s) | 3.1–3.5 s (incl. client gunzip) |
| in-process: read keys + meta | 0.2 s | 0.2 s |
| over HTTP from Node (`HttpRunStoreClient`, loopback; see the integration spec): write, sequential | 3.0 s (33k entries/s) | 3.7 s |
| over HTTP: read with bodies, sequential | 1.6 s (62k entries/s) | 1.9 s |
| over HTTP: write, 4 collections in parallel | 2.6 s | 2.8 s |
| over HTTP: read with bodies, 4 collections in parallel | 0.9 s (106k entries/s) | 1.3 s |
| delete a store holding 2 × 100k entries | 30–40 ms | |

The 310k-record prod workbook therefore moves each full pass in roughly 5–10 s of run store time,
against minutes for the classic staging + git path.

## Lifecycle

1. **Create.** The run's first step creates (or clears) the store. If the budget is exhausted, the step
   fails with scratch-git's message (`RunStoreBudgetExceededError`).
2. **Fill and read.** The pulls, sync and publish read and write collections through the endpoints above.
3. **Normal end.** The publish job deletes the store in its `finally`.
4. **Failed or cancelled run.** The routine executor deletes it when the run reaches a terminal status.
5. **Orphans.** The server's hourly `StagingDirReaperService`
   (`server/src/cron/staging-dir-reaper.service.ts`) handles `le-` dirs:
   - a dir is **live** while its RoutineRun (`le-<routineRunId>`) exists and is non-terminal
     (`TERMINAL_ROUTINE_RUN_STATUSES` in `server/src/routine/routine.types.ts`); anything else under
     `le-` — no such RoutineRun, or not an `rrn_…` id — is dead;
   - a dead dir older than **24 h** is reaped (pull/sync dirs keep 72 h);
   - **byte budget:** when all `le-` dirs together exceed `runStoreMaxBytes` (reported by
     `GET /api/staging`), the oldest dead dirs are deleted first, whatever their age; if the total is
     still over, it logs an error;
   - the sweep's summary log line includes the `le-` count and footprint, and it emits the
     `scratch_git_run_store_bytes` gauge.
6. **Boot backstop.** `reap_stale_staging_dirs` runs at scratch-git startup and reaps `le-` dirs older
   than 24 h (`RUN_STORE_STAGING_REAP_MAX_AGE`); other dirs use `GIT_STAGING_REAP_MAX_AGE_HOURS` (72 h).

A staging dir's age is the newest mtime of the dir **and its immediate child files**: a run store's
`run.db` / `run.db-wal` are modified in place and never add directory entries, so the directory's own
mtime alone would make a busy store look as old as its creation.

Writes don't re-check the budget (summing every `le-` dir on each write would cost too much). A run that
grows past the budget mid-run is caught by the hourly reaper's error log and the gauge.

## Configuration

| env var | default | meaning |
|---|---|---|
| `GIT_LE_RUN_STORE_MAX_BYTES` | `5368709120` (5 GiB) | Total on-disk budget for every `le-` dir together. Creating a store is refused (507) while the other stores already use this much. `GET /api/staging` reports it as `runStoreMaxBytes` so the server reaper enforces the same number. |

## Testing

- Rust: `cargo test --bin scratch-git-2 run_store` (routes and storage, via the real router with
  `tower::ServiceExt::oneshot`), plus the ignored benchmark above.
- Server: the shared contract suite `server/src/live-export-run-store/__tests__/run-store-client.contract.ts`
  runs against `InMemoryRunStoreClient` (unit) and against `HttpRunStoreClient` talking to a scratch-git
  the integration spec starts itself on ephemeral ports
  (`server/test/integration/http-run-store-client.spec.ts`; build the binary first with
  `cargo build --release`). Set `RUN_STORE_HTTP_BENCHMARK=1` to run the HTTP benchmark.
- Bruno: `tools/bruno/Scratch Git Service - Run Store/`.
