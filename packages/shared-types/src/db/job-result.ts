import { JobType } from '../job-types';
import {
  PublishPublicProgress,
  PullLinkedFolderFilesPublicProgress,
  SyncDataFoldersPublicProgress,
} from './job-progress';

///
/// Normalized, render-ready result for a finished job or routine step.
///
/// `publicProgress` is job-type-specific (pull / sync / publish each emit a different shape — see
/// `job-progress.ts`). Turning that into something a UI can render means knowing each shape's field
/// names and how to phrase its headline. That interpretation lives HERE, in one shared place, so the
/// web client, desktop app, and `scratchmd` CLI all render the same thing without re-teaching each
/// frontend a connector's or a job type's quirks (see the "keep connector knowledge out of the
/// frontends" product principle). A frontend calls {@link deriveJobResult} and renders the result.
///

/** A single headline counter, e.g. `{ label: 'Created', value: 3 }`. */
export interface JobResultStat {
  label: string;
  value: number;
}

/** A single impacted record file and what happened to it. */
export interface JobResultFile {
  path: string;
  operation: 'Created' | 'Updated' | 'Deleted' | 'Refreshed';
}

/**
 * A per-folder/table breakdown row, uniform across pull (folders) and sync (tables). This is the
 * shape the frontends render; the raw `publicProgress` field names are flattened into it here.
 */
export interface JobResultFolder {
  /** DataFolderId, or null when the source job didn't carry one. */
  id: string | null;
  name: string;
  /** Connector service (e.g. "AIRTABLE"), or null when unknown. */
  connector: string | null;
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  errorCount: number;
  warningCount: number;
  createdPaths: string[];
  updatedPaths: string[];
  deletedPaths: string[];
  /** Free-form status string from the source job ('completed' | 'failed' | 'active' | …), or null. */
  status: string | null;
  /** Effective pull mode for this folder. Pull only — an incremental request can demote to full per-folder. */
  mode?: 'full' | 'incremental';
}

/**
 * The full normalized result. `summary` + `stats` are the lightweight headline (suitable for a list
 * row); `folders`, `files`, `errors`, and `warnings` are the drill-down detail.
 */
export interface JobResult {
  /** Concise headline prose, e.g. "Published 3 changes". */
  summary: string;
  /** Flat headline counters, e.g. `[{label:'Created',value:3},{label:'Updated',value:0}]`. */
  stats: JobResultStat[];
  /** Per-folder/table breakdown. Empty for jobs with no folder dimension (e.g. publish). */
  folders: JobResultFolder[];
  /** Impacted record files across all folders. */
  files: JobResultFile[];
  /** User-facing error messages. */
  errors: string[];
  /** User-facing warning messages. */
  warnings: string[];
  /**
   * Effective pull mode for the run. Pull only (undefined for sync/publish). 'incremental' when the
   * run fetched only records changed since the last watermark for any folder — in that case the
   * fetched count is not the folder's full record total, so the 'Unchanged' stat is omitted.
   */
  mode?: 'full' | 'incremental';
}

/**
 * The lightweight headline persisted on a routine step (`RoutineRunStep.result`). Survives the
 * source job aging out of retention — the richer {@link JobResult} (folders/files) is derived from
 * the live `job.publicProgress` on demand when the job is still available.
 */
export interface RoutineRunStepResult {
  summary: string;
  stats: JobResultStat[];
}

/** The broad category a `Job.type` falls into, used to pick a renderer / derivation. */
export type JobResultKind = 'pull' | 'sync' | 'publish' | 'rehost' | 'unknown';

/**
 * Map a raw `Job.type` string to its broad category. Mirrors the client's `getJobType`, lifted here
 * so the shared derivation (and any frontend) can categorize a job without re-declaring the logic.
 */
export function categorizeJobType(type: string): JobResultKind {
  if (type.includes('sync')) return 'sync';
  if (type.includes('publish') || type.includes('pipeline')) return 'publish';
  if (type.includes('pull') || type === JobType.RefreshRecords) return 'pull';
  if (type === JobType.RehostAssets) return 'rehost';
  return 'unknown';
}

