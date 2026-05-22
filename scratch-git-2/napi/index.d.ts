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
