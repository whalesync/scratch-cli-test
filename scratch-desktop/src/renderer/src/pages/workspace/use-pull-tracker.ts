import { scratchApiClient } from '@/lib/scratch-api-client';
import type { Job } from '@spinner/shared-types';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Background tracker for desktop data pulls (DEV-10501).
 *
 * A pull used to be tracked entirely inside its progress modal, so the modal had
 * to stay up (blocking the UI) until the pull finished. This hook lifts that
 * lifecycle — start/watch jobs → poll → materialize files locally → refresh —
 * out of any modal and into the always-mounted `WorkspacePage`. Closing the
 * progress modal no longer stops the pull; the user can browse and edit records
 * while it continues in the background, with an ambient header indicator driven
 * by the same state.
 */

/**
 * Total local-download attempts before surfacing the error (initial + retries). A
 * brand-new connection's git repo can still be settling the instant its pull job
 * reports complete — `scratchmd files download` then skips it with only a stderr
 * warning (and still exits 0), so its folders never reach disk. A couple of
 * automatic retries usually materialize them without bothering the user.
 * (DEV-10421)
 */
const MAX_DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAY_MS = 1500;
const POLL_INTERVAL_MS = 1500;

/**
 * How long the "complete" state lingers before the tracker resets itself to
 * `idle` (which clears the ambient header pill and closes the progress modal).
 */
const DONE_AUTO_DISMISS_MS = 6000;

/**
 * Substring `scratchmd files download` logs to stderr when it can't set up a
 * connection it discovered server-side (e.g. its repo isn't clonable yet). The
 * command still exits 0, so we scan its output to catch this otherwise-silent
 * failure and retry. Must match the CLI's wording in
 * `scratch-git-2/src/cli/commands/files.rs` (`sync_workspace_structure`).
 */
const CONNECTION_SETUP_FAILURE_MARKER = 'failed to set up connection';

/** Job types that represent a record pull (server-side BullMQ jobs). */
const PULL_JOB_TYPES = new Set(['RefreshRecords', 'pull-linked-folder-files']);

export type PullPhase = 'idle' | 'starting' | 'polling' | 'downloading' | 'done' | 'error' | 'download-error';

/**
 * One connection's row in the local-download phase (DEV-10846). Built from the
 * CLI's per-connection progress events; `pending` means announced by the `plan`
 * event but not yet picked up by a worker.
 */
export interface ConnectionDownloadProgress {
  /** Workspace directory name of the connection, as the CLI reports it. */
  connection: string;
  state: 'pending' | 'active' | 'done' | 'error';
  /** Record files written to disk. Only set once the connection finishes. */
  changedRecords?: number;
}

export interface StartPullOptions {
  /** Title shown in the progress modal header. */
  title: string;
  /** Restrict the pull to these data-folder ids; omit to pull the whole workspace. */
  dataFolderIds?: string[];
  pullMode?: 'full' | 'incremental';
  /** Message shown when the pull matched no linked tables. */
  emptyStateMessage?: string;
}

export interface PullTracker {
  phase: PullPhase;
  /** True while the pull is still working (starting / polling / downloading). */
  isActive: boolean;
  jobs: Job[];
  /** 0–100 across the tracked jobs (or 100 once done). */
  progress: number;
  completedCount: number;
  totalCount: number;
  /** Title for the progress modal header (set by the entry point). */
  title: string;
  error: string | null;
  downloadError: string | null;
  emptyMessage: string | null;
  /**
   * Per-connection rows for the local-download phase, in the order the CLI
   * announced them. Empty until the download starts (DEV-10846).
   */
  connectionDownloads: ConnectionDownloadProgress[];
  /** Start-and-track: enqueue a pull on the server, then watch + download. */
  startPull: (options: StartPullOptions) => Promise<void>;
  /**
   * Watch-existing: attach to pull jobs already running for this workspace.
   * Returns true if it found and attached to active jobs.
   */
  watchActivePulls: (options?: { title?: string }) => Promise<boolean>;
  /** Re-run the local download after a surfaced failure. */
  retryDownload: () => void;
  /** Clear a finished / errored tracker back to idle. */
  dismiss: () => void;
}