/** Formats a count with its singular/plural noun, e.g. `1 folder`, `3 folders`. */
function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Flattens a folder's path arrays into per-file `{ path, operation }` rows. */
function filesFromFolder(
  folder: Pick<JobResultFolder, 'createdPaths' | 'updatedPaths' | 'deletedPaths'>,
): JobResultFile[] {
  return [
    ...folder.createdPaths.map((path): JobResultFile => ({ path, operation: 'Created' })),
    ...folder.updatedPaths.map((path): JobResultFile => ({ path, operation: 'Updated' })),
    ...folder.deletedPaths.map((path): JobResultFile => ({ path, operation: 'Deleted' })),
  ];
}

// ── Pull ─────────────────────────────────────────────────────────────────────

function derivePullResult(progress: PullLinkedFolderFilesPublicProgress | undefined): JobResult {
  if (!progress) {
    return { summary: 'Pull completed', stats: [], folders: [], files: [], errors: [], warnings: [] };
  }

  const folderCount = progress.folderCount ?? 0;
  const createdCount = progress.createdCount ?? 0;
  const updatedCount = progress.updatedCount ?? 0;
  const deletedCount = progress.deletedCount ?? 0;
  const changedRecordCount = createdCount + updatedCount + deletedCount;

  // An incremental pull only fetches records changed since the last watermark, so `totalFiles` is the
  // changed subset — not the folder's full record count. Treat the run as incremental if the run-wide
  // mode says so or any folder ran incrementally (an incremental request can demote to full per-folder).
  const isIncrementalPull =
    progress.mode === 'incremental' || (progress.folders ?? []).some((folder) => folder.mode === 'incremental');
  const modeSuffix = isIncrementalPull ? ' (incremental)' : '';
  const summary =
    changedRecordCount === 0
      ? `Pulled ${pluralize(folderCount, 'folder')} — no changes${modeSuffix}`
      : `Pulled ${pluralize(changedRecordCount, 'record')} across ${pluralize(folderCount, 'folder')}${modeSuffix}`;

  const stats: JobResultStat[] = [
    { label: 'New', value: createdCount },
    { label: 'Updated', value: updatedCount },
    { label: 'Deleted', value: deletedCount },
  ];
  // `totalFiles` is the set fetched from the service, which is exactly what ends up created, updated, or
  // left untouched on disk (deletes are records that were NOT fetched, so they are not part of this
  // total). So New + Updated + Unchanged = fetched record count. We only surface 'Unchanged' for full
  // pulls — under incremental the fetched count is just the changed subset, so it would read ~0 and
  // misleadingly imply the rest of the folder doesn't exist.
  if (!isIncrementalPull) {
    const unchangedCount = Math.max(0, (progress.totalFiles ?? 0) - createdCount - updatedCount);
    stats.push({ label: 'Unchanged', value: unchangedCount });
  }

  // Prefer the per-folder breakdown (enriched server-side). Fall back to a single synthetic row built
  // from the run-wide aggregate so older progress records (no `folders`) still render one folder.
  const breakdown: PullLinkedFolderFilesPublicProgress['folders'] =
    progress.folders && progress.folders.length > 0
      ? progress.folders
      : [
          {
            id: progress.folderId,
            name: progress.folderName,
            connector: progress.connector,
            creates: createdCount,
            updates: updatedCount,
            deletes: deletedCount,
            totalFiles: progress.totalFiles ?? 0,
            createdPaths: progress.createdPaths ?? [],
            updatedPaths: progress.updatedPaths ?? [],
            deletedPaths: progress.deletedPaths ?? [],
            status: progress.status,
            mode: progress.mode,
          },
        ];

  const folders: JobResultFolder[] = breakdown.map((folder) => ({
    id: folder.id,
    name: folder.name,
    connector: folder.connector,
    created: folder.creates ?? 0,
    updated: folder.updates ?? 0,
    deleted: folder.deletes ?? 0,
    skipped: 0,
    errorCount: folder.error ? 1 : 0,
    warningCount: 0,
    createdPaths: folder.createdPaths ?? [],
    updatedPaths: folder.updatedPaths ?? [],
    deletedPaths: folder.deletedPaths ?? [],
    status: folder.status,
    mode: folder.mode,
  }));

  const files = folders.flatMap(filesFromFolder);
  const errors = Object.values(progress.folderErrors ?? {}).map((error) => `${error.folderName}: ${error.message}`);

  return { summary, stats, folders, files, errors, warnings: [], mode: isIncrementalPull ? 'incremental' : 'full' };
}

