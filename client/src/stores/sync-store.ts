import { jobApi } from '@/lib/api/job';
import { syncApi } from '@/lib/api/sync';
import { trackRunSync } from '@/lib/posthog';
import { Job, Sync, SyncId, WorkbookId } from '@spinner/shared-types';
import { create } from 'zustand';
import { useActiveJobsStore } from './active-jobs-store';

interface SyncStoreState {
  syncs: Sync[];
  activeJobs: Record<SyncId, string>; // Maps SyncId to JobId
  jobStatuses: Record<string, Job>; // Maps JobId to Job
  isPolling: boolean;
  isLoading: boolean;
  workbookId: WorkbookId | null;

  // Actions
  fetchSyncs: (workbookId: WorkbookId) => Promise<void>;
  runSync: (workbookId: WorkbookId, syncId: SyncId) => Promise<void>;
  // Internal use but exposed for manual trigger if needed
  startPolling: () => void;
}

export const useSyncStore = create<SyncStoreState>((set, get) => ({
  syncs: [],
  activeJobs: {},
  jobStatuses: {},
  isPolling: false,
  isLoading: false,
  workbookId: null, // Initial state for workbookId

  fetchSyncs: async (workbookId: WorkbookId) => {
    try {
      set({ workbookId, isLoading: true }); // Verify we have it
      const syncs = await syncApi.list(workbookId);
      set({ syncs, isLoading: false });
    } catch (error) {
      console.error('Failed to fetch syncs:', error);
      set({ isLoading: false });
    }
  },

  runSync: async (workbookId: WorkbookId, syncId: SyncId) => {
    try {
      set({ workbookId }); // Ensure it's set
      trackRunSync(syncId, workbookId);
      const { jobId } = await syncApi.run(workbookId, syncId);
      useActiveJobsStore.getState().trackJobIds([jobId]);

      set((state) => ({
        activeJobs: { ...state.activeJobs, [syncId]: jobId },
        // Set initial optimistic status
        jobStatuses: {
          ...state.jobStatuses,
          [jobId]: {
            state: 'active',
            type: 'sync',
            dbJobId: jobId,
          } as Job,
        },
      }));

      get().startPolling();
    } catch (error) {
      console.error('Failed to run sync:', error);
      throw error;
    }
  },

  startPolling: () => {
    if (get().isPolling) return;
    set({ isPolling: true });

    const poll = async () => {
      const state = get();
      const jobIds = Object.values(state.activeJobs);

      if (jobIds.length === 0) {
        set({ isPolling: false });
        return;
      }

      const updates: Record<string, Job> = {};
      const finishedSyncIds: SyncId[] = [];
      let shouldRefreshSyncs = false;

      // Bulk fetch statuses
      try {
        const jobs = await jobApi.getJobsStatus(jobIds);

        for (const job of jobs) {
          if (!job.dbJobId) continue;
          updates[job.dbJobId] = job;

          if (job.state === 'completed' || job.state === 'failed' || job.state === 'canceled') {
            const syncId = Object.keys(state.activeJobs).find(
              (key) => state.activeJobs[key as SyncId] === job.bullJobId,
            ) as SyncId;

            if (syncId) {
              finishedSyncIds.push(syncId);
              if (job.state === 'completed') {
                shouldRefreshSyncs = true;
              }
            }
          }
        }
      } catch (error) {
        console.error('Failed to poll jobs:', error);
      }

      set((prev) => {
        const nextActiveJobs = { ...prev.activeJobs };
        for (const syncId of finishedSyncIds) {
          delete nextActiveJobs[syncId];
        }
        return {
          jobStatuses: { ...prev.jobStatuses, ...updates },
          activeJobs: nextActiveJobs,
        };
      });

      // If any sync completed, we might want to refresh the list to show updated "Last run"
      // However, we need workbookId.
      // We can rely on the UI to re-fetch if it observes a completion, or store workbookId in store.
      // For now, let's keep it simple.

      if (shouldRefreshSyncs && state.workbookId) {
        get().fetchSyncs(state.workbookId);
      }

      if (Object.keys(get().activeJobs).length > 0) {
        setTimeout(poll, 1000);
      } else {
        set({ isPolling: false });
      }
    };

    poll();
  },
}));
