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
import type { ValidationResultRow, ValidationStat } from '../shared/validation-types';
import { WORKSPACE_NEEDS_REINIT_CHANNEL, type WorkspaceNeedsReinitEvent } from '../shared/workspace-reinit-events';
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
 * Discriminated union returned by `uploadWorkspaceChanges`. Both branches
 * survive the IPC boundary as plain JSON — error objects don't, so a
 * structured refusal is modeled as a successful return rather than a thrown
 * Error. PublishChangesModal pattern-matches on `status`.
 */
export type UploadWorkspaceResult = UploadWorkspaceSuccess | UploadWorkspaceBlockedStale;

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
  };
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(WORKSPACE_NEEDS_REINIT_CHANNEL, event);
  }
}

interface ScratchmdLiveCommandOptions {
  onExit?: () => void;
}

// ── Binary path resolution ──

function getScratchmdBinaryPath(): string {
  if (!app.isPackaged) {
    // Dev mode: resolve from the repo root (app.getAppPath() points to src/main in dev)
    const repoRoot = resolve(app.getAppPath(), '..');
    return join(repoRoot, 'scratch-git-2', 'target', 'debug', 'scratchmd');
  }
  // Packaged: use the bundled binary in Resources/bin/
  return join(process.resourcesPath, 'bin', 'scratchmd');
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
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
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
  return runScratchmd(['index', 'rebuild-folder', '--folder', folder], workspacePath);
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
  const args = ['index', 'refresh-files-full', '--folder', folder];
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
  const args = ['paginate-records', '--folder', opts.folder];
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
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
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
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
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
export async function uploadWorkspaceChanges(workspacePath: string): Promise<UploadWorkspaceResult> {
  const result = await runScratchmdCapture(['--json', 'files', 'upload'], workspacePath);
  if (result.exitCode !== 0) {
    const stale = parseBlockedStalePayload(result.stdout);
    if (stale) return stale;
    const message = result.stderr.trim() || result.stdout.trim() || `scratchmd exited with code ${result.exitCode}`;
    throw new Error(message);
  }
  try {
    return JSON.parse(result.stdout) as UploadWorkspaceSuccess;
  } catch (error) {
    throw new Error(`Failed to parse scratchmd JSON output: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** @internal — exported for vitest. */
export function parseBlockedStalePayload(stdout: string): UploadWorkspaceBlockedStale | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as { status?: unknown }).status === 'blocked_stale' &&
      Array.isArray((parsed as { connections?: unknown }).connections)
    ) {
      return parsed as UploadWorkspaceBlockedStale;
    }
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
    ['--json', 'files', 'accept-field', '--folder', folderPath, '--field', fieldName],
    workspacePath,
  );
}

export async function rejectFieldChanges(
  workspacePath: string,
  folderPath: string,
  fieldName: string,
): Promise<FieldActionResult> {
  return runScratchmdJson<FieldActionResult>(
    ['--json', 'files', 'reject-field', '--folder', folderPath, '--field', fieldName],
    workspacePath,
  );
}

export async function restoreDeletedRecord(workspacePath: string, recordPath: string): Promise<void> {
  await runScratchmd(['files', 'restore-deleted-record', recordPath], workspacePath);
}

export type { ValidationResultRow, ValidationStat } from '../shared/validation-types';

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

export async function getValidationStats(workspacePath: string): Promise<ValidationStat[]> {
  try {
    return await runScratchmdJson<ValidationStat[]>(['validation', 'get-stats'], workspacePath);
  } catch {
    return [];
  }
}

export async function getFolderValidationSample(workspacePath: string, folder: string): Promise<ValidationResultRow[]> {
  try {
    return await runScratchmdJson<ValidationResultRow[]>(
      ['validation', 'get-folder-problems', '--folder', folder, '--limit', '20'],
      workspacePath,
    );
  } catch {
    return [];
  }
}

export async function discardCreatedRecord(workspacePath: string, recordPath: string): Promise<void> {
  await runScratchmd(['files', 'discard-created-record', recordPath], workspacePath);
}
