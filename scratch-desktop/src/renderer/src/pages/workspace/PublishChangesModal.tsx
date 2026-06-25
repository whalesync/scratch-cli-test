import { scratchApiClient } from '@/lib/scratch-api-client';
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Code,
  Group,
  Loader,
  Modal,
  Progress,
  ScrollArea,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import type { Job, PublishFailedOperation } from '@spinner/shared-types';
import { CheckCircle2, Circle, XCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ValidationStat } from '../../../../shared/validation-types';
import {
  trackPublishCompleted,
  trackPublishReviewOnWeb,
  trackPublishStarted,
  trackPublishUploadCompleted,
  trackPublishUploadStarted,
} from '../../lib/posthog';
import { useWorkspaceUiStore } from '../../stores/workspace-ui-store';
import type { SingleRecordPublishTarget } from './single-record-publish-target';

interface UnreviewedChangeEntry {
  connectionName: string;
  path: string;
  status: string;
}

type PublishMode =
  | 'approval'
  | 'uploading'
  | 'uploaded'
  | 'publishing'
  | 'complete'
  | 'error'
  | 'stale'
  // DEV-10316: the connection has unpublished changes on the server — either
  // detected at upload (the CLI's `blocked_dirty` refusal) or at publish (the
  // plan-build TOCTOU drift abort). Count-only redirect to the web review screen.
  | 'dirty'
  // DEV-10316: the dirty-gate check couldn't run; retryable ("Try again").
  | 'checkFailed';

type UploadResult = Awaited<ReturnType<typeof window.scratchDesktop.uploadWorkspaceChanges>>;
type UploadSuccess = Extract<UploadResult, { status: 'uploaded' | 'no_changes' | 'up_to_date' }>;
type UploadBlockedStale = Extract<UploadResult, { status: 'blocked_stale' }>;
type UploadCheckFailed = Extract<UploadResult, { status: 'check_failed' }>;
type UploadConnection = UploadSuccess['connections'][number];

/**
 * Count-only connection entry shown in the `dirty` redirect. Unifies the
 * upload-time `blocked_dirty` shape and the publish-time TOCTOU drift shape —
 * both render as "<connection> · <N> change(s)".
 */
interface DirtyGateConnection {
  connectionName: string;
  dirtyCount: number;
}

/** Lead line shown above the `dirty` redirect when entered via a publish-time TOCTOU drift abort. */
const TOCTOU_DRIFT_LEAD =
  'The server changed while you were reviewing — there are now unpublished changes to resolve first.';

interface ConnectionPublishState {
  connectionId: string;
  connectionName: string;
  /**
   * `planning` — POST plan-job, then poll until plan-job is terminal.
   * `plan-no-diff` — server's dirty matches main; nothing to publish for this connection.
   * `running` — plan-job done, run-job enqueued and being polled.
   * `completed` — run-job terminal with no failures.
   * `failed` — plan-job or run-job failed, or run-job's progress reports failures.
   */
  status: 'pending' | 'planning' | 'plan-no-diff' | 'running' | 'completed' | 'failed';
  planJobId?: string;
  runJobId?: string;
  pipelineId?: string;
  failureMessage?: string;
  /**
   * Publish redesign (DEV-10048): the run-job's `failedOperations` (connector
   * rejections), captured when the run-job reaches a terminal state. Passed to the
   * per-connection post-publish `reconcileAfterPublish` so the rejected records
   * land in `failed-patches.json`. Empty/undefined when nothing was rejected.
   */
  failedOperations?: PublishFailedOperation[];
}

interface PublishChangesModalProps {
  opened: boolean;
  onClose: () => void;
  workspaceName?: string | null;
  workspaceId?: string | null;
  localPath: string | null;
  autoStartUploadOnOpen?: boolean;
  assumeUnreviewedApproved?: boolean;
  invalidateWorkspaceLevelData: () => void;
  /** The currently selected folder path in the workspace grid. */
  currentFolderPath?: string | null;
  /** Called when the user wants to view problems in the grid. */
  onViewProblems?: (folderPath: string) => void;
  /**
   * DEV-10413: when set, the modal publishes ONLY this one record (scoped
   * upload + scoped plan + scoped reconcile) instead of the whole workspace.
   * The workspace-wide unreviewed guard is skipped (the record is already
   * reviewed); validation is scoped to this record.
   */
  singleRecord?: SingleRecordPublishTarget;
}

