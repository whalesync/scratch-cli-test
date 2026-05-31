/* Hand-maintained for slice H.2 — napi-rs v3 + napi-derive `type-def` did
 * not produce output in our workspace setup. Regenerate / replace with
 * autogen in H.3 if the autogen story improves. Keep this file in sync with
 * `src/lib.rs` exports.
 */

export interface ReviewOpResult {
  workspacePath: string;
  patchesChanged: boolean;
  workingChanged: boolean;
  /** Coarse "what happened" tag. Pattern-match on this in the renderer. */
  effect: 'NoOp' | 'PatchUpserted' | 'PatchDropped' | 'WorkingRestored';
}

/**
 * Accept the working file's current value for `field` on `recordRelPath`
 * under `connectionDirName` inside `workspaceDir`. The caller must have
 * already written the user's typed value to the working file before
 * invoking this — the binding reads from disk. Updates
 * `accepted-patches.json` atomically; the working file itself is not
 * touched.
 *
 * Errors come through as `Error` instances whose `message` is prefixed with
 * a stable code: `"<CODE>: <human description>"`. Known codes:
 *
 *   - `LOCK_BUSY`               — workspace lock held by another process
 *   - `WORKSPACE_NOT_FOUND`     — no `.scratchmd` marker at `workspaceDir/.scratch/`
 *   - `UNKNOWN_CONNECTION`      — `connectionDirName` not in the workspace marker
 *   - `NOT_A_RECORD_PATH`       — `recordRelPath` isn't a data record path
 *   - `WORKING_FILE_MISSING`    — there's no file at `<conn>/<recordRelPath>` to read from
 *   - `INVALID_JSON`            — main blob or working file isn't parseable JSON
 *   - `INTERNAL`                — any other I/O or unexpected error
 *
 * Why not `err.code`: napi-rs 2.x reserves `err.code` for napi `Status` and
 * doesn't let Rust override it. The desktop shim parses the message prefix.
 */
export function acceptField(
  workspaceDir: string,
  connectionDirName: string,
  recordRelPath: string,
  field: string,
): Promise<ReviewOpResult>;

/**
 * Reject the unreviewed working-tree edit for `field` on `recordRelPath`.
 * Restores the working file's field value to the approved value (the patch
 * entry's value if present, else `refs/heads/main`) WITHOUT touching
 * `accepted-patches.json`. Strict invariant: Reject never mutates the patch
 * file. Use `discardField` when the caller also wants to drop an existing
 * approved patch entry.
 *
 * Same error-prefix convention as `acceptField`.
 */
export function rejectField(
  workspaceDir: string,
  connectionDirName: string,
  recordRelPath: string,
  field: string,
): Promise<ReviewOpResult>;

/**
 * Discard the pending change for `field` on `recordRelPath`. Drops the field
 * from any `accepted-patches.json` entry AND restores the working file's
 * value for that field to whatever `refs/heads/main` says. Stripping the
 * last field from a `Create` entry removes the entry and the working file.
 * `Delete` entries are no-ops at the field level.
 *
 * Same error-prefix convention as `acceptField`.
 */
export function discardField(
  workspaceDir: string,
  connectionDirName: string,
  recordRelPath: string,
  field: string,
): Promise<ReviewOpResult>;

/**
 * One record file in a folder, returned by {@link readFolderBlobs}. `published`
 * is `null` when the file isn't on `refs/heads/main` yet (= new record);
 * `approved` is `null` when the accepted-patches.json entry is a `Delete`.
 */
export interface FolderBlob {
  filename: string;
  published: string | null;
  approved: string | null;
}

/**
 * Read `(published, approved)` content for every record file directly inside
 * `<workspaceDir>/<connectionDirName>/<folderRelPath>/`. Non-recursive —
 * subfolders are excluded. Empty `folderRelPath` is the connection root.
 *
 * Drives the desktop's grid-view diff status. The desktop reads the working
 * version itself from disk; this binding supplies the other two sides of the
 * three-way comparison.
 *
 * No lock acquired (reads only). Errors come through with the same prefixed-
 * message convention as `acceptField`. Codes: `WORKSPACE_NOT_FOUND`,
 * `UNKNOWN_CONNECTION`, `INVALID_JSON`, `INTERNAL`.
 */
export function readFolderBlobs(
  workspaceDir: string,
  connectionDirName: string,
  folderRelPath: string,
): Promise<FolderBlob[]>;

/**
 * Filtered variant of {@link readFolderBlobs} — returns only entries whose
 * `filename` is in `filenames`. Filenames the folder doesn't have are
 * silently dropped. Empty `filenames` short-circuits to `[]` before opening
 * the bare repo.
 *
 * Use from paginated grid renderers and single-record diff views to bound
 * Electron main-process memory at the page size instead of loading the
 * entire folder's content. Same error contract as `readFolderBlobs`.
 */
export function readFolderBlobsFiltered(
  workspaceDir: string,
  connectionDirName: string,
  folderRelPath: string,
  filenames: string[],
): Promise<FolderBlob[]>;

