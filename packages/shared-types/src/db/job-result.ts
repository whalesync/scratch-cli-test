import { JobType } from '../job-types';
import {
  DiscardPendingChangesPublicProgress,
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
/// The derivation is aware of whether the job has FINISHED (see `isRunning`): a finished job gets a
/// past-tense final tally, an in-flight one a present-tense progress line, so a live job never renders
/// as though its not-yet-started counters were the result.
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
export type JobResultKind = 'pull' | 'sync' | 'publish' | 'rehost' | 'discard' | 'unknown';

/**
 * Map a raw `Job.type` string to its broad category. Mirrors the client's `getJobType`, lifted here
 * so the shared derivation (and any frontend) can categorize a job without re-declaring the logic.
 */
export function categorizeJobType(type: string): JobResultKind {
  // 'apply-sync-draft' contains 'sync' but its progress is NOT the sync-job shape — it has no
  // normalized renderer here (the Live Export save modal renders ApplySyncDraftPublicProgress
  // directly), so keep it out of the substring buckets below.
  if (type === JobType.ApplySyncDraft) return 'unknown';
  if (type.includes('discard')) return 'discard';
  if (type.includes('sync')) return 'sync';
  if (type.includes('publish') || type.includes('pipeline')) return 'publish';
  if (type.includes('pull') || type === JobType.RefreshRecords) return 'pull';
  if (type === JobType.RehostAssets) return 'rehost';
  return 'unknown';
}

/** Formats a count (with thousand separators) and its singular/plural noun, e.g. `1 folder`, `1,234 records`. */
function pluralize(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
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

function derivePullResult(progress: PullLinkedFolderFilesPublicProgress | undefined, isRunning: boolean): JobResult {
  if (!progress) {
    return {
      summary: isRunning ? 'Pulling…' : 'Pull completed',
      stats: [],
      folders: [],
      files: [],
      errors: [],
      warnings: [],
    };
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
  const completedPullSummary =
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
  // misleadingly imply the rest of the folder doesn't exist. It is also meaningless MID-RUN: records
  // are fetched (Phase 1) long before they are written to disk (Phase 2), so a running pull would
  // report every record fetched so far as "Unchanged".
  if (!isIncrementalPull && !isRunning) {
    const unchangedCount = Math.max(0, (progress.totalFiles ?? 0) - createdCount - updatedCount);
    stats.push({ label: 'Unchanged', value: unchangedCount });
  }

  // Prefer the per-folder breakdown (enriched server-side). Fall back to a single synthetic row built
  // from the run-wide aggregate so older progress records (no `folders`) still render one folder.
  const hasPerFolderBreakdown = (progress.folders ?? []).length > 0;
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

  const summary = isRunning
    ? summarizePullInProgress(folders, hasPerFolderBreakdown, folderCount, progress.totalFiles ?? 0)
    : completedPullSummary;

  return { summary, stats, folders, files, errors, warnings: [], mode: isIncrementalPull ? 'incremental' : 'full' };
}

/**
 * Present-tense headline for a pull that is STILL RUNNING: what it is pulling right now plus how many
 * records it has fetched so far. Names the folder when exactly one is in flight (a single-folder pull,
 * or Phase 2, which processes folders one at a time); Phase 1 fetches several folders concurrently, so
 * there it reports the folder count rather than arbitrarily picking one of them to name.
 */
function summarizePullInProgress(
  folders: JobResultFolder[],
  hasPerFolderBreakdown: boolean,
  folderCount: number,
  fetchedRecordCount: number,
): string {
  const totalFolderCount = Math.max(folderCount, folders.length);
  // Only a REAL per-folder breakdown can say which folder is in flight. Without one the rows here are a
  // single synthetic row built from the run-wide aggregate, whose name is just whichever folder the job
  // happened to be on — it names the pull only when the run is a single folder anyway.
  const activeFolders = hasPerFolderBreakdown ? folders.filter((folder) => folder.status === 'active') : [];
  const onlyFolderInFlight =
    activeFolders.length === 1 ? activeFolders[0] : totalFolderCount === 1 ? folders[0] : undefined;
  const pullTargetLabel =
    onlyFolderInFlight?.name || (totalFolderCount > 0 ? pluralize(totalFolderCount, 'folder') : '');
  if (!pullTargetLabel) {
    return fetchedRecordCount > 0 ? `Pulling — ${pluralize(fetchedRecordCount, 'record')} fetched` : 'Pulling…';
  }
  return fetchedRecordCount > 0
    ? `Pulling ${pullTargetLabel} — ${pluralize(fetchedRecordCount, 'record')} fetched`
    : `Pulling ${pullTargetLabel}…`;
}

// ── Sync ─────────────────────────────────────────────────────────────────────

function deriveSyncResult(progress: SyncDataFoldersPublicProgress | undefined, isRunning: boolean): JobResult {
  if (!progress) {
    return {
      summary: isRunning ? 'Syncing…' : 'Sync completed',
      stats: [],
      folders: [],
      files: [],
      errors: [],
      warnings: [],
    };
  }

  const tables = progress.tables ?? [];
  const tableCount = tables.length;
  const totalRecordsSynced = progress.totalFilesSynced ?? 0;
  const summary = isRunning
    ? summarizeSyncInProgress(tables, totalRecordsSynced)
    : totalRecordsSynced === 0
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

/**
 * Present-tense headline for a sync that is STILL RUNNING. A sync processes its tables one at a time
 * and marks the one it is on `in_progress`, so the table in flight can be named. `totalFilesSynced`
 * only advances when a table finishes, so early in a long table this reports the records staged by the
 * tables before it — which is what "so far" means here.
 */
function summarizeSyncInProgress(tables: SyncDataFoldersPublicProgress['tables'], totalRecordsSynced: number): string {
  const tablesInProgress = tables.filter((table) => table.status === 'in_progress');
  const onlyTableInFlight =
    tablesInProgress.length === 1 ? tablesInProgress[0] : tables.length === 1 ? tables[0] : undefined;
  const syncTargetLabel = onlyTableInFlight?.name || (tables.length > 0 ? pluralize(tables.length, 'table') : '');
  if (!syncTargetLabel) {
    return totalRecordsSynced > 0 ? `Syncing — ${pluralize(totalRecordsSynced, 'record')} synced` : 'Syncing…';
  }
  return totalRecordsSynced > 0
    ? `Syncing ${syncTargetLabel} — ${pluralize(totalRecordsSynced, 'record')} synced`
    : `Syncing ${syncTargetLabel}…`;
}

// ── Discard pending changes (pre-flight cleanup) ─────────────────────────────

/**
 * A discard-pending-changes step runs FIRST in a generated sync routine to clear any leftover
 * working-set edits before the pull → sync → publish. Its result is framed as routine pre-flight
 * (not data loss): a clean workspace reads "nothing to clear", and when edits were present it
 * reports how many were cleared plus a per-connection/file breakdown for the drill-down — so the
 * user can see exactly what stray state was tidied up before the sync.
 */
function deriveDiscardResult(progress: DiscardPendingChangesPublicProgress | undefined, isRunning: boolean): JobResult {
  if (!progress) {
    return {
      summary: isRunning ? 'Clearing leftover changes…' : 'Workspace ready',
      stats: [],
      folders: [],
      files: [],
      errors: [],
      warnings: [],
    };
  }

  const totalDiscarded = progress.totalDiscarded ?? 0;
  const summary = isRunning
    ? 'Clearing leftover changes…'
    : totalDiscarded === 0
      ? 'Workspace ready — no leftover changes to clear'
      : `Cleared ${pluralize(totalDiscarded, 'leftover change')} so the sync starts from a clean slate`;

  const stats: JobResultStat[] = [{ label: 'Cleared', value: totalDiscarded }];

  // One breakdown row per connection that had pending edits — uniform with pull (folders) and sync
  // (tables) so the same UI renders it. A pending add/modify/delete maps to Created/Updated/Deleted.
  const folders: JobResultFolder[] = (progress.connections ?? []).map((connection) => ({
    id: connection.connectorAccountId,
    name: connection.connectionName,
    connector: connection.connector,
    created: connection.addedCount ?? 0,
    updated: connection.modifiedCount ?? 0,
    deleted: connection.deletedCount ?? 0,
    skipped: 0,
    errorCount: 0,
    warningCount: 0,
    createdPaths: connection.addedPaths ?? [],
    updatedPaths: connection.modifiedPaths ?? [],
    deletedPaths: connection.deletedPaths ?? [],
    status: 'completed',
  }));

  const files = folders.flatMap(filesFromFolder);

  return { summary, stats, folders, files, errors: [], warnings: [] };
}

// ── Publish ──────────────────────────────────────────────────────────────────

/**
 * A publish job emits the same `Job.type` ('publish') whether it staged a plan or ran it; the
 * distinction lives on the routine step's action. Callers that know it (the executor) pass `mode`
 * so the summary reads "Staged a publish plan …" vs "Published …"; the default ('run') is correct
 * for a generic completed publish job.
 */
function derivePublishResult(
  progress: PublishPublicProgress | undefined,
  mode: 'plan' | 'run',
  isRunning: boolean,
): JobResult {
  if (!progress) {
    return {
      summary: isRunning
        ? inProgressPublishSummary(undefined, mode)
        : mode === 'plan'
          ? 'Publish plan staged'
          : 'Publish completed',
      stats: [],
      folders: [],
      files: [],
      errors: [],
      warnings: [],
    };
  }

  if (isRunning) {
    // The counters below are what has shipped SO FAR, so neither the plan nor the run headline is a
    // result yet — report what the job is doing and how far through the plan it is instead.
    const stats: JobResultStat[] = [
      { label: 'Created', value: progress.createsExecuted ?? 0 },
      { label: 'Updated', value: progress.editsExecuted ?? 0 },
      { label: 'Deleted', value: progress.deletesExecuted ?? 0 },
    ];
    return {
      summary: inProgressPublishSummary(progress, mode),
      stats: mode === 'plan' ? [] : stats,
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
      summaryParts.push(`${executedChangeCount.toLocaleString()} successful`);
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

/**
 * Present-tense headline for a publish that is STILL RUNNING. A publish job plans before it ships, so
 * it reports the planning phase first and then how much of the plan it has executed — the planned
 * totals are known once planning finishes, which is what makes "120 of 340 changes" possible here
 * (pull and sync have no comparable up-front total).
 */
function inProgressPublishSummary(progress: PublishPublicProgress | undefined, mode: 'plan' | 'run'): string {
  if (mode === 'plan') {
    return 'Building the publish plan…';
  }
  if (!progress || progress.status === 'planning') {
    return 'Planning the publish…';
  }
  const plannedChangeCount =
    (progress.createsPlanned ?? 0) + (progress.editsPlanned ?? 0) + (progress.deletesPlanned ?? 0);
  const executedChangeCount =
    (progress.createsExecuted ?? 0) + (progress.editsExecuted ?? 0) + (progress.deletesExecuted ?? 0);
  return plannedChangeCount > 0
    ? `Publishing ${executedChangeCount.toLocaleString()} of ${pluralize(plannedChangeCount, 'change')}`
    : 'Publishing changes…';
}

// ── Dispatcher ─────────────────────────────────────────────────────────────

/** Input for {@link deriveJobResult}. `publishMode` is only consulted for publish jobs. */
export interface DeriveJobResultInput {
  type: string;
  publicProgress?: unknown;
  /** For publish jobs: whether the step staged a plan or ran it. Defaults to 'run'. */
  publishMode?: 'plan' | 'run';
  /**
   * Whether the job is STILL RUNNING. A finished job's summary is a past-tense final tally ("Pulled 3
   * folders — no changes"); an in-flight job's counters are not a result yet, so it gets a present-tense
   * progress line instead ("Pulling Companies — 1,200 records fetched"). Defaults to false (finished).
   *
   * Pass it from whatever the caller already holds: a frontend has `job.state` ('active' / 'waiting' /
   * 'delayed' ⇒ running), the routine executor knows whether its step's job is still in flight. Do NOT
   * infer it from `publicProgress.status` — a pull flips its run-wide status to 'completed' as soon as
   * the FIRST folder finishes, so it reads 'completed' well before the job is done.
   */
  isRunning?: boolean;
}

/**
 * Turn a job's `type` + `publicProgress` into a normalized, render-ready {@link JobResult}. Returns
 * an empty result for job categories without a normalized renderer yet (e.g. rehost), so callers can
 * fall back to a type-specific view.
 */
export function deriveJobResult(input: DeriveJobResultInput): JobResult {
  const kind = categorizeJobType(input.type);
  const isRunning = input.isRunning ?? false;
  switch (kind) {
    case 'pull':
      return derivePullResult(input.publicProgress as PullLinkedFolderFilesPublicProgress | undefined, isRunning);
    case 'sync':
      return deriveSyncResult(input.publicProgress as SyncDataFoldersPublicProgress | undefined, isRunning);
    case 'publish':
      return derivePublishResult(
        input.publicProgress as PublishPublicProgress | undefined,
        input.publishMode ?? 'run',
        isRunning,
      );
    case 'discard':
      return deriveDiscardResult(input.publicProgress as DiscardPendingChangesPublicProgress | undefined, isRunning);
    case 'rehost':
    case 'unknown':
    default:
      return { summary: '', stats: [], folders: [], files: [], errors: [], warnings: [] };
  }
}
