/**
 * Wrappers for spawning the scratchmd CLI binary.
 *
 * Provides three execution modes:
 *   1. `runScratchmdCapture` — capture stdout/stderr as strings
 *   2. `runScratchmdJson<T>` — capture + parse JSON stdout
 *   3. `runScratchmd` — capture, throw on non-zero exit
 *   4. `startScratchmdLiveCommand` — stream output to renderer via IPC
 *   5. `startScratchmdLiveSequence` — run multiple commands in sequence, streaming output
 *
 * Higher-level helpers (e.g. `listUnreviewedChanges`) wrap these primitives
 * with typed inputs/outputs so callers don't need to know the CLI flags.
 */

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { app, BrowserWindow } from 'electron';
import { join, relative, resolve } from 'path';
import { performance } from 'perf_hooks';
import type { ReviewStat } from '../shared/review-types';
import type {
  RerunValidationScope,
  RerunValidationSummary,
  ValidationResultRow,
  ValidationStat,
} from '../shared/validation-types';
import { WORKSPACE_NEEDS_REINIT_CHANNEL, type WorkspaceNeedsReinitEvent } from '../shared/workspace-reinit-events';
import { nativeGetReviewStats, nativeGetValidationStats } from './native/scratchmd-native';
import { bundledGitBinaryPath } from './setup-git-env';
import { logCliCommand } from './workspace-logger';

// ── Types ──

export interface ScratchmdResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface UnreviewedChangeEntry {
  connectionName: string;
  path: string;
  status: string;
}

export interface FieldActionResult {
  status: 'accepted' | 'rejected' | 'no_changes';
  field: string;
  folder: string;
  filesAccepted?: number;
  filesRejected?: number;
  paths: string[];
  elapsedMs: number;
}

export interface UploadConnectionResult {
  connectionName: string;
  status: 'uploaded' | 'no_changes' | 'up_to_date';
  filesCreated: number;
  filesUpdated: number;
  filesDeleted: number;
  createdPaths: string[];
  updatedPaths: string[];
  deletedPaths: string[];
  messages: string[];
  /**
   * DEV-10316: the connection's `dirty` HEAD after this upload's apply landed,
   * surfaced by the CLI from the apply-patches job. The publish modal carries
   * it to `startPlanJob` as `expectedBaseDirtyHead` so the server can abort if
   * the staging area drifts before publish. `null`/absent when the apply
   * produced no commit or the server didn't surface a HEAD.
   */
  dirtyHead?: string | null;
}

export interface UploadWorkspaceSuccess {
  status: 'uploaded' | 'no_changes' | 'up_to_date';
  filesCreated: number;
  filesUpdated: number;
  filesDeleted: number;
  createdPaths: string[];
  updatedPaths: string[];
  deletedPaths: string[];
  messages: string[];
  stalenessWarning: { newHead: string } | null;
  connections: UploadConnectionResult[];
  elapsedMs: number;
}

/**
 * Per-connection entry in a `blocked_stale` refusal — the CLI's structured
 * payload when the server's `refs/heads/main` advanced past the user's
 * `baseHead` (D8). One entry per connection that refused. Currently the CLI
 * fails fast on the first stale connection, so this is typically length 1,
 * but the array shape future-proofs the contract for batch refusals.
 */
export interface BlockedStaleConnection {
  connectionName: string;
  baseHead?: string;
  currentRemoteHead: string;
  message?: string;
}

export interface UploadWorkspaceBlockedStale {
  status: 'blocked_stale';
  blockedCount: number;
  connections: BlockedStaleConnection[];
  elapsedMs: number;
}

/**
 * Per-connection entry in a `blocked_dirty` refusal (DEV-10316). Count-only —
 * the connection name + the server's pending-change count vs live `main`. The
 * desktop can't show the user the server's staging area, so it surfaces a name
 * + total and redirects to the web review screen.
 */
export interface BlockedDirtyConnection {
  connectionName: string;
  connectorAccountId: string;
  dirtyCount: number;
}

export interface UploadWorkspaceBlockedDirty {
  status: 'blocked_dirty';
  blockedCount: number;
  connections: BlockedDirtyConnection[];
  elapsedMs: number;
}

/**
 * Per-connection entry in a `check_failed` refusal (DEV-10316). Fail-closed:
 * the dirty-gate check itself couldn't run (git service down/busy). Retryable.
 */
export interface CheckFailedConnection {
  connectionName: string;
  connectorAccountId: string;
  message?: string;
}

export interface UploadWorkspaceCheckFailed {
  status: 'check_failed';
  blockedCount: number;
  connections: CheckFailedConnection[];
  message?: string;
  elapsedMs: number;
}

/**
 * Discriminated union returned by `uploadWorkspaceChanges`. Every branch
 * survives the IPC boundary as plain JSON — error objects don't, so a
 * structured refusal is modeled as a successful return rather than a thrown
 * Error. PublishChangesModal pattern-matches on `status`:
 *   - `blocked_stale` — server's `main` advanced; refresh first (D8).
 *   - `blocked_dirty` — the connection has unpublished server changes; resolve
 *     on the web first (DEV-10316).
 *   - `check_failed` — the dirty-gate check couldn't run; retryable.
 */
