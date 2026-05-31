/**
 * Loader for the scratchmd-native cdylib (slice H.2 of DEV-10144). Resolves
 * the platform-correct `.node` between two locations:
 *
 *   - **Packaged**: `Resources/bin/scratchmd-native.<platform>-<arch>[-<abi>].node`
 *     bundled by electron-builder's `extraResources` glob (see `electron-builder.yml`).
 *   - **Dev** (`yarn dev`): `<repoRoot>/scratch-git-2/napi/scratchmd-native.<platform>-<arch>[-<abi>].node`,
 *     produced by `scratch-desktop/scripts/build-native.sh` (wired into
 *     `predev` so `yarn dev` rebuilds it automatically).
 *
 * No IPC handlers consume this yet — slice H.3 wires the three cell-edit
 * handlers (`acceptUnreviewedFieldEdit`, `acceptFieldEditFromInputText`, `dropApprovedFieldAndRestoreToMain`)
 * in `local-files.ts` to call `acceptField` / (later) `discardField` through
 * this module.
 */

import { app } from 'electron';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';

import type {
  FolderBlob,
  RefreshFolderResult,
  ReviewOpResult,
  ReviewStat,
  ValidationStat,
} from '../../../../scratch-git-2/napi/index.d.ts';

const requireNative = createRequire(__filename);

function nativeBinaryFilename(): string {
  const platform = process.platform; // 'darwin' | 'linux' | 'win32'
  const arch = process.arch; // 'arm64' | 'x64'
  const abi = platform === 'linux' ? '-gnu' : '';
  return `scratchmd-native.${platform}-${arch}${abi}.node`;
}

function resolveNativeBinaryPath(): string {
  const filename = nativeBinaryFilename();
  if (!app.isPackaged) {
    // Dev: walk up from src/main/native to the repo root, then into the napi
    // crate. Matches the dev-path resolution `scratchmd.ts` uses for the
    // CLI binary (which sits in `target/debug/`).
    const repoRoot = resolve(app.getAppPath(), '..');
    return join(repoRoot, 'scratch-git-2', 'napi', filename);
  }
  // Packaged: electron-builder copies the .node into Resources/bin/.
  return join(process.resourcesPath, 'bin', filename);
}

let cached: NativeModule | undefined;

interface NativeModule {
  acceptField(
    workspaceDir: string,
    connectionDirName: string,
    recordRelPath: string,
    field: string,
  ): Promise<ReviewOpResult>;
  rejectField(
    workspaceDir: string,
    connectionDirName: string,
    recordRelPath: string,
    field: string,
  ): Promise<ReviewOpResult>;
  discardField(
    workspaceDir: string,
    connectionDirName: string,
    recordRelPath: string,
    field: string,
  ): Promise<ReviewOpResult>;
  readFolderBlobs(workspaceDir: string, connectionDirName: string, folderRelPath: string): Promise<FolderBlob[]>;
  readFolderBlobsFiltered(
    workspaceDir: string,
    connectionDirName: string,
    folderRelPath: string,
    filenames: string[],
  ): Promise<FolderBlob[]>;
  listFolderFilenames(workspaceDir: string, connectionDirName: string, folderRelPath: string): Promise<string[]>;
  getReviewStats(workspaceDir: string): Promise<ReviewStat[]>;
  getValidationStats(workspaceDir: string): Promise<ValidationStat[]>;
  refreshFolder(workspaceDir: string, folder: string): Promise<RefreshFolderResult>;
}

function loadNative(): NativeModule {
  if (cached) return cached;
  const path = resolveNativeBinaryPath();
  if (!existsSync(path)) {
    const hint = app.isPackaged
      ? 'Bundled scratchmd-native addon missing — app may be corrupted.'
      : 'scratchmd-native addon not found. Run scratch-desktop/scripts/build-native.sh to build it.';
    throw new Error(`${hint} Expected at: ${path}`);
  }
  cached = requireNative(path) as NativeModule;
  return cached;
}