/**
 * List record filenames directly inside the folder (the union of `refs/heads/main`
 * paths and `accepted-patches.json` entries), sorted lexicographically. Returns
 * just the names — no blob content is read, so this is sub-second on 22k+
 * record folders where `readFolderBlobs` would be tens of seconds.
 *
 * Use from filename-only consumers (`findRecordOffset`, scroll-to-record).
 * Same error contract as `readFolderBlobs`. No lock is acquired (reads only).
 */
export function listFolderFilenames(
  workspaceDir: string,
  connectionDirName: string,
  folderRelPath: string,
): Promise<string[]>;

// ─── Stats + refresh — sidebar dot subsystem ──────────────────────────────
//
// Powers the desktop folder-tree sidebar's "Needs review" (blue) and
// "Approved" (gray) dots plus the existing validation dots. Migrated from
// `runScratchmd*` CLI shell-out to eliminate ~10–20 ms spawn cost per call
// — see `docs/plans/2026-05-31-folder-tree-review-approved-dots.md`.
//
// All three return JSON-shaped objects with snake_case keys to preserve the
// long-standing TS `ValidationStat` shape consumed by
// `PublishChangesModal.handleViewProblems`, `ValidationStatsDrawer`, and
// `WorkspaceSidebar`'s `${connection}/${folder_path}` Map key.

/**
 * One folder's review-state counts. Emitted by {@link getReviewStats}.
 *
 * `folder_path` is the workspace-relative path with the connection directory
 * prefix stripped (e.g. `"Posts"` inside the `"HubSpot"` connection).
 */
export interface ReviewStat {
  connection: string;
  folder_path: string;
  /** Files where the working copy differs from the approved (post-patch) version. */
  unreviewed: number;
  /** Files with an entry in accepted-patches.json (approved but not yet published). */
  approved: number;
}

/**
 * One folder's validation-results counts. Emitted by {@link getValidationStats}.
 *
 * Mirrors the existing TypeScript `ValidationStat` shape (snake_case) so this
 * is a drop-in replacement for the prior `runScratchmdJson(['validation',
 * 'get-stats'])` shell-out.
 */
export interface ValidationStat {
  connection: string;
  folder_path: string;
  /** Distinct files with at least one `level=error` problem. */
  errors: number;
  /** Distinct files with at least one `level=warning` problem. */
  warnings: number;
  /** Distinct files with at least one problem of any level. */
  records: number;
}

/**
 * Result of {@link refreshFolder}. Counts of files actually re-read during
 * the smart mtime-aware refresh. `validated` is always omitted (the napi
 * surface calls refresh with `validate=false`).
 */
export interface RefreshFolderResult {
  /** Files reindexed against working + dirty + master tree (base row + all column values). */
  base_refreshed: number;
  /** Files where only active field-column values were stale. */
  columns_refreshed: number;
  /** Omitted (validate=false). */
  validated?: number;
}

/**
 * Workspace-wide per-folder counts of `(unreviewed, approved)` records.
 *
 * For every connection in `<workspaceDir>/.scratch/.scratchmd`, walks the
 * on-disk data folder tree and reads the persisted bit columns from each
 * folder's SQLite index. Folders whose counts are both zero are omitted.
 * Folders that haven't been indexed yet are skipped — call
 * {@link refreshFolder} first if you need fresh bits.
 *
 * Throws an `Error` whose message is prefixed with `INTERNAL:` (workspace
 * marker missing/unreadable, SQLite failure, etc.). No `LOCK_BUSY` — reads
 * don't acquire the workspace lock.
 */
export function getReviewStats(workspaceDir: string): Promise<ReviewStat[]>;

/**
 * Workspace-wide per-folder validation-results counts.
 *
 * Reads from each connection's shared `validation_results__vN` SQLite table.
 * Migrated from the `scratchmd validation get-stats` CLI shell-out;
 * preserves the existing TS contract byte-for-byte.
 *
 * Throws an `Error` whose message is prefixed with `INTERNAL:`. No
 * `LOCK_BUSY`.
 */
export function getValidationStats(workspaceDir: string): Promise<ValidationStat[]>;

/**
 * Refresh one folder's index so the bits surfaced by {@link getReviewStats}
 * are current. Mtime-aware: only files whose working-tree timestamp changed
 * are re-read. A fully fresh folder finishes in a few ms; an N-file change
 * batch is ~N JSON reads.
 *
 * `folder` is the workspace-relative `<connection>/<sub_path>` shape used
 * throughout `folder_index` (e.g. `"HubSpot/Posts"`).
 *
 * Throws an `Error` whose message is prefixed with `INTERNAL:`. No
 * `LOCK_BUSY` — writes to the per-connection index DB under
 * `<workspace>/.repos/`, outside the workspace lock's scope.
 */
export function refreshFolder(workspaceDir: string, folder: string): Promise<RefreshFolderResult>;