// ── Sync ─────────────────────────────────────────────────────────────────────

function deriveSyncResult(progress: SyncDataFoldersPublicProgress | undefined): JobResult {
  if (!progress) {
    return { summary: 'Sync completed', stats: [], folders: [], files: [], errors: [], warnings: [] };
  }

  const tables = progress.tables ?? [];
  const tableCount = tables.length;
  const totalRecordsSynced = progress.totalFilesSynced ?? 0;
  const summary =
    totalRecordsSynced === 0
      ? `Synced ${pluralize(tableCount, 'table')} — no changes`
      : `Synced ${pluralize(totalRecordsSynced, 'record')} across ${pluralize(tableCount, 'table')}`;

  const sum = (selector: (table: SyncDataFoldersPublicProgress['tables'][number]) => number): number =>
    tables.reduce((total, table) => total + (selector(table) ?? 0), 0);
  // A sync STAGES changes that a later publish step actually executes, so these counters describe what
  // *will* happen on publish ("to create"), not a completed action ("created").
  const stats: JobResultStat[] = [
    { label: 'to create', value: sum((t) => t.creates) },
    { label: 'to update', value: sum((t) => t.updates) },
    { label: 'to delete', value: sum((t) => t.deletes) },
    { label: 'skipped', value: sum((t) => t.skipped) },
  ];

  // `publicProgress` is a JSON column that can be partial on an old/odd record, so coalesce every
  // field rather than trusting the array/count to be present.
  const folders: JobResultFolder[] = tables.map((table) => ({
    id: table.id,
    name: table.name,
    connector: table.connector,
    created: table.creates ?? 0,
    updated: table.updates ?? 0,
    deleted: table.deletes ?? 0,
    skipped: table.skipped ?? 0,
    errorCount: table.errorCount ?? table.errors?.length ?? 0,
    warningCount: table.warningCount ?? table.warnings?.length ?? 0,
    createdPaths: table.createdPaths ?? [],
    updatedPaths: table.updatedPaths ?? [],
    deletedPaths: table.deletedPaths ?? [],
    status: table.status,
  }));

  const files = folders.flatMap(filesFromFolder);
  const errors = tables.flatMap((table) => (table.errors ?? []).map((error) => `${table.name}: ${error.error}`));
  const warnings = tables.flatMap((table) =>
    (table.warnings ?? []).map((warning) => `${table.name}: ${warning.warning}`),
  );

  return { summary, stats, folders, files, errors, warnings };
}

// ── Publish ──────────────────────────────────────────────────────────────────

/**
 * A publish job emits the same `Job.type` ('publish') whether it staged a plan or ran it; the
 * distinction lives on the routine step's action. Callers that know it (the executor) pass `mode`
 * so the summary reads "Staged a publish plan …" vs "Published …"; the default ('run') is correct
 * for a generic completed publish job.
 */
