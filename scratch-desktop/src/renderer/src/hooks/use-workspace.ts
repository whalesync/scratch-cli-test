import type { Workspace } from '@spinner/shared-types';
import { useCallback } from 'react';
import useSWR from 'swr';
import { scratchApiClient } from '../lib/scratch-api-client';

export interface UseWorkspaceResult {
  workspace: Workspace | undefined;
  isLoading: boolean;
  error: Error | undefined;
  refreshWorkspace: () => Promise<void>;
}

/**
 * Loads a single workspace's detail (including its creator owner `userId`).
 * Pass `null` to skip fetching.
 */
export function useWorkspace(workbookId: string | null): UseWorkspaceResult {
  const { data, isLoading, error, mutate } = useSWR<Workspace, Error>(
    workbookId ? `/workspaces/${workbookId}` : null,
    () => {
      if (!workbookId) {
        throw new Error('workbookId is required');
      }
      return scratchApiClient.workspaces.detail(workbookId);
    },
    {
      revalidateOnFocus: false,
    },
  );

  const refreshWorkspace = useCallback(async () => {
    await mutate();
  }, [mutate]);

  return {
    workspace: data,
    isLoading,
    error,
    refreshWorkspace,
  };
}