function isTerminalJobState(state: Job['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'canceled' || state === 'unknown';
}

function isActivePhase(phase: PullPhase): boolean {
  return phase === 'starting' || phase === 'polling' || phase === 'downloading';
}

/**
 * Apply an update to one connection's download row, appending it if the `plan`
 * event didn't list it. Appending rather than dropping the update keeps the view
 * honest if a future CLI version reports a connection the plan missed.
 */
function upsertConnectionDownload(
  rows: ConnectionDownloadProgress[],
  connection: string,
  update: Partial<Omit<ConnectionDownloadProgress, 'connection'>>,
): ConnectionDownloadProgress[] {
  const index = rows.findIndex((row) => row.connection === connection);
  if (index === -1) {
    return [...rows, { connection, state: 'active', ...update }];
  }
  const next = [...rows];
  next[index] = { ...next[index], ...update };
  return next;
}

export function usePullTracker(args: {
  workbookId: string;
  localPath: string | null;
  invalidateWorkspaceLevelData: () => void;
}): PullTracker {
  const { workbookId } = args;

  const [phase, setPhaseState] = useState<PullPhase>('idle');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [trackedJobIds, setTrackedJobIds] = useState<string[]>([]);
  const [title, setTitle] = useState('Pulling files');
  const [error, setError] = useState<string | null>(null);
  // The scratchmd error from a failed local download, shown so the user
  // understands why files that pulled on the server didn't reach their machine.
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [emptyMessage, setEmptyMessage] = useState<string | null>(null);
  const [downloadAttempt, setDownloadAttempt] = useState(0);
  const [connectionDownloads, setConnectionDownloads] = useState<ConnectionDownloadProgress[]>([]);

  // Latest-value refs so the long-lived polling / download effects don't have to
  // re-subscribe when these change, and so callbacks can read the current phase
  // without stale closures.
  const phaseRef = useRef(phase);
  const localPathRef = useRef(args.localPath);
  localPathRef.current = args.localPath;
  const invalidateRef = useRef(args.invalidateWorkspaceLevelData);
  invalidateRef.current = args.invalidateWorkspaceLevelData;

  const pollingIntervalRef = useRef<number | null>(null);
  const downloadRetryTimeoutRef = useRef<number | null>(null);
  const doneDismissTimeoutRef = useRef<number | null>(null);

  const clearPolling = useCallback(() => {
    if (pollingIntervalRef.current !== null) {
      window.clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
  }, []);
  const clearDownloadRetry = useCallback(() => {
    if (downloadRetryTimeoutRef.current !== null) {
      window.clearTimeout(downloadRetryTimeoutRef.current);
      downloadRetryTimeoutRef.current = null;
    }
  }, []);
  const clearDoneDismiss = useCallback(() => {
    if (doneDismissTimeoutRef.current !== null) {
      window.clearTimeout(doneDismissTimeoutRef.current);
      doneDismissTimeoutRef.current = null;
    }
  }, []);

  const setPhase = useCallback((next: PullPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const resetForNewRun = useCallback(
    (nextTitle: string, nextEmptyMessage: string | null) => {
      clearPolling();
      clearDownloadRetry();
      clearDoneDismiss();
      setTitle(nextTitle);
      setError(null);
      setDownloadError(null);
      setEmptyMessage(nextEmptyMessage);
      setDownloadAttempt(0);
      setJobs([]);
      setTrackedJobIds([]);
      setConnectionDownloads([]);
    },
    [clearPolling, clearDownloadRetry, clearDoneDismiss],
  );

  const dismiss = useCallback(() => {
    clearPolling();
    clearDownloadRetry();
    clearDoneDismiss();
    setJobs([]);
    setTrackedJobIds([]);
    setError(null);
    setDownloadError(null);
    setEmptyMessage(null);
    setDownloadAttempt(0);
    setConnectionDownloads([]);
    setPhase('idle');
  }, [clearPolling, clearDownloadRetry, clearDoneDismiss, setPhase]);

  const startPull = useCallback(
    async (options: StartPullOptions) => {
      resetForNewRun(options.title, options.emptyStateMessage ?? null);
      if (!localPathRef.current) {
        setError('No local workspace path.');
        setPhase('error');
        return;
      }
      setPhase('starting');
      try {
        const result = await scratchApiClient.workspaces.pullFiles(workbookId, options.dataFolderIds, options.pullMode);
        const ids = result.jobIds ?? (result.jobId ? [result.jobId] : []);
        if (ids.length === 0) {
          setEmptyMessage(result.warning ?? options.emptyStateMessage ?? 'No linked tables found for this selection.');
          setPhase('done');
          return;
        }
        setTrackedJobIds(ids);
        setPhase('polling');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to start pull jobs');
        setPhase('error');
      }
    },
    [resetForNewRun, setPhase, workbookId],
  );

  const watchActivePulls = useCallback(
    async (options?: { title?: string }): Promise<boolean> => {
      // Don't interrupt a pull we're already tracking (e.g. a focus event firing
      // mid-pull). The current run is already surfaced to the user.
      if (isActivePhase(phaseRef.current)) {
        return true;
      }
      // Fetch first and only commit to tracking once we know there are jobs, so a
      // no-op check (the common case on window focus) never flashes the indicator.
      let pullJobs: Job[];
      try {
        const activeJobs = await scratchApiClient.job.getActiveJobsByWorkbook(workbookId);
        pullJobs = activeJobs.filter((job) => PULL_JOB_TYPES.has(job.type));
      } catch (err) {
        console.debug('[usePullTracker] failed to fetch active jobs:', err);
        return false;
      }
      if (pullJobs.length === 0) {
        return false;
      }
      resetForNewRun(options?.title ?? 'Pulling files', null);
      const ids = pullJobs.map((job) => job.bullJobId).filter((id): id is string => id != null);
      setJobs(pullJobs);
      setTrackedJobIds(ids);
      setPhase('polling');
      return true;
    },
    [resetForNewRun, setPhase, workbookId],
  );

  // Re-run the local download from scratch (used by the "Try again" button after
  // a surfaced failure).
  const retryDownload = useCallback(() => {
    clearDownloadRetry();
    setDownloadError(null);
    setDownloadAttempt(0);
    setPhase('downloading');
  }, [clearDownloadRetry, setPhase]);

  // Poll the tracked jobs until all reach a terminal state, then move on to the
  // local download.
  useEffect(() => {
    if (phase !== 'polling' || trackedJobIds.length === 0) {
      clearPolling();
      return;
    }

    let cancelled = false;

    const poll = async () => {
      try {
        const statuses = await scratchApiClient.job.getJobsStatus(trackedJobIds);
        if (cancelled) return;

        const byId = new Map(statuses.map((job) => [job.bullJobId ?? '', job]));
        const hydrated = trackedJobIds.map(
          (jobId) =>
            byId.get(jobId) ?? { bullJobId: jobId, state: 'active' as const, type: 'pull-linked-folder-files' },
        );
        setJobs(hydrated);

        if (hydrated.every((job) => isTerminalJobState(job.state))) {
          clearPolling();
          if (hydrated.every((job) => job.state === 'completed')) {
            setPhase('downloading');
          } else {
            setError('One or more pull jobs did not complete successfully.');
            setPhase('error');
          }
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to poll pull jobs');
        setPhase('error');
      }
    };

    void poll();
    pollingIntervalRef.current = window.setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearPolling();
    };
  }, [phase, trackedJobIds, clearPolling, setPhase]);

  // DEV-10846: `files download` fans its connections out in parallel and reports
  // each one's progress, so the download phase can show real per-connection rows
  // instead of an indeterminate spinner. Subscribed for the hook's lifetime (the
  // main process only emits during a pull) and keyed by connection name, since
  // concurrent connections finish in arbitrary order.
  useEffect(() => {
    return window.scratchDesktop.onPullProgress((progress) => {
      setConnectionDownloads((current) => {
        switch (progress.event) {
          case 'plan':
            return progress.connections.map((connection) => ({ connection, state: 'pending' as const }));
          case 'started':
            return upsertConnectionDownload(current, progress.connection, { state: 'active' });
          case 'finished':
            return upsertConnectionDownload(current, progress.connection, {
              state: progress.status === 'error' ? 'error' : 'done',
              changedRecords: progress.changedRecords,
            });
        }
      });
    });
  }, []);

  // After all pull jobs complete, materialize files locally. The records are
  // already on the server; this writes the new/updated files into the local
  // workspace so they show up in the file tree. Failures are surfaced (never
  // reported as a phantom success), with a couple of automatic retries for a repo
  // that's still settling right after its pull job finished (DEV-10421).
  useEffect(() => {
    if (phase !== 'downloading') return;

    const localPath = localPathRef.current;
    if (!localPath) {
      setDownloadError('No local workspace path.');
      setPhase('download-error');
      return;
    }

    // Drop the previous attempt's rows so a retry (the DEV-10421 auto-retry and
    // the "Try again" button both re-enter here) doesn't show a full table of
    // `done`/`error` rows at 100% while the download is actually restarting.
    // Falls back to the spinner until the new run's `plan` event lands.
    setConnectionDownloads([]);

    let cancelled = false;

    // Either auto-retry (a settling repo usually clones on the next attempt) or,
    // once the budget is exhausted, surface the failure instead of pretending the
    // pull reached the local workspace.
    const onDownloadIncomplete = (message: string) => {
      if (cancelled) return;
      // Best-effort refresh so any folders that did download still appear.
      invalidateRef.current();
      if (downloadAttempt + 1 < MAX_DOWNLOAD_ATTEMPTS) {
        downloadRetryTimeoutRef.current = window.setTimeout(() => {
          if (cancelled) return;
          setDownloadAttempt((attempt) => attempt + 1);
        }, DOWNLOAD_RETRY_DELAY_MS);
      } else {
        setDownloadError(message);
        setPhase('download-error');
      }
    };

    window.scratchDesktop
      .pullWorkspaceChanges(localPath, { onDelete: 'remove' })
      .then((result) => {
        if (cancelled) return;
        // `files download` exits 0 even when it couldn't set up a newly added
        // connection (it only logs a warning), which would otherwise leave the new
        // folders silently missing. Treat that warning as a retriable failure
        // rather than reporting success. The warning prints to stderr even under
        // `--json` (the structured result is on stdout), so scan it there.
        const output = result?.stderr ?? '';
        if (output.includes(CONNECTION_SETUP_FAILURE_MARKER)) {
          console.debug('[usePullTracker] download reported a connection setup failure:', output);
          onDownloadIncomplete("A new connection's files couldn't be set up on this computer yet.");
          return;
        }
        invalidateRef.current();
        setPhase('done');
      })
      .catch((err) => {
        if (cancelled) return;
        console.debug('[usePullTracker] post-pull download failed:', err);
        onDownloadIncomplete(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
      clearDownloadRetry();
    };
  }, [phase, downloadAttempt, clearDownloadRetry, setPhase]);

  // Auto-dismiss the "complete" state after a few seconds so the ambient
  // indicator clears itself (and the modal closes) once the user has seen it.
  // Error states persist until the user acts on them.
  useEffect(() => {
    if (phase !== 'done') {
      return;
    }
    doneDismissTimeoutRef.current = window.setTimeout(() => {
      dismiss();
    }, DONE_AUTO_DISMISS_MS);
    return () => clearDoneDismiss();
  }, [phase, dismiss, clearDoneDismiss]);

  // Clean up any timers on unmount (e.g. switching workspaces).
  useEffect(() => {
    return () => {
      clearPolling();
      clearDownloadRetry();
      clearDoneDismiss();
    };
  }, [clearPolling, clearDownloadRetry, clearDoneDismiss]);

  const completedCount = jobs.filter((job) => job.state === 'completed').length;
  const totalCount = jobs.length;
  const progress = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : phase === 'done' ? 100 : 0;

  return {
    phase,
    isActive: isActivePhase(phase),
    jobs,
    progress,
    completedCount,
    totalCount,
    title,
    error,
    downloadError,
    emptyMessage,
    connectionDownloads,
    startPull,
    watchActivePulls,
    retryDownload,
    dismiss,
  };
}
