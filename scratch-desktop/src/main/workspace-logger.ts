/**
 * Per-workspace log file written to <workspacePath>/workspace.log.
 *
 * Records CLI command invocations (from scratchmd.ts) and API calls made
 * by the renderer while a workspace is open. Writes are serialized per
 * workspace path; the file rotates to workspace.log.1 when it grows
 * past MAX_SIZE_BYTES.
 */

import { appendFile, rename, stat } from 'fs/promises';
import { join } from 'path';

const LOG_FILENAME = 'workspace.log';
const ROTATED_FILENAME = 'workspace.log.1';
const MAX_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_DETAIL_LENGTH = 500;

const writeQueues = new Map<string, Promise<void>>();

function logFilePath(workspacePath: string): string {
  return join(workspacePath, LOG_FILENAME);
}

function rotatedLogFilePath(workspacePath: string): string {
  return join(workspacePath, ROTATED_FILENAME);
}

async function rotateIfNeeded(workspacePath: string): Promise<void> {
  try {
    const stats = await stat(logFilePath(workspacePath));
    if (stats.size >= MAX_SIZE_BYTES) {
      await rename(logFilePath(workspacePath), rotatedLogFilePath(workspacePath));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function writeLine(workspacePath: string, line: string): Promise<void> {
  await rotateIfNeeded(workspacePath);
  await appendFile(logFilePath(workspacePath), line.endsWith('\n') ? line : `${line}\n`, 'utf8');
}

function enqueue(workspacePath: string, work: () => Promise<void>): Promise<void> {
  const previous = writeQueues.get(workspacePath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  writeQueues.set(workspacePath, next);
  return next;
}

function timestamp(): string {
  return new Date().toISOString();
}

function flatten(value: string): string {
  return value.replace(/\r/g, '').replace(/\n/g, ' ').replace(/\t/g, ' ').trim().slice(0, MAX_DETAIL_LENGTH);
}

export interface CliLogEntry {
  args: string[];
  exitCode: number;
  durationMs: number;
  errorSummary?: string;
}

export interface ApiLogEntry {
  method: string;
  url: string;
  status?: number;
  durationMs: number;
  errorSummary?: string;
}

export function logCliCommand(workspacePath: string | undefined, entry: CliLogEntry): void {
  if (!workspacePath) return;
  const status = entry.exitCode === 0 ? 'ok' : `fail exit=${entry.exitCode}`;
  const argStr = entry.args.join(' ');
  const error = entry.errorSummary ? ` :: ${flatten(entry.errorSummary)}` : '';
  const line = `${timestamp()} CLI ${status} ${Math.round(entry.durationMs)}ms scratchmd ${argStr}${error}`;
  void enqueue(workspacePath, async () => {
    try {
      await writeLine(workspacePath, line);
    } catch (err) {
      console.error('[workspace-logger] failed to write CLI entry:', err);
    }
  });
}

export function logApiCall(workspacePath: string, entry: ApiLogEntry): void {
  const status = entry.status !== undefined ? String(entry.status) : 'err';
  const error = entry.errorSummary ? ` :: ${flatten(entry.errorSummary)}` : '';
  const line = `${timestamp()} API ${status} ${Math.round(entry.durationMs)}ms ${entry.method.toUpperCase()} ${entry.url}${error}`;
  void enqueue(workspacePath, async () => {
    try {
      await writeLine(workspacePath, line);
    } catch (err) {
      console.error('[workspace-logger] failed to write API entry:', err);
    }
  });
}

export type SessionEvent = 'start' | 'end';

export function logSession(workspacePath: string, event: SessionEvent): void {
  const message = event === 'start' ? 'Starting session' : 'Ending session';
  const line = `${timestamp()} SESSION ${message}`;
  void enqueue(workspacePath, async () => {
    try {
      await writeLine(workspacePath, line);
    } catch (err) {
      console.error('[workspace-logger] failed to write SESSION entry:', err);
    }
  });
}

export interface PublishPlanSummary {
  edit: number;
  create: number;
  delete: number;
  backfill: number;
  rename: number;
}

export interface PublishStartEntry {
  event: 'start';
  jobIds: string[];
  tables: string[];
  plans: number;
  summary: PublishPlanSummary;
}

export interface PublishCompleteEntry {
  event: 'complete';
  jobId: string;
  state: string;
  successCount?: number;
  failedCount?: number;
  summary?: PublishPlanSummary;
  errorSummary?: string;
}

export type PublishJobEntry = PublishStartEntry | PublishCompleteEntry;

export function logPublishJob(workspacePath: string, entry: PublishJobEntry): void {
  let line: string;
  if (entry.event === 'start') {
    const tablesStr = entry.tables.length > 0 ? ` tables=${flatten(entry.tables.join(','))}` : '';
    const jobsStr = entry.jobIds.length > 0 ? ` jobs=${entry.jobIds.join(',')}` : '';
    const s = entry.summary;
    line =
      `${timestamp()} PUBLISH start plans=${entry.plans} ` +
      `edits=${s.edit} creates=${s.create} deletes=${s.delete} backfills=${s.backfill} renames=${s.rename}` +
      `${tablesStr}${jobsStr}`;
  } else {
    const succ = entry.successCount !== undefined ? ` succeeded=${entry.successCount}` : '';
    const fail = entry.failedCount !== undefined ? ` failed=${entry.failedCount}` : '';
    const s = entry.summary;
    const breakdown = s
      ? ` edits=${s.edit} creates=${s.create} deletes=${s.delete} backfills=${s.backfill} renames=${s.rename}`
      : '';
    const error = entry.errorSummary ? ` :: ${flatten(entry.errorSummary)}` : '';
    line = `${timestamp()} PUBLISH complete ${entry.state} job=${entry.jobId}${succ}${fail}${breakdown}${error}`;
  }
  void enqueue(workspacePath, async () => {
    try {
      await writeLine(workspacePath, line);
    } catch (err) {
      console.error('[workspace-logger] failed to write PUBLISH entry:', err);
    }
  });
}