/**
 * Codes the Rust binding can prefix onto an error's `message`. Use
 * `parseNativeErrorCode(err)` to extract the prefix without parsing string
 * shapes at every call site.
 */
export type NativeErrorCode =
  | 'LOCK_BUSY'
  | 'WORKSPACE_NOT_FOUND'
  | 'UNKNOWN_CONNECTION'
  | 'NOT_A_RECORD_PATH'
  | 'NOT_AN_APPROVED_DELETE'
  | 'NOT_AN_APPROVED_CREATE'
  | 'RESTORE_SOURCE_MISSING'
  | 'WORKING_FILE_MISSING'
  | 'CREATE_CLASHES_WITH_MAIN'
  | 'INVALID_JSON'
  | 'INTERNAL';

const KNOWN_CODES: readonly NativeErrorCode[] = [
  'LOCK_BUSY',
  'WORKSPACE_NOT_FOUND',
  'UNKNOWN_CONNECTION',
  'NOT_A_RECORD_PATH',
  'NOT_AN_APPROVED_DELETE',
  'NOT_AN_APPROVED_CREATE',
  'RESTORE_SOURCE_MISSING',
  'WORKING_FILE_MISSING',
  'CREATE_CLASHES_WITH_MAIN',
  'INVALID_JSON',
  'INTERNAL',
];

/**
 * Extract the structured code from a native binding error's message.
 *
 * napi-rs 2.x doesn't let Rust set a custom `err.code` (it's reserved for
 * the napi `Status` enum). The binding's convention is to prefix the human
 * message with `"<CODE>: <description>"`. This helper returns the code if
 * the message matches the convention, or `undefined` otherwise.
 */
export function parseNativeErrorCode(err: unknown): NativeErrorCode | undefined {
  if (err instanceof Error) {
    const idx = err.message.indexOf(':');
    if (idx > 0) {
      const candidate = err.message.slice(0, idx);
      if ((KNOWN_CODES as readonly string[]).includes(candidate)) {
        return candidate as NativeErrorCode;
      }
    }
  }
  return undefined;
}

/**
 * Accept the working file's current value for `field` on `recordRelPath`.
 * Caller must have written the new value to the working file BEFORE calling
 * this — the binding reads from disk and folds it into
 * `accepted-patches.json`. Lock contention surfaces with
 * `parseNativeErrorCode(err) === 'LOCK_BUSY'`.
 */
export async function acceptField(
  workspaceDir: string,
  connectionDirName: string,
  recordRelPath: string,
  field: string,
): Promise<ReviewOpResult> {
  return loadNative().acceptField(workspaceDir, connectionDirName, recordRelPath, field);
}

/**
 * Reject the unreviewed working-tree edit for `field` on `recordRelPath`.
 * Restores the working file's field value to the approved value WITHOUT
 * touching `accepted-patches.json`. Same error contract as `acceptField`.
 */
export async function rejectField(
  workspaceDir: string,
  connectionDirName: string,
  recordRelPath: string,
  field: string,
): Promise<ReviewOpResult> {
  return loadNative().rejectField(workspaceDir, connectionDirName, recordRelPath, field);
}

/**
 * Discard `field` on `recordRelPath`. Drops the field from any patch entry
 * AND restores the working file's value for that field to whatever `main`
 * says. Same error contract as `acceptField`.
 */
export async function discardField(
  workspaceDir: string,
  connectionDirName: string,
  recordRelPath: string,
  field: string,
): Promise<ReviewOpResult> {
  return loadNative().discardField(workspaceDir, connectionDirName, recordRelPath, field);
}

