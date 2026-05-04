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
import { app } from 'electron';
import { readdir, readFile, rm } from 'fs/promises';
import { join, relative, resolve } from 'path';
import type { ValidationResultRow } from '../shared/validation-types';

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

interface LocalPublishPlan {
  planId: string;
  createdAt: string;
  connectionName: string;
  connectionId: string;
  summary: {
    edit: number;
    create: number;
    delete: number;
    backfill: number;
    rename: number;
  };
  tablePaths: string[];
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

export function runScratchmdCapture(args: string[], cwd?: string): Promise<ScratchmdResult> {
  return new Promise((resolve, reject) => {
    const binary = getScratchmdBinaryPath();
    console.log('Running scratchmd command', binary, args);
    const child = spawn(binary, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
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
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

export async function runScratchmdJson<T>(args: string[], cwd?: string): Promise<T> {
  const result = await runScratchmdCapture(args, cwd);
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

export async function refreshRecordIndex(
  workspacePath: string,
  opts?: { rebuild?: boolean; paths?: string[] },
): Promise<{ stdout: string; stderr: string }> {
  const args = ['refresh-record-index'];
  if (opts?.rebuild) {
    args.push('--rebuild');
  }
  for (const path of opts?.paths ?? []) {
    args.push('--path', path);
  }
  return runScratchmd(args, workspacePath);
}

export async function assertIndexTables(workspacePath: string): Promise<{ stdout: string; stderr: string }> {
  return runScratchmd(['assert-index-tables'], workspacePath);
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
      emit({ type: 'chunk', stream: 'stderr', chunk: chunk.toString() });
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      options?.onExit?.();
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
      emitExit(code ?? -1);
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
        emitChunk(chunk.toString(), 'stderr');
      });

      child.on('error', (error: NodeJS.ErrnoException) => {
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
        if ((code ?? -1) !== 0) {
          options?.onExit?.();
          emitExit(code ?? -1);
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

export async function listLocalPublishPlans(workspacePath: string): Promise<LocalPublishPlan[]> {
  const plansRoot = join(workspacePath, '.scratch', 'connections', 'scratch');

  try {
    const connectionEntries = await readdir(plansRoot, { withFileTypes: true });
    const plans = await Promise.all(
      connectionEntries
        .filter((entry) => entry.isDirectory())
        .map(async (connectionEntry) => {
          const manifestRoot = join(plansRoot, connectionEntry.name, '.publish-plans');

          try {
            const manifestEntries = await readdir(manifestRoot, { withFileTypes: true });
            const parsedPlans = await Promise.all(
              manifestEntries
                .filter((entry) => entry.isDirectory())
                .map(async (manifestEntry) => {
                  const manifestPath = join(manifestRoot, manifestEntry.name, 'plan.json');
                  const contents = await readFile(manifestPath, 'utf8');
                  return JSON.parse(contents) as LocalPublishPlan;
                }),
            );
            return parsedPlans;
          } catch (error) {
            const nodeError = error as NodeJS.ErrnoException;
            if (nodeError.code === 'ENOENT') {
              return [];
            }
            throw error;
          }
        }),
    );

    return plans
      .flat()
      .sort(
        (left, right) =>
          left.connectionName.localeCompare(right.connectionName) || left.planId.localeCompare(right.planId),
      );
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function removeLegacyPublishPlanDirs(scratchDir: string): Promise<void> {
  try {
    const entries = await readdir(scratchDir, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const entryPath = join(scratchDir, entry.name);
          if (entry.name.startsWith('publish-plan-')) {
            await rm(entryPath, { recursive: true, force: true });
            return;
          }

          if (!entry.name.startsWith('.')) {
            await removeLegacyPublishPlanDirs(entryPath);
          }
        }),
    );
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

export async function deleteLocalPublishPlans(workspacePath: string): Promise<void> {
  const plansRoot = join(workspacePath, '.scratch', 'connections', 'scratch');

  try {
    const connectionEntries = await readdir(plansRoot, { withFileTypes: true });
    await Promise.all(
      connectionEntries
        .filter((entry) => entry.isDirectory())
        .map(async (connectionEntry) => {
          const scratchDir = join(plansRoot, connectionEntry.name);
          await removeLegacyPublishPlanDirs(scratchDir);
          await rm(join(scratchDir, '.publish-plans'), { recursive: true, force: true });
        }),
    );
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return;
    }
    throw error;
  }
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

export type { ValidationResultRow } from '../shared/validation-types';

export async function getValidationResults(
  workspacePath: string,
  folderPath: string,
  filename: string,
): Promise<ValidationResultRow[]> {
  const relFolder = relative(workspacePath, folderPath).replace(/\\/g, '/');
  const recordPath = `${relFolder}/${filename}`;
  try {
    return await runScratchmdJson<ValidationResultRow[]>(
      ['get-validation-results', '--record', recordPath],
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
      ['get-folder-validation-results', '--folder', relFolder],
      workspacePath,
    );
  } catch {
    return [];
  }
}

export async function discardCreatedRecord(workspacePath: string, recordPath: string): Promise<void> {
  await runScratchmd(['files', 'discard-created-record', recordPath], workspacePath);
}

export async function triggerPublishFromGit(
  workspacePath: string,
): Promise<{ stdout: string; stderr: string; jobIds: string[] }> {
  const result = await runScratchmdCapture(['publish-from-git'], workspacePath);
  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `scratchmd exited with code ${result.exitCode}`;
    throw new Error(message);
  }

  const jobIds = Array.from(result.stdout.matchAll(/jobId:\s*([^) \n]+)/g), (match) => match[1]).filter(
    (jobId): jobId is string => typeof jobId === 'string' && jobId.length > 0,
  );
  const uniqueJobIds: string[] = Array.from(new Set(jobIds));
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    jobIds: uniqueJobIds,
  };
}
