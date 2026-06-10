import type { RepoFileResponse } from '../../dto/publish-plan/publish-job-responses.dto';
import type { GitFile, GitIndexDump, StripPrefixConnectionResult } from '../../dto/scratch-git/scratch-git.dto';
import type {
  DirtyFile,
  DirtyFileCountResponse,
  GitGcResponse,
  GitObjectCountsResponse,
  HasDirtyFilesResponse,
} from '../../file-types';
import { ScratchpadApiError } from '../error';
import type { Http } from '../http';

/**
 * Git-layer operations for a workspace: the `scratch-git` microservice surface (repo reads,
 * status, graph, gc, index, checkpoints, migration) plus the workbook working-tree mutations
 * (`discard-changes`, `reset`). Reached as `client.git.*`.
 */
export function createGitApi(http: Http) {
  return {
    backupWorkbookToRepo: async (workbookId: string): Promise<{ success: boolean; message: string }> => {
      const res = await http.post<{ success: boolean; message: string }>(
        `/scratch-git/${workbookId}/backup`,
        undefined,
        {
          fallbackMessage: 'Failed to backup workspace',
        },
      );
      return res.data;
    },

    listRepoFiles: async (
      workbookId: string,
      branch = 'main',
      folder = '',
      connectorAccountId?: string,
      useConfigRepo?: boolean,
    ): Promise<GitFile[]> => {
      const res = await http.get<GitFile[]>(`/scratch-git/${workbookId}/list`, {
        params: { branch, folder, connectorAccountId, useConfigRepo: useConfigRepo ? 'true' : undefined },
        fallbackMessage: 'Failed to list repository files',
      });
      return res.data;
    },

    /**
     * Read a file from a connection's bare git repo at a ref. WEB behavior: returns `{ content }`
     * and THROWS on any error. (Desktop's null-on-404 variant is {@link getRepoFileOrNull}.)
     */
    getRepoFile: async (
      workbookId: string,
      path: string,
      branch = 'main',
      connectorAccountId?: string,
      useConfigRepo?: boolean,
    ): Promise<{ content: string }> => {
      const res = await http.get<{ content: string }>(`/scratch-git/${workbookId}/file`, {
        params: { branch, path, connectorAccountId, useConfigRepo: useConfigRepo ? 'true' : undefined },
        fallbackMessage: 'Failed to get file content',
      });
      return res.data;
    },

    /**
     * Read a file from a connection's bare git repo at a ref. DESKTOP behavior: returns `null` when
     * the file is missing at that ref (HTTP 404) instead of throwing — e.g. a deleted record on the
     * post side or a created record on the pre side. (Web's throwing variant is {@link getRepoFile}.)
     */
    getRepoFileOrNull: async (
      workbookId: string,
      path: string,
      branch: string,
      connectorAccountId?: string,
    ): Promise<RepoFileResponse | null> => {
      try {
        const res = await http.get<RepoFileResponse | null>(`/scratch-git/${workbookId}/file`, {
          params: { branch, path, connectorAccountId },
          fallbackMessage: 'Failed to get file content',
        });
        return res.data;
      } catch (error) {
        if (error instanceof ScratchpadApiError && error.statusCode === 404) return null;
        throw error;
      }
    },

    getRepoStatus: async (workbookId: string): Promise<object> => {
      const res = await http.get<object>(`/scratch-git/${workbookId}/git-status`, {
        fallbackMessage: 'Failed to get repo status',
      });
      return res.data;
    },

    getRepoDiff: async (workbookId: string, path: string): Promise<string> => {
      const res = await http.get<string>(`/scratch-git/${workbookId}/git-diff`, {
        params: { path },
        fallbackMessage: 'Failed to get file diff',
      });
      return res.data;
    },

    getGraph: async (
      workbookId: string,
      connectorAccountId?: string,
      useConfigRepo?: boolean,
    ): Promise<{ commits: unknown[]; refs: unknown[] }> => {
      const res = await http.get<{ commits: unknown[]; refs: unknown[] }>(`/scratch-git/${workbookId}/graph`, {
        params: { connectorAccountId, useConfigRepo: useConfigRepo ? 'true' : undefined },
        fallbackMessage: 'Failed to get git graph',
      });
      return res.data;
    },

    rebaseDirty: async (workbookId: string, connectorAccountId?: string): Promise<void> => {
      await http.post(
        `/scratch-git/${workbookId}/rebase`,
        {},
        {
          params: { connectorAccountId },
          fallbackMessage: 'Failed to rebase dirty branch',
        },
      );
    },

    runGitGc: async (workbookId: string, aggressive?: boolean, connectorAccountId?: string): Promise<GitGcResponse> => {
      const res = await http.post<GitGcResponse>(
        `/scratch-git/${workbookId}/gc`,
        { aggressive },
        {
          params: { connectorAccountId },
          fallbackMessage: 'Failed to run git gc',
        },
      );
      return res.data;
    },

    getObjectCounts: async (workbookId: string, connectorAccountId?: string): Promise<GitObjectCountsResponse> => {
      const res = await http.get<GitObjectCountsResponse>(`/scratch-git/${workbookId}/object-counts`, {
        params: { connectorAccountId },
        fallbackMessage: 'Failed to get object counts',
      });
      return res.data;
    },

    buildIndex: async (workbookId: string, connectorAccountId?: string): Promise<{ count: number }> => {
      const res = await http.post<{ count: number }>(
        `/scratch-git/${workbookId}/index/build`,
        {},
        {
          params: { connectorAccountId },
          fallbackMessage: 'Failed to build index',
        },
      );
      return res.data;
    },

    dumpIndex: async (workbookId: string, connectorAccountId?: string): Promise<GitIndexDump> => {
      const res = await http.get<GitIndexDump>(`/scratch-git/${workbookId}/index/dump`, {
        params: { connectorAccountId },
        fallbackMessage: 'Failed to dump index',
      });
      return res.data;
    },

    hasDirtyFiles: async (workbookId: string): Promise<HasDirtyFilesResponse> => {
      const res = await http.get<HasDirtyFilesResponse>(`/scratch-git/${workbookId}/git-has-dirty`, {
        fallbackMessage: 'Failed to check dirty status',
      });
      return res.data;
    },

    getStatusCount: async (workbookId: string): Promise<DirtyFileCountResponse> => {
      const res = await http.get<DirtyFileCountResponse>(`/scratch-git/${workbookId}/git-status-count`, {
        fallbackMessage: 'Failed to get git status count',
      });
      return res.data;
    },

    getStatus: async (workbookId: string): Promise<DirtyFile[]> => {
      const res = await http.get<DirtyFile[]>(`/scratch-git/${workbookId}/git-status`, {
        fallbackMessage: 'Failed to get git status',
      });
      return res.data;
    },

    createCheckpoint: async (workbookId: string, name: string): Promise<void> => {
      await http.post(
        `/scratch-git/${workbookId}/checkpoint`,
        { name },
        {
          fallbackMessage: 'Failed to create checkpoint',
        },
      );
    },

    listCheckpoints: async (workbookId: string): Promise<{ name: string; timestamp: number; message: string }[]> => {
      const res = await http.get<{ name: string; timestamp: number; message: string }[]>(
        `/scratch-git/${workbookId}/checkpoints`,
        { fallbackMessage: 'Failed to list checkpoints' },
      );
      return res.data;
    },

    revertToCheckpoint: async (workbookId: string, name: string): Promise<void> => {
      await http.post(
        `/scratch-git/${workbookId}/checkpoint/revert`,
        { name },
        {
          fallbackMessage: 'Failed to revert to checkpoint',
        },
      );
    },

    deleteCheckpoint: async (workbookId: string, name: string): Promise<void> => {
      await http.delete(`/scratch-git/${workbookId}/checkpoint/${name}`, {
        fallbackMessage: 'Failed to delete checkpoint',
      });
    },

    discardChanges: async (workbookId: string, path?: string): Promise<void> => {
      await http.post(
        `/workbook/${workbookId}/discard-changes`,
        { path },
        {
          fallbackMessage: 'Failed to discard changes',
        },
      );
    },

    resetWorkbook: async (workbookId: string): Promise<void> => {
      await http.post(`/workbook/${workbookId}/reset`, undefined, { fallbackMessage: 'Failed to reset workspace' });
    },

    migrateToV2: async (workbookId: string): Promise<{ success: boolean }> => {
      const res = await http.post<{ success: boolean }>(`/scratch-git/${workbookId}/migrate-to-v2`, undefined, {
        fallbackMessage: 'Failed to migrate workspace to v2',
      });
      return res.data;
    },

    stripConnectionPrefix: async (
      workbookId: string,
      connectorAccountId?: string,
    ): Promise<{ results: StripPrefixConnectionResult[] }> => {
      const res = await http.post<{ results: StripPrefixConnectionResult[] }>(
        `/scratch-git/${workbookId}/strip-connection-prefix`,
        {},
        { params: { connectorAccountId }, fallbackMessage: 'Failed to strip connection prefix' },
      );
      return res.data;
    },

    gitServiceProxy: async (
      workbookId: string,
      connectionId: string,
      path: string,
      method: string,
      body?: Record<string, unknown>,
    ): Promise<unknown> => {
      const normalizedPath = path.startsWith('/') ? path.substring(1) : path;
      const res = await http.request<unknown>({
        method,
        url: `/scratch-git/${workbookId}/git-service/${connectionId}/${normalizedPath}`,
        data: body,
        fallbackMessage: `Git service proxy error: ${path}`,
      });
      return res.data;
    },
  };
}

export type GitApi = ReturnType<typeof createGitApi>;