export type UploadWorkspaceResult =
  | UploadWorkspaceSuccess
  | UploadWorkspaceBlockedStale
  | UploadWorkspaceBlockedDirty
  | UploadWorkspaceCheckFailed;

/**
 * Success (or non-blocking) branch returned by `pullWorkspaceChanges`. `status`
 * is `downloaded` / `up_to_date` in the common case, or
 * `downloaded_with_stashed_conflicts` (DEV-10523) when a single-record pull
 * brought the target up to date but couldn't re-apply an edit to some OTHER
 * record — that record's content was stashed to `unreviewed-changes.json` and
 * the target is still publishable.
 */
export interface DownloadWorkspaceSuccess {
  status: 'downloaded' | 'up_to_date' | 'downloaded_with_stashed_conflicts';
  filesCreated: number;
  filesUpdated: number;
  filesDeleted: number;
  filesMerged: number;
  conflictsAutoResolved: number;
  /** DEV-10523: unreviewed edits kept user-wins on a same-field collision. */
  unreviewedConflictsAutoResolved: number;
  messages: string[];
  elapsedMs: number;
  /** Present only on `downloaded_with_stashed_conflicts`. */
  stashedConflictPaths?: string[];
  stashFiles?: string[];
  connectionsAdded?: string[];
  connectionsRemoved?: string[];
  connectionsDetached?: string[];
  /**
   * Raw CLI stderr. The download JSON goes to stdout; warn-and-skip notices
   * (e.g. DEV-10421's "failed to set up connection" for a not-yet-clonable new
   * connection) still print to stderr even under `--json`, and
   * `PullInProgressModal` scans this to detect them.
   */
  stderr?: string;
}

/**
 * DEV-10523 `blocked_conflict` refusal from `files download`: an unreviewed edit
 * couldn't be re-applied after the pull (the server deleted the edited record,
 * or the patch failed to reconstruct) and — for a single-record pull — it was
 * the TARGET record. The user's content was saved to `unreviewed-changes.json`.
 * Modeled as a non-throwing return so the renderer can pattern-match on `status`.
 */
export interface DownloadWorkspaceBlockedConflict {
  status: 'blocked_conflict';
  conflictCount: number;
  paths: string[];
  stashFiles: string[];
  elapsedMs: number;
  /** Raw CLI stderr (see `DownloadWorkspaceSuccess.stderr`). */
  stderr?: string;
}

/**
 * Discriminated union returned by `pullWorkspaceChanges`. Like
 * `UploadWorkspaceResult`, the refusal branch survives the IPC boundary as plain
 * JSON (a thrown Error wouldn't), so the renderer pattern-matches on `status`.
 */
export type DownloadWorkspaceResult = DownloadWorkspaceSuccess | DownloadWorkspaceBlockedConflict;

/**
 * Shape of the CLI's `workspace_needs_reinit` JSON payload (slice F.1, see
 * `scratch-git-2/src/cli/commands/files.rs::print_workspace_needs_reinit_result`).
 * Detected centrally in `runScratchmdCapture` and broadcast over IPC; per-call
 * surfaces don't need to handle it themselves.
 */
interface WorkspaceNeedsReinitPayload {
  status: 'workspace_needs_reinit';
  reason: string;
  affectedConnections: string[];
  connectionsWithMasterWorktree: string[];
  connectionsWithSparseCheckout: string[];
  recommendation?: string;
}

/**
 * Human-mode bail text shared by both JSON and non-JSON modes — present on
 * stderr regardless. Used as a fallback when stdout isn't the JSON payload
 * (e.g. `runScratchmd` invocations without `--json`).
 */
const WORKSPACE_NEEDS_REINIT_MARKER = 'older version of Scratch and needs to be reinitialized';

/** @internal — exported for vitest. */
export function parseWorkspaceNeedsReinitPayload(stdout: string, stderr = ''): WorkspaceNeedsReinitPayload | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as { status?: unknown }).status === 'workspace_needs_reinit' &&
      Array.isArray((parsed as { affectedConnections?: unknown }).affectedConnections)
    ) {
      return parsed as WorkspaceNeedsReinitPayload;
    }
  } catch {
    // stdout wasn't JSON — fall through to marker-based detection below.
  }
  if (stderr.includes(WORKSPACE_NEEDS_REINIT_MARKER) || stdout.includes(WORKSPACE_NEEDS_REINIT_MARKER)) {
    return {
      status: 'workspace_needs_reinit',
      reason: 'old_layout_pre_slice_f',
      affectedConnections: [],
      connectionsWithMasterWorktree: [],
      connectionsWithSparseCheckout: [],
    };
  }
  return null;
}

function broadcastWorkspaceNeedsReinit(payload: WorkspaceNeedsReinitPayload, cwd: string | undefined): void {
  const event: WorkspaceNeedsReinitEvent = {
    workspacePath: cwd ?? '',
    affectedConnections: payload.affectedConnections,
    // Carry the reason + recommendation through so the renderer can tailor its
    // copy (e.g. a DEV-9698 `structure_changed` re-clone reassures the user
    // their un-uploaded edits are preserved, rather than warning of discard).
    reason: payload.reason,
    recommendation: payload.recommendation,
  };
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(WORKSPACE_NEEDS_REINIT_CHANNEL, event);
  }
}

