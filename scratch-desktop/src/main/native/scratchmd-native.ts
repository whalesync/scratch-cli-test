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
import { join, resolve } from 'node:path';

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
    localValue: unknown,
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
 * Accept `localValue` for `field` on `recordRelPath` under `connectionDirName`
 * inside `workspaceDir`. Updates `accepted-patches.json` atomically; the
 * working file on disk is not touched. Lock contention surfaces with
 * `parseNativeErrorCode(err) === 'LOCK_BUSY'`.
 */
export async function acceptField(
  workspaceDir: string,
  connectionDirName: string,
  recordRelPath: string,
  field: string,
  localValue: unknown,
): Promise<ReviewOpResult> {
  return loadNative().acceptField(workspaceDir, connectionDirName, recordRelPath, field, localValue);
}

export type { ReviewOpResult };
