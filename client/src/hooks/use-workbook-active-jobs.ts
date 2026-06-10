import { selectJobsForConnector, selectJobsForDataFolder, useActiveJobsStore } from '@/stores/active-jobs-store';
import { DataFolder, DataFolderId, Job, WorkbookId } from '@spinner/shared-types';
import { useCallback, useEffect } from 'react';

// TODO: refactor callers to just use useActiveJobsStore directly?
export function useWorkbookActiveJobs(workbookId: WorkbookId | undefined) {
  const activeJobs = useActiveJobsStore((s) => s.activeJobs);
  const error = useActiveJobsStore((s) => s.error);
  const isLoading = useActiveJobsStore((s) => s.isLoading);
  const subscribe = useActiveJobsStore((s) => s.subscribe);
  const unsubscribe = useActiveJobsStore((s) => s.unsubscribe);
  const storeRefreshJobs = useActiveJobsStore((s) => s.refreshJobs);

  useEffect(() => {
    if (!workbookId) return;
    subscribe(workbookId);
    return () => unsubscribe();
  }, [workbookId, subscribe, unsubscribe]);

  const getJobsForDataFolder = useCallback(
    (dataFolderId: DataFolderId): Job[] => {
      return selectJobsForDataFolder(activeJobs, dataFolderId);
    },
    [activeJobs],
  );

  const getJobsForConnector = useCallback(
    (connectorAccountId: string, dataFolders: DataFolder[]): Job[] => {
      return selectJobsForConnector(activeJobs, connectorAccountId, dataFolders);
    },
    [activeJobs],
  );

  const refreshJobs = useCallback(async () => {
    await storeRefreshJobs();
  }, [storeRefreshJobs]);

  return {
    activeJobs,
    error,
    isLoading,
    refreshJobs,
    getJobsForDataFolder,
    getJobsForConnector,
  };
}