interface ScratchmdLiveCommandOptions {
  onExit?: () => void;
}

// ── Binary path resolution ──

export function getScratchmdBinaryPath(): string {
  // Windows executables need the `.exe` suffix for child_process.spawn to find
  // them (unlike a shell, spawn does not auto-append it). afterPack.cjs bundles
  // the Windows CLI as `scratchmd.exe`, and the dev build emits
  // `target/debug/scratchmd.exe`.
  const binaryName = process.platform === 'win32' ? 'scratchmd.exe' : 'scratchmd';
  if (!app.isPackaged) {
    // Test/dev seam: an explicit binary path override. Honored only in unpackaged
    // builds so a packaged app can never be pointed at an arbitrary binary. The
    // e2e suite launches `out/main/index.js` directly, where `app.getAppPath()`
    // doesn't line up with the repo checkout, so the app-path-relative default
    // below would miss the built CLI.
    const overridePath = process.env.SCRATCH_DESKTOP_SCRATCHMD_BINARY;
    if (overridePath && overridePath.length > 0) {
      return overridePath;
    }
    // Dev mode: resolve from the repo root (app.getAppPath() points to src/main in dev)
    const repoRoot = resolve(app.getAppPath(), '..');
    return join(repoRoot, 'scratch-git-2', 'target', 'debug', binaryName);
  }
  // Packaged: use the bundled binary in Resources/bin/
  return join(process.resourcesPath, 'bin', binaryName);
}

// DEV-10196: in packaged builds we ship a bundled git binary so non-dev users
// don't need Xcode CLT installed. The Rust CLI's git-exec wrapper reads
// SCRATCH_GIT_BIN, falling back to PATH `git` when unset — so dev runs keep
// using whatever git is on the developer's PATH.
//
// DEV-10318: configureBundledGitEnvironment() (setup-git-env.ts) already sets
// SCRATCH_GIT_BIN on the main process's own process.env at startup, so the
// in-process napi addon resolves the bundled git too. We re-assert it on the
// spawned child's env here for defense-in-depth and so this spawn path stays
// self-contained — stripping any inherited GIT_EXEC_PATH / GIT_TEMPLATE_DIR so
// the wrapper's bundled-tree derivation wins over stale parent-shell values.
// See setup-git-env.ts for the per-platform Resources/git layout written by
// scripts/afterPack.cjs.
function scratchmdEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  // SCRATCH_URL is set on process.env at startup and on login (see index.ts),
  // so the spawned CLI inherits it here and targets the same Scratch server the
  // desktop authenticated against — without it the CLI falls back to its
  // compiled DEFAULT_SERVER_URL (localhost:3010 in a plain dev build), whose
  // hostname won't match the stored credentials → "Not authenticated".

  if (!app.isPackaged) {
    return env;
  }

  // DEV-10318: in packaged builds, resolve git (and the in-process napi's git
  // shell-outs) to the bundled binary; strip stale exec/template paths.
  env.SCRATCH_GIT_BIN = bundledGitBinaryPath();
  delete env.GIT_EXEC_PATH;
  delete env.GIT_TEMPLATE_DIR;
  return env;
}

// ── Core spawn helpers ──

export function runScratchmdCapture(
  args: string[],
  cwd?: string,
  onProgress?: (line: string) => void,
): Promise<ScratchmdResult> {
  return new Promise((resolve, reject) => {
    const binary = getScratchmdBinaryPath();
    console.log('Running scratchmd command', binary, args);
    const startedAt = performance.now();
    const child = spawn(binary, args, {
      cwd,
      env: scratchmdEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      // Don't flash a console window when spawning scratchmd.exe on Windows.
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let stderrBuf = '';

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderr += text;
      if (args.includes('--debug')) {
        console.debug('[scratchmd]', text.trimEnd());
      }
      if (onProgress) {
        stderrBuf += text;
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) onProgress(line);
        }
      }
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      logCliCommand(cwd, {
        args,
        exitCode: -1,
        durationMs: performance.now() - startedAt,
        errorSummary: error.message,
      });
      if (error.code === 'ENOENT') {
        const hint = app.isPackaged
          ? `Bundled scratchmd binary missing — app may be corrupted. Expected path: ${binary}`
          : `scratchmd binary not found. Expected path: ${binary}. Run 'cargo build --bin scratchmd' in scratch-git-2/.`;
        reject(new Error(hint));
        return;
      }
      reject(new Error(`Failed to start scratchmd: ${error.message}`));
    });

    child.on('close', (code) => {
      const exitCode = code ?? -1;
      logCliCommand(cwd, {
        args,
        exitCode,
        durationMs: performance.now() - startedAt,
        errorSummary: exitCode === 0 ? undefined : stderr.trim() || stdout.trim() || undefined,
      });
      if (exitCode !== 0) {
        const reinit = parseWorkspaceNeedsReinitPayload(stdout, stderr);
        if (reinit) {
          broadcastWorkspaceNeedsReinit(reinit, cwd);
        }
      }
      resolve({ stdout, stderr, exitCode });
    });
  });
}