function isTerminalState(state: Job['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'canceled' || state === 'unknown';
}

/**
 * Step-by-step progress shown during long-running modal phases (loadInitialState,
 * accept-all/discard-all + upload, publish-now re-check). Replaces the bare
 * spinner with "what is the modal actually doing right now" granularity, since
 * each step can run 1–3s on a workspace the size of the Monorepo and silent
 * spinners feel slower than they are.
 */
type ProgressStepStatus = 'pending' | 'active' | 'done' | 'error';
interface ProgressStep {
  /** Stable key for the React list. Also doubles as the status-update target. */
  id: string;
  /** Initial label. Updated via `markStepDone(id, finalLabel)` once it completes. */
  label: string;
  status: ProgressStepStatus;
}

function ProgressStepList({ steps }: { steps: ProgressStep[] }) {
  return (
    <Stack gap="xs" py="sm">
      {steps.map((step) => (
        <Group gap="xs" key={step.id} wrap="nowrap">
          {step.status === 'active' && <Loader size={14} />}
          {step.status === 'done' && <CheckCircle2 size={16} color="var(--mantine-color-green-6)" />}
          {step.status === 'error' && <XCircle size={16} color="var(--mantine-color-red-6)" />}
          {step.status === 'pending' && <Circle size={16} color="var(--mantine-color-gray-5)" />}
          <Text size="sm" c={step.status === 'pending' ? 'dimmed' : undefined}>
            {step.label}
          </Text>
        </Group>
      ))}
    </Stack>
  );
}

function formatDiffSummary(created: number, updated: number, deleted: number): string {
  const parts: string[] = [];
  if (created > 0) parts.push(`${created} added`);
  if (updated > 0) parts.push(`${updated} modified`);
  if (deleted > 0) parts.push(`${deleted} deleted`);
  return parts.length > 0 ? parts.join(' · ') : 'No changes';
}

function modeTitle(mode: PublishMode): string {
  switch (mode) {
    case 'approval':
      return 'Publish changes';
    case 'uploading':
      return 'Uploading changes';
    case 'uploaded':
      return 'Ready to publish';
    case 'publishing':
      return 'Publishing changes';
    case 'complete':
      return 'Published';
    case 'error':
      return 'Publish failed';
    case 'stale':
      return 'Server has newer changes';
    case 'dirty':
      return 'Unpublished changes on the server';
    case 'checkFailed':
      return "Couldn't verify the server's state";
  }
}

function statusColor(state: Job['state']): string {
  switch (state) {
    case 'completed':
      return 'green';
    case 'failed':
    case 'canceled':
      return 'red';
    case 'active':
      return 'blue';
    default:
      return 'gray';
  }
}

interface PublishPipelineProgress {
  status?: string;
  processedCount?: number;
  totalCount?: number;
  currentPhase?: string;
  currentTableName?: string;
  successCount?: number;
  failedCount?: number;
  /**
   * Bounded per-record connector rejections from the run, each carrying the
   * connector's user-facing `error`. Lets the modal show *why* a record didn't
   * publish rather than "N operations failed". `failedCount` is the true total
   * (may exceed this list's length when the server capped it).
   */
  failedOperations?: PublishFailedOperation[];
  editsPlanned?: number;
  createsPlanned?: number;
  deletesPlanned?: number;
  backfillsPlanned?: number;
  renameFilesPlanned?: number;
  /**
   * DEV-10316: present (with `status: 'failed'`) when the plan-build aborted
   * because the connection's dirty HEAD drifted past the desktop's
   * `expectedBaseDirtyHead` since upload. The modal reads this off the plan
   * job's progress to route into the count-only `dirty` redirect.
   */
  blockedDirtyDrift?: { connectorAccountId: string; dirtyCount: number };
}

function hasPublishFailures(job: Job | undefined): boolean {
  const progress = job?.publicProgress as PublishPipelineProgress | undefined;
  return (progress?.failedCount ?? 0) > 0;
}

/** `Activities/call-nishant.json` → `call-nishant` for a readable record label. */
function recordNameFromPath(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  return base.endsWith('.json') ? base.slice(0, -'.json'.length) : base;
}

/**
 * Group connector rejections by their error message so each distinct reason is
 * shown once with the affected record name(s) — instead of surfacing only the
 * first failure. Operations with no error message are dropped (the caller falls
 * back to the one-line summary for those). Order follows first appearance.
 */
function groupFailuresByError(operations: PublishFailedOperation[]): { error: string; records: string[] }[] {
  const groups: { error: string; records: string[] }[] = [];
  const groupIndexByError = new Map<string, number>();
  for (const operation of operations) {
    if (!operation.error) continue;
    const recordName = recordNameFromPath(operation.filePath);
    const existingIndex = groupIndexByError.get(operation.error);
    if (existingIndex === undefined) {
      groupIndexByError.set(operation.error, groups.length);
      groups.push({ error: operation.error, records: [recordName] });
    } else {
      groups[existingIndex].records.push(recordName);
    }
  }
  return groups;
}

/** Join record names for display, capping the visible count with a "+N more" tail. */
function formatRecordList(records: string[]): string {
  const MAX_VISIBLE_RECORD_NAMES = 5;
  if (records.length <= MAX_VISIBLE_RECORD_NAMES) return records.join(', ');
  return `${records.slice(0, MAX_VISIBLE_RECORD_NAMES).join(', ')} +${records.length - MAX_VISIBLE_RECORD_NAMES} more`;
}

function getPublishFailureMessage(job: Job): string {
  const progress = job.publicProgress as PublishPipelineProgress | undefined;
  const failedCount = progress?.failedCount ?? 0;
  const failedOps = progress?.failedOperations ?? [];

  // Best: the connector's own per-record rejection message — the actionable
  // "why" (e.g. "'person_id' is a read-only field. Add a primary participant…").
  const opsWithError = failedOps.filter((op) => op.error);
  if (opsWithError.length > 0) {
    const first = opsWithError[0];
    // `failedCount` is the authoritative total; the ops list may be capped, so
    // derive "others" from it rather than the (possibly shorter) list length.
    const otherFailures = Math.max(failedCount, opsWithError.length) - 1;
    const suffix =
      otherFailures > 0
        ? ` (and ${otherFailures.toLocaleString()} other record${otherFailures === 1 ? '' : 's'} failed)`
        : '';
    return `${recordNameFromPath(first.filePath)}: ${first.error ?? ''}${suffix}`;
  }

  // A hard plan/run-job failure (the job itself threw) carries failedReason.
  if (job.failedReason) {
    return job.failedReason;
  }
  // Records were rejected but the server returned no per-record message for them
  // (the connector produced no extractable detail).
  if (failedCount > 0) {
    return `${failedCount.toLocaleString()} record${failedCount === 1 ? '' : 's'} ${
      failedCount === 1 ? 'was' : 'were'
    } rejected by the connector, but no error detail was returned.`;
  }
  return 'One or more publish jobs did not complete successfully.';
}

const PHASE_ORDER = ['edit', 'create', 'delete', 'backfill', 'rename'] as const;
type Phase = (typeof PHASE_ORDER)[number];

const PHASE_LABELS: Record<Phase, string> = {
  edit: 'Edits',
  create: 'Creates',
  delete: 'Deletes',
  backfill: 'Backfills',
  rename: 'Renames',
};

const PHASE_PLANNED_KEY: Record<Phase, keyof PublishPipelineProgress> = {
  edit: 'editsPlanned',
  create: 'createsPlanned',
  delete: 'deletesPlanned',
  backfill: 'backfillsPlanned',
  rename: 'renameFilesPlanned',
};

function computePhaseRows(progress: PublishPipelineProgress) {
  const currentPhaseIdx = PHASE_ORDER.indexOf((progress.currentPhase ?? '') as Phase);
  let remaining = progress.processedCount ?? 0;

  return PHASE_ORDER.map((phase, idx) => {
    const planned = (progress[PHASE_PLANNED_KEY[phase]] as number | undefined) ?? 0;
    let done: number;

    if (idx < currentPhaseIdx) {
      done = planned;
      remaining -= planned;
    } else if (idx === currentPhaseIdx) {
      done = Math.min(remaining, planned);
      remaining = 0;
    } else {
      done = 0;
    }

    return { phase, label: PHASE_LABELS[phase], planned, done };
  });
}

function ConnectionPublishRow({ connection, job }: { connection: ConnectionPublishState; job: Job | undefined }) {
  const progress = job?.publicProgress as PublishPipelineProgress | undefined;
  const total = progress?.totalCount ?? 0;
  const processed = progress?.processedCount ?? 0;
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
  const hasProgress = total > 0;
  const rows = progress ? computePhaseRows(progress) : null;
  const currentTable = progress?.currentTableName;

  // Per-record connector rejections, grouped by message so distinct reasons each
  // show once. `failedCount` is the authoritative total; the ops list is capped
  // server-side, so some failures may not be represented in the groups.
  const failureGroups = groupFailuresByError(progress?.failedOperations ?? []);
  const shownFailureRecordCount = failureGroups.reduce((sum, group) => sum + group.records.length, 0);
  const unshownFailureCount = Math.max(0, (progress?.failedCount ?? 0) - shownFailureRecordCount);

  const statusLabel = (() => {
    switch (connection.status) {
      case 'pending':
        return 'Waiting…';
      case 'planning':
        return 'Planning…';
      case 'plan-no-diff':
        return 'No changes to publish';
      case 'running':
        return job?.state === 'active' ? 'Publishing…' : (job?.state ?? 'queued');
      case 'completed':
        return 'Complete';
      case 'failed':
        return 'Failed';
    }
  })();

  const statusBadgeColor = (() => {
    switch (connection.status) {
      case 'completed':
        return 'green';
      case 'failed':
        return 'red';
      case 'plan-no-diff':
        return 'gray';
      case 'running':
        return statusColor(job?.state ?? 'created');
      default:
        return 'blue';
    }
  })();

  return (
    <Box>
      <Group justify="space-between" mb={4}>
        <Group gap="xs">
          {(connection.status === 'planning' || (connection.status === 'running' && !hasProgress)) && (
            <Loader size={12} />
          )}
          <Text size="sm" fw={600}>
            {connection.connectionName}
          </Text>
          {currentTable && (
            <Text size="xs" c="dimmed">
              {currentTable}
            </Text>
          )}
        </Group>
        <Badge color={statusBadgeColor} size="sm">
          {hasProgress && connection.status === 'running' ? `${processed} / ${total}` : statusLabel}
        </Badge>
      </Group>

      {hasProgress && connection.status === 'running' && (
        <>
          <Progress value={pct} size="sm" mb="sm" animated={job?.state === 'active'} />

          {((progress?.successCount ?? 0) > 0 || (progress?.failedCount ?? 0) > 0) && (
            <Group gap="xs" mb="xs">
              <Badge color="green" variant="light">
                {(progress?.successCount ?? 0).toLocaleString()} succeeded
              </Badge>
              <Badge color="red" variant="light">
                {(progress?.failedCount ?? 0).toLocaleString()} failed
              </Badge>
            </Group>
          )}

          <Table withColumnBorders fz="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Operation</Table.Th>
                <Table.Th>Planned</Table.Th>
                <Table.Th>Done</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows?.map(({ phase, label, planned, done }) => {
                const isActive = phase === progress?.currentPhase;
                const isComplete = done > 0 && done >= planned && planned > 0;
                return (
                  <Table.Tr key={phase} bg={isActive ? 'var(--mantine-color-blue-light)' : undefined}>
                    <Table.Td>
                      <Group gap={4}>
                        {isActive && <Loader size={10} />}
                        <Text size="xs" fw={isActive ? 600 : 400} c={planned === 0 ? 'dimmed' : undefined}>
                          {label}
                        </Text>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c={planned === 0 ? 'dimmed' : undefined}>
                        {planned === 0 ? '—' : planned.toLocaleString()}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c={isComplete ? 'green' : isActive ? 'blue' : 'dimmed'}>
                        {planned === 0 ? '—' : done.toLocaleString()}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </>
      )}

      {connection.status === 'failed' && (failureGroups.length > 0 || connection.failureMessage) && (
        <Alert color="red" mt="sm" title="Failure details">
          {failureGroups.length > 0 ? (
            <Stack gap={8}>
              {failureGroups.map((group) => (
                <Box key={group.error}>
                  <Text size="xs" fw={600}>
                    {formatRecordList(group.records)}
                  </Text>
                  <Text size="xs">{group.error}</Text>
                </Box>
              ))}
              {unshownFailureCount > 0 && (
                <Text size="xs" c="dimmed">
                  …and {unshownFailureCount.toLocaleString()} more record{unshownFailureCount === 1 ? '' : 's'} failed.
                </Text>
              )}
            </Stack>
          ) : (
            connection.failureMessage
          )}
        </Alert>
      )}
    </Box>
  );
}

async function loadValidationCounts(
  localPath: string,
): Promise<{ errors: number; warnings: number; records: number; stats: ValidationStat[] } | null> {
  try {
    const stats: ValidationStat[] = await window.scratchFiles.getValidationStats(localPath);
    return {
      errors: stats.reduce((s, r) => s + r.errors, 0),
      warnings: stats.reduce((s, r) => s + r.warnings, 0),
      records: stats.reduce((s, r) => s + r.records, 0),
      stats,
    };
  } catch {
    return null;
  }
}

export function PublishChangesModal({
  opened,
  onClose,
  workspaceName,
  workspaceId,
  localPath,
  autoStartUploadOnOpen = false,
  assumeUnreviewedApproved = false,
  invalidateWorkspaceLevelData,
  currentFolderPath,
  onViewProblems,
  singleRecord,
}: PublishChangesModalProps) {
  // Per-workbook "Validation" toggle (renderer-only display setting). When it's
  // off the publish pre-flight skips the validation gate entirely — see DEV-10522.
  const validateEnabled = useWorkspaceUiStore((s) => s.validateEnabled);
  const pollingIntervalRef = useRef<number | null>(null);
  const loggedCompleteJobIdsRef = useRef<Set<string>>(new Set());
  /**
   * Pending waits for jobs to reach a terminal state. A single shared poller
   * (see useEffect below) makes ONE `/jobs/bulk-status` call per second for
   * every job ID registered here and resolves the matching Promise when its
   * job finishes. This replaces the per-job + page-level pollers that used
   * to race each other against the rate-limited bulk-status endpoint.
   */
  const pendingWaitsRef = useRef<Map<string, (status: Job) => void>>(new Map());
  const [mode, setMode] = useState<PublishMode>('approval');
  const [initializing, setInitializing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unreviewedEntries, setUnreviewedEntries] = useState<UnreviewedChangeEntry[]>([]);
  const [uploadResult, setUploadResult] = useState<UploadSuccess | null>(null);
  const [blockedStale, setBlockedStale] = useState<UploadBlockedStale | null>(null);
  // DEV-10316: count-only `dirty` redirect. `lead` is set only when entered via
  // a publish-time TOCTOU drift abort (vs an upload-time `blocked_dirty`).
  const [blockedDirty, setBlockedDirty] = useState<{ connections: DirtyGateConnection[]; lead?: string } | null>(null);
  const [checkFailed, setCheckFailed] = useState<UploadCheckFailed | null>(null);
  const [stalenessBannerDismissed, setStalenessBannerDismissed] = useState(false);
  const [publishConnections, setPublishConnections] = useState<ConnectionPublishState[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [publishErrorDetails, setPublishErrorDetails] = useState<string[]>([]);
  const [closing, setClosing] = useState(false);
  const [progressSteps, setProgressSteps] = useState<ProgressStep[]>([]);
  const [validationCounts, setValidationCounts] = useState<{
    errors: number;
    warnings: number;
    records: number;
  } | null>(null);
  const [validationStats, setValidationStats] = useState<ValidationStat[]>([]);
  // DEV-10413: a soft notice shown in `complete` mode for the single-record
  // flow (e.g. "already published — cleaned up" vs "nothing new to publish").
  const [singleRecordNotice, setSingleRecordNotice] = useState<string | null>(null);

  const stalenessWarning = uploadResult?.stalenessWarning ?? null;

  const startUpload = useCallback(async () => {
    if (!localPath || !workspaceId) {
      return;
    }

    try {
      setError(null);
      setMode('uploading');
      setUploadResult(null);
      setBlockedStale(null);
      setBlockedDirty(null);
      setCheckFailed(null);
      setStalenessBannerDismissed(false);
      setProgressSteps((prev) => [
        ...prev,
        { id: 'upload', label: 'Uploading accepted edits to the server…', status: 'active' },
      ]);
      await trackPublishUploadStarted(workspaceId);

      // DEV-10413: scope the upload to the single record when in single-record
      // mode (skips the dirty gate, ships only this record's patch to dirty).
      const result = await window.scratchDesktop.uploadWorkspaceChanges(
        localPath,
        singleRecord ? { filePath: singleRecord.filePath } : undefined,
      );

      // D8: server `refs/heads/main` advanced past local — `files upload`
      // bailed before applying anything. Switch to the stale modal mode so
      // the user can `Download and publish` (= shell out to `files
      // download`, then retry upload) or Cancel.
      if (result.status === 'blocked_stale') {
        setBlockedStale(result);
        setProgressSteps((prev) =>
          prev.map((step) => {
            if (step.id !== 'upload') return step;
            const conn = result.connections[0];
            const label = conn
              ? `Server changes detected on ${conn.connectionName} — refresh required`
              : 'Server changes detected — refresh required';
            return { ...step, status: 'error', label };
          }),
        );
        setMode('stale');
        return;
      }

      // DEV-10316: the connection's `dirty` branch already holds unpublished
      // changes vs live `main` (typically the web sync's staged changes). The
      // upload bailed before applying anything. Redirect the user to resolve
      // them on the web — count-only, no per-record detail.
      if (result.status === 'blocked_dirty') {
        setBlockedDirty({ connections: result.connections });
        setProgressSteps((prev) =>
          prev.map((step) =>
            step.id === 'upload'
              ? { ...step, status: 'error', label: 'Unpublished changes on the server — resolve on the web first' }
              : step,
          ),
        );
        setMode('dirty');
        return;
      }

      // DEV-10316: the dirty-gate check itself couldn't run (git service
      // down/busy). Fail-closed — hold the publish with a retryable error
      // rather than risk an unguarded upload.
      if (result.status === 'check_failed') {
        setCheckFailed(result);
        setProgressSteps((prev) =>
          prev.map((step) =>
            step.id === 'upload' ? { ...step, status: 'error', label: "Couldn't verify the server's state" } : step,
          ),
        );
        setMode('checkFailed');
        return;
      }

      setUploadResult(result);

      const connectionsWithDiff = result.connections.filter((c) => c.status === 'uploaded');
      await trackPublishUploadCompleted(workspaceId, {
        filesCreated: result.filesCreated,
        filesUpdated: result.filesUpdated,
        filesDeleted: result.filesDeleted,
        connectionCount: connectionsWithDiff.length,
      });

      setProgressSteps((prev) =>
        prev.map((step) => {
          if (step.id !== 'upload') return step;
          if (result.status === 'no_changes' || result.status === 'up_to_date') {
            return { ...step, status: 'done', label: 'No changes to upload' };
          }
          const totalFiles = result.filesCreated + result.filesUpdated + result.filesDeleted;
          const connLabel = `${connectionsWithDiff.length} connection${connectionsWithDiff.length === 1 ? '' : 's'}`;
          const fileLabel = `${totalFiles.toLocaleString()} record${totalFiles === 1 ? '' : 's'}`;
          return { ...step, status: 'done', label: `Uploaded ${fileLabel} to ${connLabel}` };
        }),
      );

      if (result.status === 'no_changes' || result.status === 'up_to_date') {
        setMode('complete');
        return;
      }

      setMode('uploaded');
    } catch (err) {
      setProgressSteps((prev) => prev.map((step) => (step.status === 'active' ? { ...step, status: 'error' } : step)));
      setMode('error');
      setError(err instanceof Error ? err.message : 'Failed to upload workspace changes');
    }
  }, [localPath, workspaceId, singleRecord]);

  const loadSingleRecordInitialState = useCallback(async () => {
    // DEV-10413: scoped pre-flight. The record is already reviewed+approved (the
    // per-record Publish button only shows then), so skip the workspace-wide
    // unreviewed scan entirely. Validation is scoped to just this record.
    if (!localPath || !singleRecord) return;
    // DEV-10522: when the workbook's Validation toggle is off, there is no gate —
    // skip the validation check and upload straight away.
    if (!validateEnabled) {
      await startUpload();
      return;
    }
    setProgressSteps([{ id: 'validation', label: 'Checking this record for validation issues…', status: 'active' }]);
    const results = await window.scratchFiles.getValidationResults(
      localPath,
      singleRecord.folderPath,
      singleRecord.filename,
    );
    const errorCount = results.filter((r) => r.level === 'error').length;
    if (errorCount > 0) {
      setValidationCounts({ errors: errorCount, warnings: results.length - errorCount, records: 1 });
      setProgressSteps((prev) =>
        prev.map((step) =>
          step.id === 'validation' ? { ...step, status: 'error', label: 'This record has validation errors' } : step,
        ),
      );
      setMode('approval');
      return;
    }
    setProgressSteps((prev) =>
      prev.map((step) =>
        step.id === 'validation' ? { ...step, status: 'done', label: 'No validation issues' } : step,
      ),
    );
    await startUpload();
  }, [localPath, singleRecord, startUpload, validateEnabled]);

  const loadInitialState = useCallback(async () => {
    if (!opened || !localPath) {
      return;
    }

    setInitializing(true);
    setError(null);
    setClosing(false);
    setUnreviewedEntries([]);
    setUploadResult(null);
    setBlockedStale(null);
    setBlockedDirty(null);
    setCheckFailed(null);
    setStalenessBannerDismissed(false);
    setPublishConnections([]);
    setJobs([]);
    setPublishErrorDetails([]);
    setValidationCounts(null);
    setValidationStats([]);
    setSingleRecordNotice(null);

    // DEV-10413: single-record mode runs a scoped pre-flight (validation only,
    // no workspace-wide unreviewed scan) and returns early.
    if (singleRecord) {
      try {
        await loadSingleRecordInitialState();
      } catch (err) {
        setProgressSteps((prev) =>
          prev.map((step) => (step.status === 'active' ? { ...step, status: 'error' } : step)),
        );
        setMode('error');
        setError(err instanceof Error ? err.message : 'Failed to load publish state');
      } finally {
        setInitializing(false);
      }
      return;
    }

    // Run the two pre-flight checks sequentially (instead of Promise.all) so
    // the user sees one finish before the next starts. Total slowdown vs. the
    // prior parallel path is ~100ms (validation count is SQLite-fast); the
    // perception win is worth it.
    // DEV-10522: the validation step only exists when the Validation toggle is on.
    const initialProgressSteps: ProgressStep[] = [
      { id: 'unreviewed', label: 'Checking for unreviewed local edits…', status: 'active' },
    ];
    if (validateEnabled) {
      initialProgressSteps.push({ id: 'validation', label: 'Loading validation status…', status: 'pending' });
    }
    setProgressSteps(initialProgressSteps);

    try {
      const nextUnreviewed = await window.scratchDesktop.listUnreviewedChanges(localPath);
      setUnreviewedEntries(nextUnreviewed);
      setProgressSteps((prev) =>
        prev.map((step) => {
          if (step.id === 'unreviewed') {
            const found = nextUnreviewed.length;
            return {
              ...step,
              status: 'done',
              label:
                found === 0
                  ? 'No unreviewed local edits'
                  : `Found ${found.toLocaleString()} unreviewed record${found === 1 ? '' : 's'}`,
            };
          }
          if (step.id === 'validation') {
            return { ...step, status: 'active' };
          }
          return step;
        }),
      );

      // DEV-10522: only run the validation pre-flight when the toggle is on;
      // otherwise `counts` stays null and the error gate below never fires.
      let counts: { errors: number; warnings: number; records: number; stats: ValidationStat[] } | null = null;
      if (validateEnabled) {
        counts = await loadValidationCounts(localPath);
        setValidationCounts(
          counts ? { errors: counts.errors, warnings: counts.warnings, records: counts.records } : null,
        );
        setValidationStats(counts?.stats ?? []);
        setProgressSteps((prev) =>
          prev.map((step) => {
            if (step.id === 'validation') {
              const errorRecordCount = counts?.errors ?? 0;
              return {
                ...step,
                status: 'done',
                label:
                  errorRecordCount === 0
                    ? 'No validation errors'
                    : `Found ${errorRecordCount.toLocaleString()} record${errorRecordCount === 1 ? '' : 's'} with validation errors`,
              };
            }
            return step;
          }),
        );
      }

      if (autoStartUploadOnOpen) {
        await startUpload();
        return;
      }

      // DEV-10522: only validation ERRORS gate publish — a workspace whose only
      // validation problems are warnings falls through and publishes without the modal.
      const hasValidationErrors = counts !== null && counts.errors > 0;
      const hasUnreviewed = !assumeUnreviewedApproved && nextUnreviewed.length > 0;

      if (hasUnreviewed || hasValidationErrors) {
        setMode('approval');
        return;
      }

      await startUpload();
    } catch (err) {
      setProgressSteps((prev) => prev.map((step) => (step.status === 'active' ? { ...step, status: 'error' } : step)));
      setMode('error');
      setError(err instanceof Error ? err.message : 'Failed to load publish state');
    } finally {
      setInitializing(false);
    }
  }, [
    assumeUnreviewedApproved,
    autoStartUploadOnOpen,
    localPath,
    opened,
    startUpload,
    singleRecord,
    loadSingleRecordInitialState,
    validateEnabled,
  ]);

  const continueAfterApproval = useCallback(() => {
    void startUpload();
  }, [startUpload]);

  /**
   * When unreviewed working-tree edits exist at modal-open, the user can't
   * just "Continue to upload" — the CLI's `files publish` pre-flight refuses
   * with `blocked_unreviewed`, so we'd hit that wall later anyway. Force the
   * choice up front: accept the edits (they ride along) or discard them
   * (they don't), then proceed straight into upload. Symmetric with pull's
   * three-button "Accept all and refresh / Discard all and refresh / Cancel"
   * modal.
   */
  const handleAcceptAllAndUpload = useCallback(async () => {
    if (!localPath) return;
    try {
      setError(null);
      setInitializing(true);
      setProgressSteps([{ id: 'accept', label: 'Accepting all unreviewed local edits…', status: 'active' }]);
      const result = await window.scratchDesktop.acceptAllChanges(localPath);
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || 'scratchmd files accept-all failed');
      }
      setProgressSteps((prev) =>
        prev.map((step) =>
          step.id === 'accept' ? { ...step, status: 'done', label: 'Accepted unreviewed edits' } : step,
        ),
      );
      setUnreviewedEntries([]);
      await startUpload();
    } catch (err) {
      setProgressSteps((prev) => prev.map((step) => (step.status === 'active' ? { ...step, status: 'error' } : step)));
      setMode('error');
      setError(err instanceof Error ? err.message : 'Failed to accept unreviewed changes');
    } finally {
      setInitializing(false);
    }
  }, [localPath, startUpload]);

  // "Discard and publish" only needs to undo the unreviewed working-tree edits —
  // the already-accepted patches are what we're about to publish. That maps to
  // `files reject-all`, not `discard-all` (which would also drop every entry in
  // `accepted-patches.json`, leaving nothing to upload). See REVIEW_MODEL.md.
  const handleDiscardAllAndUpload = useCallback(async () => {
    if (!localPath) return;
    try {
      setError(null);
      setInitializing(true);
      setProgressSteps([{ id: 'discard', label: 'Discarding all unreviewed local edits…', status: 'active' }]);
      const result = await window.scratchDesktop.rejectAllChanges(localPath);
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || 'scratchmd files reject-all failed');
      }
      setProgressSteps((prev) =>
        prev.map((step) =>
          step.id === 'discard' ? { ...step, status: 'done', label: 'Discarded unreviewed edits' } : step,
        ),
      );
      setUnreviewedEntries([]);
      await startUpload();
    } catch (err) {
      setProgressSteps((prev) => prev.map((step) => (step.status === 'active' ? { ...step, status: 'error' } : step)));
      setMode('error');
      setError(err instanceof Error ? err.message : 'Failed to discard unreviewed changes');
    } finally {
      setInitializing(false);
    }
  }, [localPath, startUpload]);

  /**
   * D8 stale-modal action. When `files upload` refuses with `blocked_stale`,
   * the only way forward is to advance local `main` first (via `files
   * download`) and retry. This handler chains the two CLI calls behind a
   * single button click so the user doesn't have to reach for a terminal.
   * `files download` itself refuses if there are unreviewed local edits
   * (slice D), but the publish modal already gates on that earlier, so the
   * download step should be clean by this point.
   */
  const handleDownloadAndPublish = useCallback(async () => {
    if (!localPath) return;
    try {
      setError(null);
      setInitializing(true);
      setProgressSteps([{ id: 'download', label: 'Downloading latest from server…', status: 'active' }]);
      // DEV-10523: scope the failure decision to this record. The whole
      // workspace still pulls (other records' unreviewed edits are re-applied
      // user-wins), but the pull only refuses if THIS record hard-conflicts.
      const result = await window.scratchDesktop.pullWorkspaceChanges(
        localPath,
        singleRecord ? { filePath: singleRecord.filePath } : undefined,
      );
      if (result.status === 'blocked_conflict') {
        // The target record itself conflicts with newer server changes — it
        // can't be published until the user resolves it. The local edits were
        // preserved in unreviewed-changes.json.
        setProgressSteps((prev) =>
          prev.map((step) => (step.status === 'active' ? { ...step, status: 'error' } : step)),
        );
        setMode('error');
        setError(
          'This record conflicts with newer changes from the server. Your local edits were saved to unreviewed-changes.json — resolve the conflict, then try again.',
        );
        return;
      }
      // `downloaded` / `up_to_date` / `downloaded_with_stashed_conflicts` all
      // mean the target is up to date and publishable; a stashed conflict on
      // OTHER records is non-blocking and surfaces on the next full pull.
      const lastMessage = result.messages[result.messages.length - 1];
      setProgressSteps((prev) =>
        prev.map((step) =>
          step.id === 'download'
            ? { ...step, status: 'done', label: lastMessage || 'Downloaded latest from server' }
            : step,
        ),
      );
      setBlockedStale(null);
      await startUpload();
    } catch (err) {
      setProgressSteps((prev) => prev.map((step) => (step.status === 'active' ? { ...step, status: 'error' } : step)));
      setMode('error');
      setError(err instanceof Error ? err.message : 'Failed to download latest from server');
    } finally {
      setInitializing(false);
    }
  }, [localPath, singleRecord, startUpload]);

  const handleViewProblems = useCallback(() => {
    if (!localPath || !onViewProblems) return;
    // DEV-10522: the single-record flow never populates `validationStats`, so
    // navigate straight to the record's (absolute) folder path instead — the
    // grid then activates its `has-problems` filter on that folder.
    if (singleRecord) {
      onViewProblems(singleRecord.folderPath);
      return;
    }
    // Workspace flow: land on a folder that actually has an error (skip
    // warning-only folders, which no longer gate publish — DEV-10522).
    const statsWithProblems = validationStats.filter((s) => s.errors > 0);
    if (statsWithProblems.length === 0) return;

    let targetStat = statsWithProblems[0];

    if (currentFolderPath) {
      const rel = currentFolderPath.startsWith(localPath + '/')
        ? currentFolderPath.slice(localPath.length + 1)
        : currentFolderPath;
      const parts = rel.split('/');
      const currentConnection = parts[0];
      const currentFolderRelPath = parts.slice(1).join('/');

      const sameFolder = statsWithProblems.find(
        (s) => s.connection === currentConnection && s.folder_path === currentFolderRelPath,
      );
      const sameConnection = statsWithProblems.find((s) => s.connection === currentConnection);
      targetStat = sameFolder ?? sameConnection ?? statsWithProblems[0];
    }

    onViewProblems(`${localPath}/${targetStat.connection}/${targetStat.folder_path}`);
  }, [currentFolderPath, localPath, onViewProblems, validationStats, singleRecord]);

  const handleClose = useCallback(() => {
    if (closing) {
      return;
    }
    setClosing(true);
    setClosing(false);
    onClose();
  }, [closing, onClose]);

  const handleReviewOnWeb = useCallback(() => {
    if (!workspaceId) return;
    const webUrl = (import.meta.env.VITE_SCRATCH_WEB_URL as string) || 'http://localhost:3000';
    void window.scratchAuth.openExternal(`${webUrl}/workbook/${workspaceId}/review`);
    void trackPublishReviewOnWeb(workspaceId);
  }, [workspaceId]);

  const pollJobToTerminal = useCallback((jobId: string): Promise<Job> => {
    // Register the job in the shared pending-waits map. The single poller in
    // the useEffect below resolves this Promise on the tick that observes
    // the job in a terminal state.
    return new Promise<Job>((resolve) => {
      pendingWaitsRef.current.set(jobId, resolve);
    });
  }, []);

  /**
   * Run plan-job → run-job for a single connection, updating
   * `publishConnections` and `jobs` state as each phase progresses.
   */
  const runConnectionPublish = useCallback(
    async (
      wbId: string,
      conn: ConnectionPublishState,
      options?: { expectedBaseDirtyHead?: string | null; filePath?: string },
    ): Promise<DirtyGateConnection | null> => {
      const updateConn = (next: Partial<ConnectionPublishState>) => {
        setPublishConnections((prev) =>
          prev.map((c) => (c.connectionId === conn.connectionId ? { ...c, ...next } : c)),
        );
      };

      try {
        updateConn({ status: 'planning' });
        // DEV-10316: pass the post-upload dirty HEAD so the server aborts the
        // plan build if the staging area drifted while the user reviewed.
        // DEV-10413: `filePath` scopes the plan to a single record.
        const plan = await scratchApiClient.publish.viaCliRoute.planJob(wbId, conn.connectionId, {
          expectedBaseDirtyHead: options?.expectedBaseDirtyHead,
          filePath: options?.filePath,
        });
        if (!plan.jobId || !plan.pipelineId) {
          updateConn({ status: 'plan-no-diff' });
          return null;
        }
        const planJobId = String(plan.jobId);
        updateConn({ planJobId, pipelineId: plan.pipelineId });
        const planJob = await pollJobToTerminal(planJobId);

        // DEV-10316: the plan-build aborted on dirty-HEAD drift. Return a drift
        // signal so `triggerPublish` flips the whole modal into the count-only
        // `dirty` redirect (with the "server changed while you were reviewing"
        // lead). Leave this connection non-terminal so the publishing→complete
        // transition effect doesn't fire before the redirect takes over.
        const planProgress = planJob.publicProgress as PublishPipelineProgress | undefined;
        if (planProgress?.blockedDirtyDrift) {
          return { connectionName: conn.connectionName, dirtyCount: planProgress.blockedDirtyDrift.dirtyCount };
        }
        if (planJob.state !== 'completed') {
          updateConn({ status: 'failed', failureMessage: getPublishFailureMessage(planJob) });
          return null;
        }

        updateConn({ status: 'running' });
        const run = await scratchApiClient.publish.viaCliRoute.runJob(wbId, plan.pipelineId);
        if (!run.jobId) {
          updateConn({ status: 'failed', failureMessage: 'run-job did not return a job id' });
          return null;
        }
        const runJobId = String(run.jobId);
        updateConn({ runJobId });
        const finalJob = await pollJobToTerminal(runJobId);

        // DEV-10048: capture the run-job's connector rejections so the
        // per-connection post-publish reconcile can route them to
        // failed-patches.json. Set on both terminal branches (a "failed"
        // connection here is one with row-level rejections, which is exactly
        // when failedOperations is non-empty).
        const finalProgress = finalJob.publicProgress as PublishPipelineProgress | undefined;
        const failedOperations = finalProgress?.failedOperations ?? [];

        if (finalJob.state !== 'completed' || hasPublishFailures(finalJob)) {
          updateConn({
            status: 'failed',
            failureMessage: getPublishFailureMessage(finalJob),
            failedOperations,
          });
          return null;
        }

        updateConn({ status: 'completed', failedOperations });
        return null;
      } catch (err) {
        updateConn({
          status: 'failed',
          failureMessage: err instanceof Error ? err.message : 'Unknown error while publishing',
        });
        return null;
      }
    },
    [pollJobToTerminal],
  );

  // DEV-10413: single-record publish. The scoped upload already shipped exactly
  // one connection's one record to dirty, so build the single connection state
  // directly (no workspaceConfig name→id mapping) and skip the workspace-wide
  // unreviewed recheck — the OTHER records' unreviewed edits must not block this
  // one. expectedBaseDirtyHead = null mirrors the web (the plan's filePath scope
  // is the over-publish guard); dirty/checkFailed/blockedDirtyDrift are
  // unreachable on this path. The all-terminal effect runs the scoped reconcile.
  const triggerSingleRecordPublish = useCallback(async () => {
    if (!localPath || !workspaceId || !singleRecord) {
      return;
    }
    try {
      setError(null);
      setPublishErrorDetails([]);
      setProgressSteps([]);
      setMode('publishing');
      const conn: ConnectionPublishState = {
        connectionId: singleRecord.connectionId,
        connectionName: singleRecord.connectionName,
        status: 'pending',
      };
      setPublishConnections([conn]);
      await trackPublishStarted(workspaceId, 1);
      await runConnectionPublish(workspaceId, conn, {
        filePath: singleRecord.relPath,
        expectedBaseDirtyHead: null,
      });
    } catch (err) {
      setMode('error');
      setError(err instanceof Error ? err.message : 'Failed to start publish');
    }
  }, [localPath, workspaceId, singleRecord, runConnectionPublish]);

  const triggerPublish = useCallback(async () => {
    if (!localPath || !workspaceId || !uploadResult) {
      return;
    }

    // DEV-10413: single-record mode has its own, simpler trigger.
    if (singleRecord) {
      await triggerSingleRecordPublish();
      return;
    }

    try {
      setError(null);
      setPublishErrorDetails([]);
      setProgressSteps([{ id: 'recheck', label: 'Re-checking for unreviewed local edits…', status: 'active' }]);

      // Re-check for unreviewed edits in the window between upload and this
      // click — a file watcher or another window could have introduced new
      // local edits that aren't in the server's dirty branch. The renderer
      // publishes directly via HTTP (`scratchApiClient.publish.viaCliRoute.planJob` / `startRunJob`),
      // bypassing the CLI's `run_publish` pre-flight, so this gate is the only
      // backstop for that race. Flip back to approval mode so the user can
      // accept/discard, which will trigger a fresh upload before they retry.
      const freshUnreviewed = await window.scratchDesktop.listUnreviewedChanges(localPath);
      if (freshUnreviewed.length > 0) {
        setUnreviewedEntries(freshUnreviewed);
        setUploadResult(null);
        setProgressSteps([]);
        setMode('approval');
        return;
      }
      setProgressSteps((prev) =>
        prev.map((step) =>
          step.id === 'recheck' ? { ...step, status: 'done', label: 'No new unreviewed edits' } : step,
        ),
      );

      setMode('publishing');

      const connectionsWithDiff = uploadResult.connections.filter((c) => c.status === 'uploaded');

      // workspaceConfig maps connection name → connectionId (the connector account ID).
      const cfg = await window.scratchFiles.workspaceConfig(localPath);
      const idByName = new Map(cfg.connections.map((c) => [c.dirName, c.id]));

      const initial: ConnectionPublishState[] = connectionsWithDiff.map((c) => {
        const connectionId = idByName.get(c.connectionName);
        if (!connectionId) {
          return {
            connectionId: '',
            connectionName: c.connectionName,
            status: 'failed',
            failureMessage: `Could not resolve connection id for "${c.connectionName}"`,
          };
        }
        return {
          connectionId,
          connectionName: c.connectionName,
          status: 'pending',
        };
      });
      setPublishConnections(initial);
      await trackPublishStarted(workspaceId, initial.length);

      // DEV-10316: per-connection post-upload dirty HEAD, used as the
      // publish-time TOCTOU token so the server aborts if the staging area
      // drifted between upload and this click.
      const dirtyHeadByName = new Map(connectionsWithDiff.map((c) => [c.connectionName, c.dirtyHead ?? null]));

      // Fan out plan-job → run-job per connection in parallel.
      const settled = await Promise.allSettled(
        initial.map(async (conn): Promise<DirtyGateConnection | null> => {
          if (conn.status === 'failed') return null;
          return runConnectionPublish(workspaceId, conn, {
            expectedBaseDirtyHead: dirtyHeadByName.get(conn.connectionName),
          });
        }),
      );

      // DEV-10316: if any connection's plan-build aborted on dirty-HEAD drift,
      // flip the whole modal into the count-only `dirty` redirect. Over-publish
      // is already impossible (a drifted connection never built a plan); this is
      // the "resolve on the web, then come back" hand-off, led by the TOCTOU line.
      const driftedConnections = settled
        .map((s) => (s.status === 'fulfilled' ? s.value : null))
        .filter((v): v is DirtyGateConnection => v !== null);
      if (driftedConnections.length > 0) {
        setBlockedDirty({ connections: driftedConnections, lead: TOCTOU_DRIFT_LEAD });
        setMode('dirty');
        return;
      }
    } catch (err) {
      setMode('error');
      setError(err instanceof Error ? err.message : 'Failed to start publish');
    }
  }, [localPath, uploadResult, workspaceId, runConnectionPublish, singleRecord, triggerSingleRecordPublish]);

  useEffect(() => {
    if (!opened) {
      return;
    }
    void loadInitialState();
  }, [loadInitialState, opened]);

  // Single consolidated poller. One `/jobs/bulk-status` request per second
  // for every job ID registered in `pendingWaitsRef`, regardless of how many
  // connections are publishing in parallel. Drives BOTH:
  //   (a) the `jobs` state for `<ConnectionPublishRow>` to render live progress
  //   (b) the per-connection `pollJobToTerminal` Promises (resolved when each
  //       job hits a terminal state)
  useEffect(() => {
    if (mode !== 'publishing') {
      if (pollingIntervalRef.current !== null) {
        window.clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
      return;
    }

    let cancelled = false;

    const poll = async () => {
      const activeJobIds = Array.from(pendingWaitsRef.current.keys());
      if (activeJobIds.length === 0) {
        return;
      }

      try {
        const statuses = await scratchApiClient.job.getJobsStatus(activeJobIds);
        if (cancelled) return;
        const byId = new Map(statuses.map((s) => [s.bullJobId ?? '', s]));
        const hydrated = activeJobIds.map(
          (id) => byId.get(id) ?? { bullJobId: id, state: 'created' as const, type: 'unknown' },
        );
        setJobs(hydrated);

        for (const job of hydrated) {
          const jobId = job.bullJobId ?? '';
          if (!jobId || !isTerminalState(job.state)) continue;

          // Resolve the waiter so the per-connection state machine advances.
          const resolveWaiter = pendingWaitsRef.current.get(jobId);
          if (resolveWaiter) {
            pendingWaitsRef.current.delete(jobId);
            resolveWaiter(job);
          }

          // Log completion exactly once per terminal job.
          if (localPath && !loggedCompleteJobIdsRef.current.has(jobId)) {
            loggedCompleteJobIdsRef.current.add(jobId);
            const failed = job.state !== 'completed' || hasPublishFailures(job);
            const progress = job.publicProgress as PublishPipelineProgress | undefined;
            const summary = progress
              ? {
                  edit: progress.editsPlanned ?? 0,
                  create: progress.createsPlanned ?? 0,
                  delete: progress.deletesPlanned ?? 0,
                  backfill: progress.backfillsPlanned ?? 0,
                  rename: progress.renameFilesPlanned ?? 0,
                }
              : undefined;
            window.scratchDesktop.logPublishJob(localPath, {
              event: 'complete',
              jobId,
              state: job.state,
              successCount: progress?.successCount,
              failedCount: progress?.failedCount,
              summary,
              errorSummary: failed ? getPublishFailureMessage(job) : undefined,
            });
          }
        }
      } catch (err) {
        console.debug('Publish poll failed:', err);
      }
    };

    void poll();
    pollingIntervalRef.current = window.setInterval(() => {
      void poll();
    }, 1000);

    return () => {
      cancelled = true;
      if (pollingIntervalRef.current !== null) {
        window.clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
    };
  }, [mode, localPath]);

  // DEV-10413: single-record terminal handling. Runs the scoped reconcile
  // (`reconcile-published`) instead of the workspace-wide `files download` pull
  // — the pull refuses while other records have unreviewed edits. Disambiguates
  // the two `plan-no-diff` meanings (D3): patch dropped → already published;
  // patch survived → nothing new to publish.
  const finishSingleRecordPublish = useCallback(async () => {
    if (!localPath || !singleRecord) return;
    const conn = publishConnections[0];
    if (conn?.status === 'failed') {
      setPublishErrorDetails([`${conn.connectionName}: ${conn.failureMessage ?? 'failed'}`]);
      setError(`${conn.connectionName} failed`);
      setMode('error');
      return;
    }
    // `completed` or `plan-no-diff` → converge local state via the scoped reconcile.
    try {
      const reconcile = await window.scratchDesktop.reconcilePublishedRecord(localPath, singleRecord.filePath);
      invalidateWorkspaceLevelData();
      if (conn?.status === 'plan-no-diff') {
        setSingleRecordNotice(
          reconcile.patchDropped
            ? 'This record was already published — local state is now up to date.'
            : 'There was nothing new to publish for this record.',
        );
      }
    } catch (err) {
      // The publish landed server-side; a reconcile failure is non-fatal (mirrors
      // the workspace-wide fire-and-forget refresh). Surface it as a soft note.
      console.debug('Post-publish single-record reconcile failed:', err);
      invalidateWorkspaceLevelData();
    }
    if (workspaceId) {
      void trackPublishCompleted(workspaceId, {
        successCount: conn?.status === 'completed' ? 1 : 0,
        failedCount: 0,
        noDiffCount: conn?.status === 'plan-no-diff' ? 1 : 0,
      });
    }
    setMode('complete');
  }, [localPath, singleRecord, publishConnections, invalidateWorkspaceLevelData, workspaceId]);

  // When all per-connection publishes reach a terminal state, transition
  // mode → complete | error and refresh local data.
  useEffect(() => {
    if (mode !== 'publishing' || publishConnections.length === 0) {
      return;
    }
    const allTerminal = publishConnections.every(
      (c) => c.status === 'completed' || c.status === 'failed' || c.status === 'plan-no-diff',
    );
    if (!allTerminal) return;

    // DEV-10413: single-record mode has its own terminal handler (scoped reconcile).
    if (singleRecord) {
      void finishSingleRecordPublish();
      return;
    }

    const failedConnections = publishConnections.filter((c) => c.status === 'failed');
    const completedCount = publishConnections.filter((c) => c.status === 'completed').length;
    const noDiffCount = publishConnections.filter((c) => c.status === 'plan-no-diff').length;

    if (workspaceId) {
      void trackPublishCompleted(workspaceId, {
        successCount: completedCount,
        failedCount: failedConnections.length,
        noDiffCount,
      });
    }

    // Fire-and-forget; failure is silent by policy. See docs/post-publish-refresh.md.
    const refreshLocal = async () => {
      if (!localPath) return;
      try {
        // Publish redesign (DEV-10048): per-connection post-publish reconcile for
        // every connection that actually ran a run-job. This routes connector
        // rejections into failed-patches.json (re-surfaced as needs-approval),
        // clears published/no-op accepted patches, and advances local `main` —
        // replacing the generic pull for those connections so failures aren't lost.
        const ranConnections = publishConnections.filter((c) => c.runJobId);
        for (const conn of ranConnections) {
          await window.scratchDesktop.reconcileAfterPublish(
            localPath,
            conn.connectionId,
            JSON.stringify(conn.failedOperations ?? []),
          );
        }
        // Bring any connections that did NOT run (e.g. advanced server-side via a
        // web sync while we published) up to date too. A no-op "up_to_date" for
        // the connections we just reconciled, since their local main now matches.
        await window.scratchDesktop.pullWorkspaceChanges(localPath);
        invalidateWorkspaceLevelData();
      } catch (err) {
        console.debug('Post-publish reconcile/pull failed:', err);
      }
    };

    void refreshLocal();

    if (failedConnections.length === 0) {
      setMode('complete');
      return;
    }
    setPublishErrorDetails(failedConnections.map((c) => `${c.connectionName}: ${c.failureMessage ?? 'failed'}`));
    setMode('error');
    setError(failedConnections.map((c) => `${c.connectionName} failed`).join('; '));
  }, [
    mode,
    publishConnections,
    workspaceId,
    localPath,
    invalidateWorkspaceLevelData,
    singleRecord,
    finishSingleRecordPublish,
  ]);

  const aggregateTotals = useMemo(() => {
    if (!uploadResult) {
      return { created: 0, updated: 0, deleted: 0 };
    }
    return {
      created: uploadResult.filesCreated,
      updated: uploadResult.filesUpdated,
      deleted: uploadResult.filesDeleted,
    };
  }, [uploadResult]);

  const showStalenessBanner = !!stalenessWarning && !stalenessBannerDismissed;
  const canClose = !closing && mode !== 'uploading' && mode !== 'publishing';

  return (
    <Modal opened={opened} onClose={canClose ? () => handleClose() : () => undefined} title={modeTitle(mode)} size="lg">
      <Stack gap="md">
        {showStalenessBanner && stalenessWarning && (
          <Alert color="yellow" withCloseButton onClose={() => setStalenessBannerDismissed(true)}>
            The server has more recent changes ({stalenessWarning.newHead.slice(0, 7)}) than what&apos;s on your
            computer. Your edits were still uploaded; refresh after publishing finishes to pull them down.
          </Alert>
        )}

        {initializing ? (
          <ProgressStepList steps={progressSteps} />
        ) : (
          <>
            {mode === 'approval' && (
              <>
                {validationCounts && validationCounts.errors > 0 && (
                  <Text size="sm" c="red">
                    {singleRecord
                      ? 'This record has validation errors that may prevent it from publishing.'
                      : `${validationCounts.errors} record${validationCounts.errors === 1 ? '' : 's'} contain validation errors that may prevent them from publishing.`}
                  </Text>
                )}
                {unreviewedEntries.length > 0 && (
                  <>
                    <Text size="sm">
                      {unreviewedEntries.length.toLocaleString()} record{unreviewedEntries.length === 1 ? '' : 's'}{' '}
                      contain unreviewed local edits.
                    </Text>
                    <Text size="sm" c="dimmed">
                      Publishing is blocked until you decide what to do with these edits. Accept them to publish the new
                      values, or discard them to revert to the last accepted state.
                    </Text>
                  </>
                )}
                <Group justify="flex-end">
                  {onViewProblems && validationCounts && validationCounts.errors > 0 && (
                    <Button variant="outline" color="red" onClick={handleViewProblems} disabled={closing}>
                      View Problems
                    </Button>
                  )}
                  <Button variant="default" onClick={() => handleClose()} loading={closing}>
                    Cancel
                  </Button>
                  {unreviewedEntries.length > 0 ? (
                    <>
                      <Button
                        variant="outline"
                        onClick={() => void handleDiscardAllAndUpload()}
                        disabled={closing || initializing}
                      >
                        Discard and publish
                      </Button>
                      <Button onClick={() => void handleAcceptAllAndUpload()} disabled={closing || initializing}>
                        Accept and publish
                      </Button>
                    </>
                  ) : (
                    <Button onClick={() => continueAfterApproval()} disabled={closing}>
                      {validationCounts && validationCounts.errors > 0 ? 'Ignore and Continue' : 'Continue'}
                    </Button>
                  )}
                </Group>
              </>
            )}

            {mode === 'uploading' && <ProgressStepList steps={progressSteps} />}

            {mode === 'uploaded' && uploadResult && (
              <>
                <Text size="sm" c="dimmed">
                  {singleRecord
                    ? 'This record was staged on the server. Click Publish to dispatch it through the connector, or review it on the web first.'
                    : 'Your changes were uploaded to the server. Click Publish to dispatch them through the connectors, or review them on the web first.'}
                </Text>

                <Text size="sm" c="dimmed">
                  {formatDiffSummary(aggregateTotals.created, aggregateTotals.updated, aggregateTotals.deleted)}
                </Text>

                <ScrollArea.Autosize mah={320}>
                  <Stack gap="sm">
                    {uploadResult.connections
                      .filter((c) => c.status === 'uploaded')
                      .map((c: UploadConnection) => (
                        <Box
                          key={c.connectionName}
                          p="sm"
                          style={{ border: '1px solid var(--mantine-color-gray-3)', borderRadius: 8 }}
                        >
                          <Group justify="space-between" align="flex-start">
                            <Text fw={600} size="sm">
                              {c.connectionName}
                            </Text>
                            <Text size="sm" c="dimmed">
                              {formatDiffSummary(c.filesCreated, c.filesUpdated, c.filesDeleted)}
                            </Text>
                          </Group>
                          {(c.createdPaths.length > 0 || c.updatedPaths.length > 0 || c.deletedPaths.length > 0) &&
                            (() => {
                              const allPaths = [...c.createdPaths, ...c.updatedPaths, ...c.deletedPaths];
                              const PREVIEW_LIMIT = 5;
                              const preview = allPaths.slice(0, PREVIEW_LIMIT);
                              const overflow = allPaths.length - preview.length;
                              const lines =
                                overflow > 0 ? [...preview, `... and ${overflow.toLocaleString()} more`] : preview;
                              return (
                                <Code block mt="xs">
                                  {lines.join('\n')}
                                </Code>
                              );
                            })()}
                        </Box>
                      ))}
                  </Stack>
                </ScrollArea.Autosize>

                {workspaceId && (
                  <Group justify="space-between">
                    <Anchor onClick={handleReviewOnWeb} size="sm">
                      Review on web ↗
                    </Anchor>
                  </Group>
                )}

                <Group justify="space-between">
                  <Button variant="default" onClick={() => handleClose()} loading={closing}>
                    Cancel
                  </Button>
                  <Button onClick={() => void triggerPublish()} disabled={closing}>
                    Publish now
                  </Button>
                </Group>
              </>
            )}

            {mode === 'publishing' && (
              <Stack gap="md">
                {publishConnections.length === 0 ? (
                  <Stack gap="lg" align="center" py="xl">
                    <Loader size="md" />
                    <Stack gap={4} align="center">
                      <Text size="md" fw={500}>
                        Starting publish jobs
                      </Text>
                      <Text size="sm" c="dimmed">
                        Building a plan for each connection.
                      </Text>
                    </Stack>
                  </Stack>
                ) : (
                  publishConnections.map((conn) => {
                    const activeJobId = conn.runJobId ?? conn.planJobId;
                    const job = jobs.find((j) => j.bullJobId === activeJobId);
                    return (
                      <ConnectionPublishRow
                        key={conn.connectionId || conn.connectionName}
                        connection={conn}
                        job={job}
                      />
                    );
                  })
                )}
              </Stack>
            )}

            {mode === 'stale' && blockedStale && (
              <>
                {initializing ? (
                  <ProgressStepList steps={progressSteps} />
                ) : (
                  <>
                    <Alert color="yellow" title="Server has newer changes">
                      The server has published changes since you last refreshed
                      {blockedStale.connections.length === 1
                        ? ` ${blockedStale.connections[0].connectionName}`
                        : ` ${blockedStale.connections.length.toLocaleString()} connection${blockedStale.connections.length === 1 ? '' : 's'}`}
                      . Your accepted edits weren't uploaded — refresh first, then publish.
                    </Alert>
                    <Stack gap="xs">
                      {blockedStale.connections.map((c) => (
                        <Text key={c.connectionName} size="sm" c="dimmed">
                          {c.connectionName}: local {c.baseHead?.slice(0, 7) ?? '<unset>'} → server{' '}
                          {c.currentRemoteHead.slice(0, 7)}
                        </Text>
                      ))}
                    </Stack>
                    <Group justify="space-between">
                      <Button variant="default" onClick={() => handleClose()} loading={closing}>
                        Cancel
                      </Button>
                      <Button onClick={() => void handleDownloadAndPublish()} disabled={closing}>
                        Download and publish
                      </Button>
                    </Group>
                  </>
                )}
              </>
            )}

            {mode === 'dirty' && blockedDirty && (
              <>
                <Alert color="yellow" title="Unpublished changes on the server">
                  {blockedDirty.lead && (
                    <Text size="sm" mb="xs">
                      {blockedDirty.lead}
                    </Text>
                  )}
                  <Text size="sm">
                    Publish or discard these on the web, then come back here. (Someone with web access may need to
                    resolve changes you didn&apos;t make.)
                  </Text>
                </Alert>
                <ScrollArea.Autosize mah={240}>
                  <Stack gap="xs">
                    {blockedDirty.connections.map((c) => (
                      <Group key={c.connectionName} justify="space-between" wrap="nowrap">
                        <Text size="sm" truncate>
                          {c.connectionName}
                        </Text>
                        <Text size="sm" c="dimmed" style={{ flexShrink: 0 }}>
                          {c.dirtyCount.toLocaleString()} change{c.dirtyCount === 1 ? '' : 's'}
                        </Text>
                      </Group>
                    ))}
                  </Stack>
                </ScrollArea.Autosize>
                <Group justify="flex-end">
                  <Button variant="default" onClick={() => handleClose()} loading={closing}>
                    Close
                  </Button>
                  {workspaceId && (
                    <Button onClick={handleReviewOnWeb} aria-label="Review unpublished changes on the web">
                      Review on web ↗
                    </Button>
                  )}
                </Group>
              </>
            )}

            {mode === 'checkFailed' && checkFailed && (
              <>
                <Alert color="red" title="Couldn't verify the server's state">
                  {checkFailed.message ??
                    "We couldn't check whether the server has unpublished changes. This is usually temporary — try again."}
                </Alert>
                <Group justify="flex-end">
                  <Button variant="default" onClick={() => handleClose()} loading={closing}>
                    Close
                  </Button>
                  <Button onClick={() => void startUpload()} disabled={closing || initializing}>
                    Try again
                  </Button>
                </Group>
              </>
            )}

            {mode === 'complete' && (
              <>
                <Alert color="green" title={singleRecord ? 'Record published' : 'All data published'}>
                  {singleRecord
                    ? (singleRecordNotice ?? 'This record was published.')
                    : workspaceName
                      ? `${workspaceName} is now in sync.`
                      : 'Your changes were published.'}
                </Alert>
                <Group justify="flex-end">
                  <Button onClick={() => handleClose()} loading={closing}>
                    Close
                  </Button>
                </Group>
              </>
            )}

            {mode === 'error' && (
              <>
                <Alert color="red" title="Publish failed">
                  {error || 'Something went wrong while publishing changes.'}
                </Alert>
                {publishErrorDetails.length > 0 && (
                  <Stack gap="xs">
                    {publishErrorDetails.map((message, index) => (
                      <Text key={`${index}-${message}`} size="sm">
                        {message}
                      </Text>
                    ))}
                  </Stack>
                )}
                <Stack gap="md">
                  {publishConnections.map((conn) => {
                    const activeJobId = conn.runJobId ?? conn.planJobId;
                    const job = jobs.find((j) => j.bullJobId === activeJobId);
                    return (
                      <ConnectionPublishRow
                        key={conn.connectionId || conn.connectionName}
                        connection={conn}
                        job={job}
                      />
                    );
                  })}
                </Stack>
                <Group justify="flex-end">
                  <Button onClick={() => handleClose()} loading={closing}>
                    Close
                  </Button>
                </Group>
              </>
            )}
          </>
        )}
      </Stack>
    </Modal>
  );
}
