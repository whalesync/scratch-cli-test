import { ScratchpadNotifications } from '@/app/components/ScratchpadNotifications';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { getJobDescription, getJobType, getTypeLabel } from '@/utils/job-helpers';
import { RouteUrls } from '@/utils/route-urls';
import { DataFolder, DataFolderId, Job, WorkbookId } from '@spinner/shared-types';
import Link from 'next/link';
import React from 'react';
import { create } from 'zustand';

interface ActiveJobsStoreState {
  activeJobs: Job[];
  workbookId: WorkbookId | null;
  isPolling: boolean;
  isLoading: boolean;
  error: Error | null;
  _prevActiveIds: Set<string>;
  _hasInitialized: boolean;
  _pollTimeoutId: ReturnType<typeof setTimeout> | null;
  _subscriberCount: number;

  // Actions
  subscribe: (workbookId: WorkbookId) => void;
  unsubscribe: () => void;
  refreshJobs: () => Promise<void>;
  trackJobIds: (ids: string[]) => void;
  _startPolling: (workbookId: WorkbookId) => void;
  _stopPolling: () => void;
}

export const useActiveJobsStore = create<ActiveJobsStoreState>((set, get) => ({
  activeJobs: [],
  workbookId: null,
  isPolling: false,
  isLoading: false,
  error: null,
  _prevActiveIds: new Set(),
  _hasInitialized: false,
  _pollTimeoutId: null,
  _subscriberCount: 0,

  subscribe: (workbookId: WorkbookId) => {
    const state = get();

    if (state.workbookId !== workbookId) {
      // Workbook changed — reset state and restart
      state._stopPolling();
      set({
        activeJobs: [],
        workbookId,
        isLoading: true,
        error: null,
        _prevActiveIds: new Set(),
        _hasInitialized: false,
        _subscriberCount: 1,
      });
      get()._startPolling(workbookId);
    } else {
      set({ _subscriberCount: state._subscriberCount + 1 });
      if (!state.isPolling) {
        get()._startPolling(workbookId);
      }
    }
  },

  unsubscribe: () => {
    const state = get();
    const newCount = Math.max(0, state._subscriberCount - 1);
    set({ _subscriberCount: newCount });
    if (newCount === 0) {
      get()._stopPolling();
    }
  },

  refreshJobs: async () => {
    const { workbookId } = get();
    if (!workbookId) return;

    try {
      const jobs = await scratchApiClient.job.getActiveJobsByWorkbook(workbookId);

      // Guard: workbookId may have changed during the fetch
      if (get().workbookId !== workbookId) return;

      const currentIds = new Set(jobs.map((job) => job.bullJobId).filter((id): id is string => !!id));
      const state = get();

      if (!state._hasInitialized) {
        set({
          activeJobs: jobs,
          isLoading: false,
          error: null,
          _prevActiveIds: currentIds,
          _hasInitialized: true,
        });
        return;
      }

      const disappearedIds = [...state._prevActiveIds].filter((id) => !currentIds.has(id));
      if (disappearedIds.length > 0) {
        void notifyCompletedJobs(workbookId, disappearedIds);
      }

      set({
        activeJobs: jobs,
        isLoading: false,
        error: null,
        _prevActiveIds: currentIds,
      });
    } catch (err) {
      if (get().workbookId !== workbookId) return;
      set({ error: err as Error, isLoading: false });
    }
  },

  trackJobIds: (ids: string[]) => {
    const state = get();
    if (!state._hasInitialized || ids.length === 0) return;
    const next = new Set(state._prevActiveIds);
    for (const id of ids) {
      next.add(id);
    }
    set({ _prevActiveIds: next });
  },

  _startPolling: (workbookId: WorkbookId) => {
    if (get().isPolling) return;
    set({ isPolling: true });

    const poll = async () => {
      // Guard: stop if polling was cancelled or workbook changed
      const state = get();
      if (!state.isPolling || state.workbookId !== workbookId) return;

      await get().refreshJobs();

      // Schedule next poll if still active
      if (get().isPolling && get().workbookId === workbookId) {
        const timeoutId = setTimeout(poll, 5000);
        set({ _pollTimeoutId: timeoutId });
      }
    };

    poll();
  },

  _stopPolling: () => {
    const { _pollTimeoutId } = get();
    if (_pollTimeoutId) {
      clearTimeout(_pollTimeoutId);
    }
    set({ isPolling: false, _pollTimeoutId: null });
  },
}));