export async function runScratchmdJson<T>(
  args: string[],
  cwd?: string,
  onProgress?: (line: string) => void,
): Promise<T> {
  const result = await runScratchmdCapture(args, cwd, onProgress);
  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `scratchmd exited with code ${result.exitCode}`;
    throw new Error(message);
  }

  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    throw new Error(`Failed to parse scratchmd JSON output: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function runScratchmd(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  const result = await runScratchmdCapture(args, cwd);
  if (result.exitCode === 0) {
    return { stdout: result.stdout, stderr: result.stderr };
  }

  const message = result.stderr.trim() || result.stdout.trim() || `scratchmd exited with code ${result.exitCode}`;
  throw new Error(message);
}

/** Wipe + fully rebuild the folder-index table for a single workspace-relative folder path. */
export async function reindexFolderIndex(
  workspacePath: string,
  folder: string,
): Promise<{ stdout: string; stderr: string }> {
  // The CLI / folder_index split the folder on POSIX `/`; normalize so a Windows
  // `path.relative` backslash path doesn't become the whole "connection name".
  return runScratchmd(['index', 'rebuild-folder', '--folder', folder.replace(/\\/g, '/')], workspacePath);
}

/**
 * Smart, mtime-aware refresh of one folder's index (skips files that are already fresh). With
 * `validate: true`, also runs validators for files whose validation is stale and populates the
 * `validation_results` problems table — the table that powers the Validation panel and sidebar
 * counts. Much cheaper than {@link reindexFolderIndex} for a folder that is already mostly indexed.
 */
export async function refreshFolderIndex(
  workspacePath: string,
  folder: string,
  opts?: { validate?: boolean },
): Promise<{ stdout: string; stderr: string }> {
  // The CLI / folder_index split the folder on POSIX `/`; normalize so a Windows
  // `path.relative` backslash path doesn't become the whole "connection name".
  const args = ['index', 'refresh-folder', '--folder', folder.replace(/\\/g, '/')];
  if (opts?.validate) args.push('--validate');
  return runScratchmd(args, workspacePath);
}

/**
 * Incrementally update base row + columns for specific files (reads all 3 trees).
 * Much cheaper than reindexFolderIndex for targeted dirty/master mutations on known files.
 * Pass `validate: true` to also run validators on the refreshed files.
 */
export async function reindexFiles(
  workspacePath: string,
  folder: string,
  filenames: string[],
  opts?: { validate?: boolean },
): Promise<{ stdout: string; stderr: string }> {
  const args = ['index', 'refresh-files-full', '--folder', folder.replace(/\\/g, '/')];
  for (const f of filenames) args.push('--file', f);
  if (opts?.validate) args.push('--validate');
  return runScratchmd(args, workspacePath);
}

export interface ReadRecordsFolderSummary {
  total: number;
  approved_changes: number;
  unapproved_changes: number;
  /// Row-status counts mirroring the desktop's DiffGridSummary buckets;
  /// computed full-folder by `query_summary` in folder_index without loading
  /// any blobs. See `shared/folder_index.rs::query_summary`.
  added: number;
  added_approved: number;
  modified: number;
  unpublished: number;
  deleted: number;
  deleted_approved: number;
  invalid_json: number;
}

export interface ReadRecordsParseError {
  filename: string;
  error: string;
}

export interface ValidationError {
  field_path: string;
  validator_kind: string;
  level: string;
  message?: string;
  description?: string;
  fixable: boolean;
}

export interface ReadRecordsResult {
  filenames: string[];
  filtered_total: number;
  summary: ReadRecordsFolderSummary;
  parse_errors: ReadRecordsParseError[];
  stale_count: number;
  row_errors: Record<string, ValidationError[]>;
  total_error_count: number;
  total_problems_stale_count: number;
}

export type ReadRecordsFilterOp =
  | { op: 'hasWorking' }
  | { op: 'hasDirty' }
  | { op: 'hasMaster' }
  | { op: 'approvedChanges' }
  | { op: 'unapprovedChanges' }
  | { op: 'hasErrors' }
  | { op: 'eq' | 'lt' | 'gt' | 'contains'; field: string; value: string };

export interface ReadRecordsOptions {
  folder: string;
  offset?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  filters?: ReadRecordsFilterOp[];
  dbPath?: string;
  reindex?: boolean;
  validate?: boolean;
}

export async function readRecords(
  workspacePath: string,
  opts: ReadRecordsOptions,
  onProgress?: (line: string) => void,
): Promise<ReadRecordsResult> {
  const args = ['paginate-records', '--folder', opts.folder.replace(/\\/g, '/')];
  if (opts.offset !== undefined) args.push('--offset', String(opts.offset));
  if (opts.limit !== undefined) args.push('--limit', String(opts.limit));
  if (opts.sortBy) args.push('--sort-by', opts.sortBy);
  if (opts.sortOrder) args.push('--sort-order', opts.sortOrder);
  for (const f of opts.filters ?? []) {
    args.push('--filter', JSON.stringify(f));
  }
  if (opts.dbPath) args.push('--db-path', opts.dbPath);
  if (opts.reindex) args.push('--reindex');
  if (opts.validate) args.push('--validate');
  args.push('--debug');
  return runScratchmdJson<ReadRecordsResult>(args, workspacePath, onProgress);
}

// ── Streaming helpers ──

export function startScratchmdLiveCommand(
  sender: Electron.WebContents,
  args: string[],
  cwd?: string,
  options?: ScratchmdLiveCommandOptions,
): Promise<{ sessionId: string }> {
  return new Promise((resolve, reject) => {
    const sessionId = randomUUID();
    let finished = false;

    const emit = (payload: Record<string, unknown>): void => {
      sender.send('scratch:command-event', { sessionId, ...payload });
    };

    const emitExit = (exitCode: number, error?: string): void => {
      if (finished) {
        return;
      }

      finished = true;
      emit({ type: 'exit', exitCode, error });
    };

    const binary = getScratchmdBinaryPath();
    const startedAt = performance.now();
    let stderrBuf = '';
    const child = spawn(binary, args, {
      cwd,
      env: scratchmdEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      // Don't flash a console window when spawning scratchmd.exe on Windows.
      windowsHide: true,
    });

    child.on('spawn', () => {
      resolve({ sessionId });
    });

    child.stdout.on('data', (chunk: Buffer | string) => {
      emit({ type: 'chunk', stream: 'stdout', chunk: chunk.toString() });
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderrBuf += text;
      emit({ type: 'chunk', stream: 'stderr', chunk: text });
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      options?.onExit?.();
      logCliCommand(cwd, {
        args,
        exitCode: -1,
        durationMs: performance.now() - startedAt,
        errorSummary: error.message,
      });
      const message =
        error.code === 'ENOENT'
          ? app.isPackaged
            ? 'Bundled scratchmd binary missing — app may be corrupted.'
            : "scratchmd binary not found. Run 'cargo build --bin scratchmd' in scratch-git-2/."
          : `Failed to start scratchmd: ${error.message}`;
      reject(new Error(message));
    });

    child.on('close', (code) => {
      options?.onExit?.();
      const exitCode = code ?? -1;
      logCliCommand(cwd, {
        args,
        exitCode,
        durationMs: performance.now() - startedAt,
        errorSummary: exitCode === 0 ? undefined : stderrBuf.trim() || undefined,
      });
      emitExit(exitCode);
    });
  });
}

export function startScratchmdLiveSequence(
  sender: Electron.WebContents,
  steps: Array<{ label: string; args: string[] }>,
  cwd?: string,
  options?: ScratchmdLiveCommandOptions,
): Promise<{ sessionId: string }> {
  return new Promise((resolve, reject) => {
    const sessionId = randomUUID();
    let started = false;
    let finished = false;
    let stepIndex = 0;

    const emit = (payload: Record<string, unknown>): void => {
      sender.send('scratch:command-event', { sessionId, ...payload });
    };

    const emitChunk = (chunk: string, stream: 'stdout' | 'stderr' = 'stdout'): void => {
      emit({ type: 'chunk', stream, chunk });
    };

    const emitExit = (exitCode: number, error?: string): void => {
      if (finished) {
        return;
      }
      finished = true;
      emit({ type: 'exit', exitCode, error });
    };

    const binary = getScratchmdBinaryPath();

    const runStep = (): void => {
      const step = steps[stepIndex];
      const header = `\n$ scratchmd ${step.label}\n`;
      const stepStartedAt = performance.now();
      let stepStderrBuf = '';

      const child = spawn(binary, step.args, {
        cwd,
        env: scratchmdEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        // Don't flash a console window when spawning scratchmd.exe on Windows.
        windowsHide: true,
      });

      child.on('spawn', () => {
        emitChunk(header);
        if (!started) {
          started = true;
          resolve({ sessionId });
        }
      });

      child.stdout.on('data', (chunk: Buffer | string) => {
        emitChunk(chunk.toString(), 'stdout');
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        const text = chunk.toString();
        stepStderrBuf += text;
        emitChunk(text, 'stderr');
      });

      child.on('error', (error: NodeJS.ErrnoException) => {
        logCliCommand(cwd, {
          args: step.args,
          exitCode: -1,
          durationMs: performance.now() - stepStartedAt,
          errorSummary: error.message,
        });
        const message =
          error.code === 'ENOENT'
            ? app.isPackaged
              ? 'Bundled scratchmd binary missing — app may be corrupted.'
              : "scratchmd binary not found. Run 'cargo build --bin scratchmd' in scratch-git-2/."
            : `Failed to start scratchmd: ${error.message}`;
        if (!started) {
          options?.onExit?.();
          reject(new Error(message));
          return;
        }
        options?.onExit?.();
        emitExit(-1, message);
      });

      child.on('close', (code) => {
        const exitCode = code ?? -1;
        logCliCommand(cwd, {
          args: step.args,
          exitCode,
          durationMs: performance.now() - stepStartedAt,
          errorSummary: exitCode === 0 ? undefined : stepStderrBuf.trim() || undefined,
        });
        if (exitCode !== 0) {
          options?.onExit?.();
          emitExit(exitCode);
          return;
        }

        stepIndex += 1;
        if (stepIndex >= steps.length) {
          options?.onExit?.();
          emitExit(0);
          return;
        }

        runStep();
      });
    };

    if (steps.length === 0) {
      resolve({ sessionId });
      emitExit(0);
      return;
    }

    runStep();
  });
}

// ── High-level CLI wrappers ──

export async function listUnreviewedChanges(workspacePath: string): Promise<UnreviewedChangeEntry[]> {
  const result = await runScratchmdJson<{ count: number; entries: UnreviewedChangeEntry[] }>(
    ['--json', 'files', 'unreviewed'],
    workspacePath,
  );
  if (!Array.isArray(result.entries)) {
    throw new Error('scratchmd files unreviewed returned unexpected output — is your CLI up to date? ');
  }
  return result.entries;
}

export async function listUnpushedChanges(workspacePath: string): Promise<UnreviewedChangeEntry[]> {
  const result = await runScratchmdJson<{ count: number; entries: UnreviewedChangeEntry[] }>(
    ['--json', 'files', 'unpushed'],
    workspacePath,
  );
  if (!Array.isArray(result.entries)) {
    throw new Error('scratchmd files unpushed returned unexpected output — is your CLI up to date?');
  }
  return result.entries;
}

export async function listUnpublishedChanges(workspacePath: string): Promise<UnreviewedChangeEntry[]> {
  const result = await runScratchmdJson<{ count: number; entries: UnreviewedChangeEntry[] }>(
    ['--json', 'files', 'unpublished'],
    workspacePath,
  );
  if (!Array.isArray(result.entries)) {
    throw new Error('scratchmd files unpublished returned unexpected output — is your CLI up to date? ');
  }
  return result.entries;
}

/**
 * Run `scratchmd --json files upload` and parse the result. The CLI emits one
 * RFC 7396 patch per changed data file, uploads to the server's `/upload-patch`
 * endpoint, and polls the apply-patches job to completion. Publishing
 * (plan-job + run-job) is a separate step driven by the renderer — see
 * `publishApi` in the renderer.
 *
 * D8: when the server's `refs/heads/main` has advanced past the user's local
 * `main` for any connection, the CLI exits non-zero with a structured
 * `blocked_stale` payload on stdout. This wrapper recognizes that payload
 * and returns it as a `UploadWorkspaceBlockedStale` branch of the discriminated
 * union — both branches survive the IPC boundary as plain JSON, so the
 * renderer's `PublishChangesModal` can pattern-match on `result.status`.
 */
export async function uploadWorkspaceChanges(
  workspacePath: string,
  opts?: { filePath?: string },
): Promise<UploadWorkspaceResult> {
  // `--file-path` (DEV-10413) scopes the upload to a single record (workspace-
  // relative path). The CLI then skips the dirty-gate probe and relaxes
  // `refuse_if_dirty`, mirroring Scratch Web's single-file publish. Without it,
  // the full workspace upload (two-pass dirty gate) runs.
  const args = ['--json', 'files', 'upload'];
  if (opts?.filePath) {
    args.push('--file-path', opts.filePath);
  }
  const result = await runScratchmdCapture(args, workspacePath);
  if (result.exitCode !== 0) {
    // The CLI exits non-zero for every structured refusal (`blocked_stale` D8,
    // `blocked_dirty` / `check_failed` DEV-10316), printing the payload to
    // stdout. Recognize them and return as typed (non-throwing) results so the
    // modal can pattern-match on `status`; anything else is a real error.
    const refusal = parseUploadRefusalPayload(result.stdout);
    if (refusal) return refusal;
    const message = result.stderr.trim() || result.stdout.trim() || `scratchmd exited with code ${result.exitCode}`;
    throw new Error(message);
  }
  try {
    return JSON.parse(result.stdout) as UploadWorkspaceSuccess;
  } catch (error) {
    throw new Error(`Failed to parse scratchmd JSON output: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Recognize a structured `files upload` refusal payload on stdout and return
 * the matching typed branch, or `null` if stdout isn't one (caller falls
 * through to the generic error path). Handles `blocked_stale` (D8),
 * `blocked_dirty`, and `check_failed` (DEV-10316).
 *
 * @internal — exported for vitest.
 */