/**
 * Convert the `(workspacePath, folderPath, filename)` triple that the cell-
 * edit IPC handlers pass in into the `(connectionDirName, recordRelPath)`
 * pair the napi binding accepts.
 *
 * - `workspacePath` is the workspace root (absolute).
 * - `folderPath` is the data folder (`<workspace>/<conn>/<folder...>`, absolute).
 * - `filename` is the record file name (e.g. `"rec_acme.json"`).
 *
 * Returns `{ connectionDirName: "HubSpot", recordRelPath: "Companies/rec_acme.json" }`
 * for `workspacePath=/abs/workspace`, `folderPath=/abs/workspace/HubSpot/Companies`,
 * `filename="rec_acme.json"`. The repo-relative path inside the napi crate
 * (and in `accepted-patches.json`) is the part of the workspace-relative
 * folder path AFTER the connection name, joined with the filename.
 */
export function deriveRecordPaths(
  workspacePath: string,
  folderPath: string,
  filename: string,
): { connectionDirName: string; recordRelPath: string } {
  const workspaceRelativeFolder = relative(workspacePath, folderPath);
  if (workspaceRelativeFolder === '' || workspaceRelativeFolder.startsWith('..')) {
    throw new Error(
      `folderPath ${JSON.stringify(folderPath)} is not inside workspace ${JSON.stringify(workspacePath)}`,
    );
  }
  // Always use POSIX separators inside the workspace — `accepted-patches.json`
  // and the napi binding both expect `/`-joined repo-relative paths.
  const parts = workspaceRelativeFolder.split(/[\\/]/);
  const [connectionDirName, ...rest] = parts;
  const recordRelPath = [...rest, filename].join('/');
  return { connectionDirName, recordRelPath };
}

/**
 * Convenience wrapper for the cell-edit hot path. Takes the `(workspacePath,
 * folderPath, filename, fieldName)` shape the IPC handlers already have and
 * calls `acceptField` against the derived `(conn, recordRelPath)`. The
 * caller is responsible for writing the new value to the working file
 * BEFORE invoking this.
 */
export async function acceptCellField(args: {
  workspacePath: string;
  folderPath: string;
  filename: string;
  fieldName: string;
}): Promise<ReviewOpResult> {
  const { connectionDirName, recordRelPath } = deriveRecordPaths(args.workspacePath, args.folderPath, args.filename);
  return acceptField(args.workspacePath, connectionDirName, recordRelPath, args.fieldName);
}

/**
 * Reject-the-field analogue of `acceptCellField`. Used by the
 * `files:reject-cell-change` IPC handler. Restores the working file's field
 * value to the approved value without touching `accepted-patches.json`.
 */
export async function rejectCellField(args: {
  workspacePath: string;
  folderPath: string;
  filename: string;
  fieldName: string;
}): Promise<ReviewOpResult> {
  const { connectionDirName, recordRelPath } = deriveRecordPaths(args.workspacePath, args.folderPath, args.filename);
  return rejectField(args.workspacePath, connectionDirName, recordRelPath, args.fieldName);
}

/**
 * Discard-the-field analogue of `acceptCellField`. Used by the
 * `files:undo-approved-cell-change` IPC handler.
 */
export async function discardCellField(args: {
  workspacePath: string;
  folderPath: string;
  filename: string;
  fieldName: string;
}): Promise<ReviewOpResult> {
  const { connectionDirName, recordRelPath } = deriveRecordPaths(args.workspacePath, args.folderPath, args.filename);
  return discardField(args.workspacePath, connectionDirName, recordRelPath, args.fieldName);
}

/**
 * Read `(published, approved)` for every record file directly inside
 * `<workspacePath>/<connectionDirName>/<folderRelPath>/`. Drives the
 * desktop's grid-view three-way diff status. The desktop reads the working
 * version itself; this provides the other two sides.
 *
 * Slice F.5: post-collapse the dirty + master worktrees no longer exist;
 * this binding is the only way to get the published + approved snapshots.
 * The pre-F.5 `getVersionFolderPath()` helper that returned `.scratch/
 * connections/{dirty,master}/<conn>/` paths is gone.
 */
