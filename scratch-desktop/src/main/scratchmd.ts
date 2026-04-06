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
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

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

// ── Core spawn helpers ──

const SCRATCHMD_BINARIES = ['scratchmd', '/usr/local/bin/scratchmd'];

export function runScratchmdCapture(args: string[], cwd?: string): Promise<ScratchmdResult> {
  return new Promise((resolve, reject) => {
    let attemptIndex = 0;

    const attempt = (): void => {
      const command = SCRATCHMD_BINARIES[attemptIndex];
      const child = spawn(command, args, {
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
        if (error.code === 'ENOENT' && attemptIndex < SCRATCHMD_BINARIES.length - 1) {
          attemptIndex += 1;
          attempt();
          return;
        }
        reject(new Error(`Failed to start scratchmd: ${error.message}`));
      });

      child.on('close', (code) => {
        resolve({ stdout, stderr, exitCode: code ?? -1 });
      });
    };

    attempt();
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

// ── Streaming helpers ──

export function startScratchmdLiveCommand(
  sender: Electron.WebContents,
  args: string[],
  cwd?: string,
): Promise<{ sessionId: string }> {
  return new Promise((resolve, reject) => {
    const sessionId = randomUUID();
    let attemptIndex = 0;
    let started = false;
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

    const attempt = (): void => {
      const command = SCRATCHMD_BINARIES[attemptIndex];
      const child = spawn(command, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.on('spawn', () => {
        if (!started) {
          started = true;
          resolve({ sessionId });
        }
      });

      child.stdout.on('data', (chunk: Buffer | string) => {
        emit({ type: 'chunk', stream: 'stdout', chunk: chunk.toString() });
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        emit({ type: 'chunk', stream: 'stderr', chunk: chunk.toString() });
      });

      child.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' && attemptIndex < SCRATCHMD_BINARIES.length - 1) {
          attemptIndex += 1;
          attempt();
          return;
        }

        const message = `Failed to start scratchmd: ${error.message}`;
        if (!started) {
          reject(new Error(message));
          return;
        }

        emitExit(-1, message);
      });

      child.on('close', (code) => {
        emitExit(code ?? -1);
      });
    };

    attempt();
  });
}

export function startScratchmdLiveSequence(
  sender: Electron.WebContents,
  steps: Array<{ label: string; args: string[] }>,
  cwd?: string,
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

    const runStep = (attemptIndex: number): void => {
      const step = steps[stepIndex];
      const binary = SCRATCHMD_BINARIES[attemptIndex];
      const header = `\n$ scratchmd ${step.label}\n`;
      let abandoned = false;

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
        if (error.code === 'ENOENT' && attemptIndex < SCRATCHMD_BINARIES.length - 1) {
          abandoned = true;
          runStep(attemptIndex + 1);
          return;
        }

        const message = `Failed to start scratchmd: ${error.message}`;
        if (!started) {
          reject(new Error(message));
          return;
        }
        emitExit(-1, message);
      });

      child.on('close', (code) => {
        if (abandoned) {
          return;
        }
        if ((code ?? -1) !== 0) {
          emitExit(code ?? -1);
          return;
        }

        stepIndex += 1;
        if (stepIndex >= steps.length) {
          emitExit(0);
          return;
        }

        runStep(0);
      });
    };

    if (steps.length === 0) {
      resolve({ sessionId });
      emitExit(0);
      return;
    }

    runStep(0);
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