function derivePublishResult(progress: PublishPublicProgress | undefined, mode: 'plan' | 'run'): JobResult {
  if (!progress) {
    return {
      summary: mode === 'plan' ? 'Publish plan staged' : 'Publish completed',
      stats: [],
      folders: [],
      files: [],
      errors: [],
      warnings: [],
    };
  }

  if (mode === 'plan') {
    const createsPlanned = progress.createsPlanned ?? 0;
    const editsPlanned = progress.editsPlanned ?? 0;
    const deletesPlanned = progress.deletesPlanned ?? 0;
    const plannedChangeCount = createsPlanned + editsPlanned + deletesPlanned;
    const summary =
      plannedChangeCount === 0 ? 'No changes' : `Staged a publish plan (${pluralize(plannedChangeCount, 'change')})`;
    const stats: JobResultStat[] = [
      { label: 'Creates planned', value: createsPlanned },
      { label: 'Updates planned', value: editsPlanned },
      { label: 'Deletes planned', value: deletesPlanned },
    ];
    return { summary, stats, folders: [], files: [], errors: [], warnings: [] };
  }

  const createsExecuted = progress.createsExecuted ?? 0;
  const editsExecuted = progress.editsExecuted ?? 0;
  const deletesExecuted = progress.deletesExecuted ?? 0;
  const failedCount = progress.failedCount ?? 0;
  const executedChangeCount = createsExecuted + editsExecuted + deletesExecuted;
  // Any connector rejection leads with a failure headline. When the publish only partially failed we
  // still report how many changes the connector accepted ("… • N successful").
  let summary: string;
  if (failedCount > 0) {
    // Attribute the rejection to the destination service ("rejected by PostgreSQL") so it's clear the
    // service rejected the records, not Scratch. Falls back to a bare "rejected" when the service name
    // wasn't resolved.
    const rejectedClause = progress.destinationServiceName
      ? `${pluralize(failedCount, 'update')} rejected by ${progress.destinationServiceName}`
      : `${pluralize(failedCount, 'update')} rejected`;
    const summaryParts = ['Publishing failed', rejectedClause];
    if (executedChangeCount > 0) {
      summaryParts.push(`${executedChangeCount} successful`);
    }
    summary = summaryParts.join(' • ');
  } else {
    summary = executedChangeCount === 0 ? 'No changes' : `Published ${pluralize(executedChangeCount, 'change')}`;
  }

  const stats: JobResultStat[] = [
    { label: 'Created', value: createsExecuted },
    { label: 'Updated', value: editsExecuted },
    { label: 'Deleted', value: deletesExecuted },
  ];
  if (failedCount > 0) {
    stats.push({ label: 'Rejected', value: failedCount });
  }

  const errors = (progress.failedOperations ?? [])
    .map((operation) => operation.error)
    .filter((message): message is string => typeof message === 'string' && message.length > 0);

  return { summary, stats, folders: [], files: [], errors, warnings: [] };
}

// ── Dispatcher ─────────────────────────────────────────────────────────────

/** Input for {@link deriveJobResult}. `publishMode` is only consulted for publish jobs. */
export interface DeriveJobResultInput {
  type: string;
  publicProgress?: unknown;
  /** For publish jobs: whether the step staged a plan or ran it. Defaults to 'run'. */
  publishMode?: 'plan' | 'run';
}

/**
 * Turn a job's `type` + `publicProgress` into a normalized, render-ready {@link JobResult}. Returns
 * an empty result for job categories without a normalized renderer yet (e.g. rehost), so callers can
 * fall back to a type-specific view.
 */
export function deriveJobResult(input: DeriveJobResultInput): JobResult {
  const kind = categorizeJobType(input.type);
  switch (kind) {
    case 'pull':
      return derivePullResult(input.publicProgress as PullLinkedFolderFilesPublicProgress | undefined);
    case 'sync':
      return deriveSyncResult(input.publicProgress as SyncDataFoldersPublicProgress | undefined);
    case 'publish':
      return derivePublishResult(input.publicProgress as PublishPublicProgress | undefined, input.publishMode ?? 'run');
    case 'rehost':
    case 'unknown':
    default:
      return { summary: '', stats: [], folders: [], files: [], errors: [], warnings: [] };
  }
}