export function parseUploadRefusalPayload(
  stdout: string,
): UploadWorkspaceBlockedStale | UploadWorkspaceBlockedDirty | UploadWorkspaceCheckFailed | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const status = (parsed as { status?: unknown }).status;
    const hasConnections = Array.isArray((parsed as { connections?: unknown }).connections);
    if (!hasConnections) return null;
    if (status === 'blocked_stale') return parsed as UploadWorkspaceBlockedStale;
    if (status === 'blocked_dirty') return parsed as UploadWorkspaceBlockedDirty;
    if (status === 'check_failed') return parsed as UploadWorkspaceCheckFailed;
  } catch {
    // stdout wasn't JSON — fall through to the generic error path.
  }
  return null;
}

/**
 * Pull the latest server `main` into the workspace, re-anchoring accepted
 * patches and re-applying unreviewed working-tree edits user-wins (DEV-10523).
 * Mirrors `uploadWorkspaceChanges`: `--json`, a structured result, and a
 * non-throwing `blocked_conflict` branch.
 *
 * `opts.onDelete` ('remove' | 'keep') controls removed-connection handling.
 * `opts.filePath` (single-record "Download and publish") scopes only the
 * FAILURE decision to that record — the whole workspace still pulls. With it,
 * the pull returns `blocked_conflict` iff the TARGET hard-conflicts; if only
 * other records conflict it returns `downloaded_with_stashed_conflicts`.
 */