export async function readFolderBlobs(
  workspaceDir: string,
  connectionDirName: string,
  folderRelPath: string,
): Promise<FolderBlob[]> {
  return loadNative().readFolderBlobs(workspaceDir, connectionDirName, folderRelPath);
}

/**
 * Filtered variant of {@link readFolderBlobs} — returns only entries whose
 * `filename` is in `filenames`. Use from paginated grid renderers (pass the
 * page's filenames) and single-record diff views (pass `[filename]`) so the
 * Electron main process doesn't load hundreds of MB of `(published,
 * approved)` content for folders with thousands of records.
 *
 * Empty `filenames` short-circuits to `[]` before opening the bare repo.
 * Filenames the folder doesn't have are silently dropped (no error).
 *
 * Slice F.5 + mr29 follow-up D5.
 */
export async function readFolderBlobsFiltered(
  workspaceDir: string,
  connectionDirName: string,
  folderRelPath: string,
  filenames: string[],
): Promise<FolderBlob[]> {
  return loadNative().readFolderBlobsFiltered(workspaceDir, connectionDirName, folderRelPath, filenames);
}

/**
 * List record filenames directly inside the folder. Returns the union of
 * `refs/heads/main` paths and `accepted-patches.json` entries (so an approved
 * `Create` whose blob isn't on main yet still shows up), sorted
 * lexicographically. Filename-only — no blob content is read.
 *
 * Use from filename-only consumers (`findRecordOffset`, scroll-to-record).
 * For diff content, call {@link readFolderBlobsFiltered} with the page filenames.
 */
export async function listFolderFilenames(
  workspaceDir: string,
  connectionDirName: string,
  folderRelPath: string,
): Promise<string[]> {
  return loadNative().listFolderFilenames(workspaceDir, connectionDirName, folderRelPath);
}

/**
 * Workspace-wide per-folder counts of `(unreviewed, approved)` records.
 * Powers the sidebar's blue "Needs review" and gray "Approved" dots.
 *
 * Reads persisted bit columns from each folder's SQLite index — no mtime
 * walk, no JSON parse. Folders that haven't been indexed yet are skipped.
 * Call {@link refreshFolderViaNative} first if fresh bits are required.
 *
 * Failure surfaces as a thrown `Error` whose message is prefixed with
 * `INTERNAL:`. Callers in `scratchmd.ts` swallow this into `[]` to preserve
 * the long-standing render-empty-on-failure contract.
 */
export async function nativeGetReviewStats(workspaceDir: string): Promise<ReviewStat[]> {
  return loadNative().getReviewStats(workspaceDir);
}

/**
 * Workspace-wide per-folder validation counts. Drop-in replacement for the
 * prior `runScratchmdJson(['validation', 'get-stats'])` shell-out — same TS
 * shape (snake_case keys), same error-prefix convention (`INTERNAL:`).
 *
 * Callers in `scratchmd.ts` swallow errors into `[]` to preserve the prior
 * shell-out's behaviour.
 */
export async function nativeGetValidationStats(workspaceDir: string): Promise<ValidationStat[]> {
  return loadNative().getValidationStats(workspaceDir);
}

/**
 * Refresh one folder's index so the bits surfaced by
 * {@link nativeGetReviewStats} are current. Mtime-aware: only files whose
 * working-tree timestamp changed are re-read.
 *
 * `folder` is the workspace-relative `<connection>/<sub_path>` shape used
 * throughout the Rust `folder_index` module (e.g. `"HubSpot/Posts"`).
 *
 * Failure surfaces as a thrown `Error` whose message is prefixed with
 * `INTERNAL:`. Used by the cold-start refresh queue
 * (`review-refresh-queue.ts`) and the watcher-driven per-folder refresh.
 */
export async function refreshFolderViaNative(workspaceDir: string, folder: string): Promise<RefreshFolderResult> {
  return loadNative().refreshFolder(workspaceDir, folder);
}

export type { FolderBlob, RefreshFolderResult, ReviewOpResult, ReviewStat, ValidationStat };
