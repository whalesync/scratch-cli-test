import { useState } from 'react';

import { workbookApi, type GitIndexDump } from '@/lib/api/workbook';
import { notifications } from '@mantine/notifications';
import type { GitGcResponse, GitObjectCountsResponse, WorkbookId } from '@spinner/shared-types';

export function useGitActions() {
  const [indexData, setIndexData] = useState<GitIndexDump | null>(null);
  const [indexModalOpen, setIndexModalOpen] = useState(false);
  const [isBuildingIndex, setIsBuildingIndex] = useState(false);
  const [isBuildingPublishPlan, setIsBuildingPublishPlan] = useState(false);

  const [objectCountsData, setObjectCountsData] = useState<GitObjectCountsResponse | null>(null);
  const [objectCountsModalOpen, setObjectCountsModalOpen] = useState(false);
  const [isLoadingObjectCounts, setIsLoadingObjectCounts] = useState(false);

  const [gcData, setGcData] = useState<GitGcResponse | null>(null);
  const [gcModalOpen, setGcModalOpen] = useState(false);
  const [isGcing, setIsGcing] = useState(false);

  const [isRebasing, setIsRebasing] = useState(false);

  const [gitGraphTarget, setGitGraphTarget] = useState<{ workbookId: WorkbookId; connectorAccountId: string } | null>(
    null,
  );
  const [gitBrowserTarget, setGitBrowserTarget] = useState<{
    workbookId: WorkbookId;
    connectorAccountId: string;
  } | null>(null);

  const [stripPrefixData, setStripPrefixData] = useState<
    import('@/lib/api/workbook').StripPrefixConnectionResult[] | null
  >(null);
  const [stripPrefixModalOpen, setStripPrefixModalOpen] = useState(false);

  const handleViewIndex = async (workbookId: WorkbookId, connectorAccountId: string) => {
    try {
      const result = await workbookApi.dumpIndex(workbookId, connectorAccountId);
      setIndexData(result);
      setIndexModalOpen(true);
    } catch {
      notifications.show({ title: 'Error', message: 'Failed to load index (build it first)', color: 'red' });
    }
  };

  const handleBuildIndex = async (workbookId: WorkbookId, connectorAccountId: string) => {
    setIsBuildingIndex(true);
    try {
      const result = await workbookApi.buildIndex(workbookId, connectorAccountId);
      notifications.show({ title: 'Success', message: `Index built: ${result.count} files`, color: 'green' });
    } catch {
      notifications.show({ title: 'Error', message: 'Failed to build index', color: 'red' });
    } finally {
      setIsBuildingIndex(false);
    }
  };

  const handleBuildPublishPlan = async (workbookId: WorkbookId, connectorAccountId: string, connectionName: string) => {
    setIsBuildingPublishPlan(true);
    try {
      const result = (await workbookApi.gitServiceProxy(
        workbookId,
        connectorAccountId,
        'api/repo/publish-plan/:repoId/build',
        'POST',
        { connectionName, connectionId: connectorAccountId },
      )) as Record<string, unknown>;
      if (result.planId) {
        notifications.show({ title: 'Success', message: `Plan built: ${result.planId}`, color: 'green' });
      } else {
        notifications.show({
          title: 'No changes',
          message: String(result.message || 'Nothing to publish'),
          color: 'blue',
        });
      }
    } catch {
      notifications.show({ title: 'Error', message: 'Failed to build publish plan', color: 'red' });
    } finally {
      setIsBuildingPublishPlan(false);
    }
  };

  const handleGetObjectCounts = async (workbookId: WorkbookId, connectorAccountId?: string) => {
    setIsLoadingObjectCounts(true);
    try {
      const result = await workbookApi.getObjectCounts(workbookId, connectorAccountId);
      setObjectCountsData(result);
      setObjectCountsModalOpen(true);
    } catch {
      notifications.show({ title: 'Error', message: 'Failed to get object counts', color: 'red' });
    } finally {
      setIsLoadingObjectCounts(false);
    }
  };

  const handleRunGc = async (workbookId: WorkbookId, aggressive: boolean, connectorAccountId?: string) => {
    setIsGcing(true);
    try {
      const result = await workbookApi.runGitGc(workbookId, aggressive, connectorAccountId);
      setGcData(result);
      setGcModalOpen(true);
      notifications.show({ title: 'Success', message: 'Git GC complete', color: 'green' });
    } catch {
      notifications.show({ title: 'Error', message: 'Failed to run Git GC', color: 'red' });
    } finally {
      setIsGcing(false);
    }
  };

  const handleRebase = async (workbookId: WorkbookId, connectorAccountId?: string) => {
    setIsRebasing(true);
    try {
      await workbookApi.rebaseDirty(workbookId, connectorAccountId);
      notifications.show({ title: 'Success', message: 'Rebase complete', color: 'green' });
    } catch {
      notifications.show({ title: 'Error', message: 'Failed to rebase', color: 'red' });
    } finally {
      setIsRebasing(false);
    }
  };

  const handleStripPrefix = async (workbookId: WorkbookId, connectorAccountId: string) => {
    try {
      const result = await workbookApi.stripConnectionPrefix(workbookId, connectorAccountId);
      setStripPrefixData(result.results);
      setStripPrefixModalOpen(true);
      notifications.show({ title: 'Success', message: 'Strip prefix complete', color: 'green' });
    } catch {
      notifications.show({ title: 'Error', message: 'Failed to strip connection prefix', color: 'red' });
    }
  };

  const handleStripAllPrefixes = async (workbookId: WorkbookId) => {
    try {
      const result = await workbookApi.stripConnectionPrefix(workbookId);
      setStripPrefixData(result.results);
      setStripPrefixModalOpen(true);
      const errors = result.results.filter((r) => r.error).length;
      if (errors > 0) {
        notifications.show({
          title: 'Partial success',
          message: `${errors} connection(s) failed — see results`,
          color: 'yellow',
        });
      } else {
        notifications.show({
          title: 'Success',
          message: `Stripped ${result.results.length} connection(s)`,
          color: 'green',
        });
      }
    } catch {
      notifications.show({ title: 'Error', message: 'Failed to strip connection prefixes', color: 'red' });
    }
  };

  return {
    // Index
    indexData,
    indexModalOpen,
    setIndexModalOpen,
    isBuildingIndex,
    handleViewIndex,
    handleBuildIndex,
    // Publish plan
    isBuildingPublishPlan,
    handleBuildPublishPlan,
    // Object counts
    objectCountsData,
    objectCountsModalOpen,
    setObjectCountsModalOpen,
    isLoadingObjectCounts,
    handleGetObjectCounts,
    // GC
    gcData,
    gcModalOpen,
    setGcModalOpen,
    isGcing,
    handleRunGc,
    // Rebase
    isRebasing,
    handleRebase,
    // Strip prefix
    stripPrefixData,
    stripPrefixModalOpen,
    setStripPrefixModalOpen,
    handleStripPrefix,
    handleStripAllPrefixes,
    // Git graph / browser
    gitGraphTarget,
    setGitGraphTarget,
    gitBrowserTarget,
    setGitBrowserTarget,
  };
}

export type GitActions = ReturnType<typeof useGitActions>;