export async function pullWorkspaceChanges(
  workspacePath: string,
  opts?: { onDelete?: string; filePath?: string },
): Promise<DownloadWorkspaceResult> {
  const args = ['--json', 'files', 'download'];
  if (opts?.onDelete) {
    args.push('--on-delete', opts.onDelete);
  }
  if (opts?.filePath) {
    args.push('--file-path', opts.filePath);
  }
  const result = await runScratchmdCapture(args, workspacePath);
  if (result.exitCode !== 0) {
    // The CLI exits non-zero for a `blocked_conflict` refusal (DEV-10523),
    // printing the payload to stdout. Return it typed (non-throwing) so the
    // renderer can pattern-match on `status`; anything else is a real error.
    const refusal = parseDownloadRefusalPayload(result.stdout);
    if (refusal) return { ...refusal, stderr: result.stderr };
    const message = result.stderr.trim() || result.stdout.trim() || `scratchmd exited with code ${result.exitCode}`;
    throw new Error(message);
  }
  try {
    // Carry stderr alongside the parsed JSON so warn-and-skip notices that print
    // to stderr (e.g. DEV-10421 connection-setup failures) remain inspectable.
    return { ...(JSON.parse(result.stdout) as DownloadWorkspaceSuccess), stderr: result.stderr };
  } catch (error) {
    throw new Error(`Failed to parse scratchmd JSON output: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Recognize a structured `files download` refusal payload on stdout
 * (`blocked_conflict`, DEV-10523), or `null` if stdout isn't one (caller falls
 * through to the generic error path).
 *
 * @internal — exported for vitest.
 */
export function parseDownloadRefusalPayload(stdout: string): DownloadWorkspaceBlockedConflict | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const status = (parsed as { status?: unknown }).status;
    const hasPaths = Array.isArray((parsed as { paths?: unknown }).paths);
    if (status === 'blocked_conflict' && hasPaths) return parsed as DownloadWorkspaceBlockedConflict;
  } catch {
    // stdout wasn't JSON — fall through to the generic error path.
  }
  return null;
}

export async function acceptFieldChanges(
  workspacePath: string,
  folderPath: string,
  fieldName: string,
): Promise<FieldActionResult> {
  return runScratchmdJson<FieldActionResult>(
    ['--json', 'files', 'accept-field', '--folder', folderPath.replace(/\\/g, '/'), '--field', fieldName],
    workspacePath,
  );
}

export async function rejectFieldChanges(
  workspacePath: string,
  folderPath: string,
  fieldName: string,
): Promise<FieldActionResult> {
  return runScratchmdJson<FieldActionResult>(
    ['--json', 'files', 'reject-field', '--folder', folderPath.replace(/\\/g, '/'), '--field', fieldName],
    workspacePath,
  );
}

export async function restoreDeletedRecord(workspacePath: string, recordPath: string): Promise<void> {
  await runScratchmd(['files', 'restore-deleted-record', recordPath], workspacePath);
}

/** Outcome of a single-record post-publish reconcile (DEV-10413). */
export interface ReconcilePublishedResult {
  status: string;
  path: string;
  /** True when the record's accepted patch was dropped (publish landed); false
   *  when it survived (nothing landed for this record). Drives the renderer's
   *  `plan-no-diff` disambiguation. */
  patchDropped: boolean;
  conflicts: number;
}

/**
 * Reconcile local state for a SINGLE record after it was published (DEV-10413).
 * The scoped analogue of `pullWorkspaceChanges` (`files download`), which
 * refuses while any unreviewed edits exist elsewhere in the workspace. Re-anchors
 * only this record's accepted patch against the new `main` and surgically
 * rewrites only this record's working file. `filePath` is workspace-relative.
 */
export async function reconcilePublishedRecord(
  workspacePath: string,
  filePath: string,
): Promise<ReconcilePublishedResult> {
  return runScratchmdJson<ReconcilePublishedResult>(
    ['--json', 'files', 'reconcile-published', '--file-path', filePath],
    workspacePath,
  );
}

export type { ReviewStat } from '../shared/review-types';
export type {
  RerunValidationScope,
  RerunValidationSummary,
  ValidationResultRow,
  ValidationStat,
} from '../shared/validation-types';

export async function getValidationResults(
  workspacePath: string,
  folderPath: string,
  filename: string,
): Promise<ValidationResultRow[]> {
  const relFolder = relative(workspacePath, folderPath).replace(/\\/g, '/');
  const recordPath = `${relFolder}/${filename}`;
  try {
    return await runScratchmdJson<ValidationResultRow[]>(
      ['validation', 'get-file-problems', '--record', recordPath],
      workspacePath,
    );
  } catch {
    return [];
  }
}

export async function getFolderValidationResults(
  workspacePath: string,
  folderPath: string,
): Promise<ValidationResultRow[]> {
  const relFolder = relative(workspacePath, folderPath).replace(/\\/g, '/');
  try {
    return await runScratchmdJson<ValidationResultRow[]>(
      ['validation', 'get-folder-problems', '--folder', relFolder],
      workspacePath,
    );
  } catch {
    return [];
  }
}

export async function clearFolderIndex(workspacePath: string, folderPath: string): Promise<{ rows_cleared: number }> {
  const relFolder = relative(workspacePath, folderPath).replace(/\\/g, '/');
  return runScratchmdJson<{ rows_cleared: number }>(['index', 'clear-folder', '--folder', relFolder], workspacePath);
}

/**
 * Force re-run all validators against the CURRENT index and refresh the stored
 * `validation_results`, non-destructively (preserves index rows + dynamic columns — unlike
 * {@link clearFolderIndex}). Rust fans out across folders for connector/workbook scope and
 * returns an aggregate summary; `onProgress` receives per-folder `[rerun] revalidating …`
 * lines from stderr so a long-running scope can show live progress.
 */
export async function rerunValidation(
  workspacePath: string,
  scope: RerunValidationScope,
  onProgress?: (line: string) => void,
): Promise<RerunValidationSummary> {
  const args = ['validation', 'rerun'];
  if (scope.kind === 'folder') {
    // The CLI splits the folder on POSIX `/`; normalize a Windows backslash path.
    const relFolder = relative(workspacePath, scope.folderPath).replace(/\\/g, '/');
    args.push('--folder', relFolder);
  } else if (scope.kind === 'connection') {
    args.push('--connection', scope.connection);
  } else {
    args.push('--all');
  }
  return runScratchmdJson<RerunValidationSummary>(args, workspacePath, onProgress);
}

export async function getFilenamesWithErrors(
  workspacePath: string,
  folderPath: string,
): Promise<{ filenames: string[]; field_paths: string[] }> {
  const relFolder = relative(workspacePath, folderPath).replace(/\\/g, '/');
  try {
    return await runScratchmdJson<{ filenames: string[]; field_paths: string[] }>(
      ['validation', 'get-files-with-problems', '--folder', relFolder],
      workspacePath,
    );
  } catch {
    return { filenames: [], field_paths: [] };
  }
}

/**
 * Workspace-wide per-folder validation counts.
 *
 * Migrated from `runScratchmdJson(['validation', 'get-stats'])` to a direct
 * napi call (`nativeGetValidationStats`) — removes the ~10–20 ms spawn
 * overhead per invocation, which matters because this is called on every
 * workspace open, every publish-modal open, every drawer button click, and
 * every `refreshKey` bump.
 *
 * Preserves the public contract intentionally:
 *   - Signature: `(workspacePath) => Promise<ValidationStat[]>`.
 *   - Snake_case keys on each entry (load-bearing for
 *     `PublishChangesModal.handleViewProblems`, `ValidationStatsDrawer`, and
 *     `WorkspaceSidebar`'s `${connection}/${folder_path}` Map key).
 *   - Swallow-errors-as-`[]`: callers (including `ValidationStatsDrawer`,
 *     which has no try/catch) assume this never throws.
 */
export async function getValidationStats(workspacePath: string): Promise<ValidationStat[]> {
  try {
    return await nativeGetValidationStats(workspacePath);
  } catch {
    return [];
  }
}

/**
 * Workspace-wide per-folder review-state counts. Powers the sidebar's blue
 * "Needs review" and gray "Approved" folder-tree dots — see
 * `docs/plans/2026-05-31-folder-tree-review-approved-dots.md`.
 *
 * Same swallow-errors-as-`[]` contract as `getValidationStats` so the dot
 * subsystem degrades to "no dots" if the napi binding fails to load on a
 * malformed workspace.
 */
export async function getReviewStats(workspacePath: string): Promise<ReviewStat[]> {
  try {
    return await nativeGetReviewStats(workspacePath);
  } catch {
    return [];
  }
}

export async function getFolderValidationSample(workspacePath: string, folder: string): Promise<ValidationResultRow[]> {
  try {
    return await runScratchmdJson<ValidationResultRow[]>(
      ['validation', 'get-folder-problems', '--folder', folder.replace(/\\/g, '/'), '--limit', '100'],
      workspacePath,
    );
  } catch {
    return [];
  }
}

export async function discardCreatedRecord(workspacePath: string, recordPath: string): Promise<void> {
  await runScratchmd(['files', 'discard-created-record', recordPath], workspacePath);
}

/**
 * Sync the desktop's stored credentials to the scratchmd CLI (`scratchmd auth set-credentials`)
 * so the CLI and in-process napi can authenticate without a separate login. Best-effort: a
 * failure is logged (debug) but never thrown, matching the original inline behavior of the
 * `auth:save-credentials` IPC handler. No-op unless apiToken, email, and tokenExpiresAt are
 * all present (the device-code login always provides all three).
 */
export async function syncCredentialsToScratchmdCli(credentials: {
  apiToken?: string | null;
  email?: string | null;
  tokenExpiresAt?: string | null;
  serverUrl: string;
}): Promise<void> {
  if (!credentials.apiToken || !credentials.email || !credentials.tokenExpiresAt) {
    return;
  }
  try {
    const args = [
      'auth',
      'set-credentials',
      '--apiToken',
      credentials.apiToken,
      '--email',
      credentials.email,
      '--expiresAt',
      credentials.tokenExpiresAt,
      '--scratch-url',
      credentials.serverUrl,
    ];
    const result = await runScratchmdCapture(args);
    if (result.exitCode !== 0) {
      console.debug('[auth] scratchmd set-credentials failed:', result.stderr.trim() || result.stdout.trim());
    }
  } catch (error) {
    console.debug('[auth] scratchmd set-credentials error:', error);
  }
}