// --- Standalone helpers ---

async function notifyCompletedJobs(workbookId: string, disappearedIds: string[]) {
  const finishedJobs = await scratchApiClient.job.getJobsStatus(disappearedIds);

  for (const job of finishedJobs) {
    const jobType = getJobType(job.type);
    const label = getTypeLabel(jobType);
    const description = getJobDescription(job);
    const jobKey = `${job.bullJobId}`;
    const runsUrl = RouteUrls.workbookRunsPageUrl(workbookId, { jobId: jobKey });

    if (job.state === 'completed') {
      const progress = job.publicProgress as Record<string, unknown> | undefined;
      const progressTables = progress?.tables;
      const tables = Array.isArray(progressTables) ? (progressTables as Array<{ warnings?: unknown[] }>) : [];
      const hasWarnings = tables.some((t) => t.warnings && t.warnings.length > 0);

      if (hasWarnings) {
        ScratchpadNotifications.warning({
          title: `${label} completed with warnings`,
          message: React.createElement(
            'span',
            null,
            description,
            ' — ',
            React.createElement(Link, { href: runsUrl, style: { textDecoration: 'underline' } }, 'More info'),
          ),
        });
      } else {
        ScratchpadNotifications.success({
          title: `${label} completed`,
          message: React.createElement(
            'span',
            null,
            description,
            ' — ',
            React.createElement(Link, { href: runsUrl, style: { textDecoration: 'underline' } }, 'More info'),
          ),
        });
      }
    } else if (job.state === 'failed') {
      ScratchpadNotifications.error({
        title: `${label.charAt(0)}${label.slice(1).toLowerCase()} failed`,
        message: React.createElement(
          'span',
          null,
          job.failedReason || 'Job failed',
          ' — ',
          React.createElement(Link, { href: runsUrl, style: { textDecoration: 'underline' } }, 'More info'),
        ),
      });
    }
  }
}

/**
 * Returns the data folder IDs referenced in a job's publicProgress.
 *
 * - pull-linked-folder-files: single folderId
 * - sync-data-folders: tables[].id
 */
export function getDataFolderIdsFromJob(job: Job): string[] {
  // Prefer the canonical dataFolderId from the database
  if (job.dataFolderId) {
    return [job.dataFolderId];
  }

  const progress = job.publicProgress as Record<string, unknown> | undefined;
  if (!progress) return [];

  // V2 pull jobs store all folder IDs
  if (Array.isArray(progress.dataFolderIds)) {
    return (progress.dataFolderIds as string[]).filter((id): id is string => typeof id === 'string');
  }

  // V1 pull jobs store a single folderId
  if (typeof progress.folderId === 'string') {
    return [progress.folderId];
  }

  // Publish and sync jobs store tables with id fields
  if (Array.isArray(progress.tables)) {
    return (progress.tables as { id?: string }[]).map((t) => t.id).filter((id): id is string => !!id);
  }

  return [];
}

export function selectJobsForDataFolder(activeJobs: Job[], dataFolderId: DataFolderId): Job[] {
  return activeJobs.filter((job) => {
    const folderIds = getDataFolderIdsFromJob(job);
    return folderIds.includes(dataFolderId);
  });
}

export function selectJobsForConnector(
  activeJobs: Job[],
  connectorAccountId: string,
  dataFolders: DataFolder[],
): Job[] {
  const folderIdsForConnector = new Set(
    dataFolders.filter((f) => f.connectorAccountId === connectorAccountId).map((f) => f.id),
  );
  return activeJobs.filter((job) => {
    const jobFolderIds = getDataFolderIdsFromJob(job);
    return jobFolderIds.some((id) => folderIdsForConnector.has(id as DataFolderId));
  });
}
