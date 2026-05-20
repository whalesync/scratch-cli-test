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
 * handlers (`acceptCellChange`, `acceptCellInputText`, `undoApprovedCellChange`)
 * in `local-files.ts` to call `acceptField` / (later) `discardField` through
 * this module.
 */

import { app } from 'electron';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';

import type { ReviewOpResult } from '../../../../scratch-git-2/napi/index.d.ts';

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
  discardField(
    workspaceDir: string,
    connectionDirName: string,
    recordRelPath: string,
    field: string,
  ): Promise<ReviewOpResult>;
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

export type { ReviewOpResult };
