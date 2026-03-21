import { Injectable } from '@nestjs/common';
import {
  DirtyFileCountResponse,
  FileDiffStatus,
  GitGcResponse,
  GitObjectCountsResponse,
  HasDirtyFilesResponse,
} from '@spinner/shared-types';
// Trigger reload
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WSLogger } from 'src/logger';

/** Thrown when scratch-git returns a 404 — the repo, branch, or file does not exist. */
export class ScratchGitNotFoundError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly responseBody: string,
  ) {
    super(`scratch-git 404: ${endpoint}`);
    this.name = 'ScratchGitNotFoundError';
  }
}

export interface RepoFileRef {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

export interface CommitFilesResult {
  created: string[];
  updated: string[];
  unchanged: string[];
}

// Maximum number of response body characters to log when an error occurs
const MAX_LOG_RESPONSE = 1000;

@Injectable()
export class ScratchGitClient {
  private readonly gitApiUrl: string;

  constructor(private readonly configService: ScratchConfigService) {
    this.gitApiUrl = this.configService.getScratchGitApiUrl();
  }

  /** Encode a repo ID for use in URL paths (percent-encode slashes so deep paths stay as one segment) */
  private encodeRepoId(repoId: string): string {
    return repoId.split('/').map(encodeURIComponent).join('%2F');
  }

  private async callGitApi(endpoint: string, method: string, body?: any): Promise<unknown> {
    const url = `${this.gitApiUrl}${endpoint}`;
    const options: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const startMs = Date.now();
    let response: Response;
    try {
      response = await fetch(url, options);
    } catch (err) {
      // Node's fetch wraps connection errors in a generic TypeError — unwrap to get the real cause
      const rootCause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
      WSLogger.error({
        source: 'ScratchGitClient.callGitApi',
        message: 'Failed to connect to scratch-git',
        method,
        url,
        durationMs: Date.now() - startMs,
        error: rootCause,
      });
      throw err;
    }

    const durationMs = Date.now() - startMs;

    if (!response.ok) {
      const text = await response.text();
      const responseBody = text.length > MAX_LOG_RESPONSE ? text.slice(0, MAX_LOG_RESPONSE) + '… (truncated)' : text;

      // 404s are expected control flow (repo/branch/file doesn't exist) — don't log, throw typed error
      if (response.status === 404) {
        throw new ScratchGitNotFoundError(endpoint, responseBody);
      }

      const error = new Error(`Received error code from scratch-git API: ${endpoint}: HTTP ${response.status}`);
      WSLogger.error({
        source: 'ScratchGitClient.callGitApi',
        message: 'scratch-git returned error response',
        method,
        url,
        durationMs,
        status: response.status,
        responseBody,
        error,
      });
      throw error;
    }

    // Read as text first so we can log the body if JSON parsing fails
    const responseText = await response.text();
    let jsonResult: { data: unknown; status: unknown };
    try {
      jsonResult = JSON.parse(responseText) as { data: unknown; status: unknown };
    } catch (err) {
      const responseBody =
        responseText.length > MAX_LOG_RESPONSE
          ? responseText.slice(0, MAX_LOG_RESPONSE) + '… (truncated)'
          : responseText;
      WSLogger.error({
        source: 'ScratchGitClient.callGitApi',
        message: 'scratch-git returned invalid JSON',
        method,
        url,
        durationMs,
        status: response.status,
        responseBody,
        error: err,
      });
      throw new Error(`Git API Error ${endpoint}: invalid JSON response`);
    }

    // Unpack { data, status } wrapper if present, otherwise return raw json directly
    if (jsonResult && typeof jsonResult === 'object' && 'data' in jsonResult) {
      return jsonResult.data;
    }
    return jsonResult;
  }

  async initRepo(repoId: string): Promise<void> {
    await this.callGitApi(`/api/repo/manage/${this.encodeRepoId(repoId)}/init`, 'POST');
  }

  async deleteRepo(repoId: string): Promise<void> {
    await this.callGitApi(`/api/repo/manage/${this.encodeRepoId(repoId)}`, 'DELETE');
  }

  async copyRepo(from: string, to: string): Promise<void> {
    await this.callGitApi(`/api/repo/manage/copy`, 'POST', { from, to });
  }

  async resetRepo(repoId: string, path?: string): Promise<void> {
    await this.callGitApi(`/api/repo/manage/${this.encodeRepoId(repoId)}/reset`, 'POST', { path });
  }

  async gc(repoId: string, aggressive?: boolean): Promise<GitGcResponse> {
    return this.callGitApi(`/api/repo/manage/${this.encodeRepoId(repoId)}/gc`, 'POST', {
      aggressive,
    }) as Promise<GitGcResponse>;
  }

  async getObjectCounts(repoId: string): Promise<GitObjectCountsResponse> {
    return this.callGitApi(
      `/api/repo/manage/${this.encodeRepoId(repoId)}/count-objects`,
      'GET',
    ) as Promise<GitObjectCountsResponse>;
  }

  async commitFiles(
    repoId: string,
    branch: string,
    files: Array<{ path: string; content: string }>,
    message: string,
  ): Promise<CommitFilesResult> {
    const result = await this.callGitApi(
      `/api/repo/write/${this.encodeRepoId(repoId)}/files?branch=${branch}`,
      'POST',
      { files, message },
    );
    const data = result as Record<string, unknown>;
    return {
      created: (data.created as string[]) ?? [],
      updated: (data.updated as string[]) ?? [],
      unchanged: (data.unchanged as string[]) ?? [],
    };
  }

  async deleteFolder(repoId: string, folder: string, message: string, branch?: string): Promise<void> {
    const branchParam = branch ? `&branch=${encodeURIComponent(branch)}` : '';
    await this.callGitApi(
      `/api/repo/write/${this.encodeRepoId(repoId)}/folder?folder=${encodeURIComponent(folder)}${branchParam}`,
      'DELETE',
      {
        message,
      },
    );
  }

  async removeDataFolder(repoId: string, folder: string): Promise<void> {
    await this.callGitApi(`/api/repo/write/${this.encodeRepoId(repoId)}/data-folder`, 'DELETE', { path: folder });
  }

  async deleteFiles(repoId: string, branch: string, files: string[], message: string): Promise<void> {
    await this.callGitApi(`/api/repo/write/${this.encodeRepoId(repoId)}/files?branch=${branch}`, 'DELETE', {
      files,
      message,
    });
  }

  async publishFile(repoId: string, file: { path: string; content: string }, message: string): Promise<void> {
    await this.callGitApi(`/api/repo/write/${this.encodeRepoId(repoId)}/publish`, 'POST', {
      file,
      message,
    });
  }

  async renameFiles(
    repoId: string,
    folderPath: string,
    renames: { oldName: string; newName: string }[],
    message: string,
  ): Promise<void> {
    await this.callGitApi(`/api/repo/write/${this.encodeRepoId(repoId)}/rename`, 'POST', {
      folderPath,
      renames,
      message,
    });
  }

  async rebaseDirty(repoId: string): Promise<{ rebased: boolean; conflicts: string[] }> {
    return this.callGitApi(`/api/repo/write/${this.encodeRepoId(repoId)}/rebase`, 'POST', {}) as Promise<{
      rebased: boolean;
      conflicts: string[];
    }>;
  }

  async list(repoId: string, branch: string, folder: string): Promise<RepoFileRef[]> {
    try {
      return (await this.callGitApi(
        `/api/repo/read/${this.encodeRepoId(repoId)}/list?branch=${branch}&folder=${encodeURIComponent(folder)}`,
        'GET',
      )) as RepoFileRef[];
    } catch (err) {
      // Repo doesn't exist yet (not pulled) or folder doesn't exist — no files to list
      if (err instanceof ScratchGitNotFoundError) return [];
      throw err;
    }
  }

  async getFile(repoId: string, branch: string, path: string): Promise<{ content: string } | null> {
    try {
      const response = await this.callGitApi(
        `/api/repo/read/${this.encodeRepoId(repoId)}/file?branch=${branch}&path=${encodeURIComponent(path)}`,
        'GET',
      );
      return response as { content: string };
    } catch (err) {
      if (err instanceof ScratchGitNotFoundError) return null;
      throw err;
    }
  }

  async readFiles(
    repoId: string,
    branch: string,
    paths: string[],
  ): Promise<Array<{ path: string; content: string | null }>> {
    return this.callGitApi(`/api/repo/read/${this.encodeRepoId(repoId)}/files`, 'POST', { branch, paths }) as Promise<
      Array<{ path: string; content: string | null }>
    >;
  }

  async readFilesFromFolder(
    repoId: string,
    branch: string,
    folderPath: string,
    filenames: string[],
  ): Promise<Array<{ path: string; content: string | null }>> {
    return this.callGitApi(`/api/repo/read/${this.encodeRepoId(repoId)}/files-from-folder`, 'POST', {
      branch,
      folderPath,
      filenames,
    }) as Promise<Array<{ path: string; content: string | null }>>;
  }

  async readFilesPaginated(
    repoId: string,
    branch: string,
    folder: string,
    limit: number,
    cursor?: string,
  ): Promise<{ files: Array<{ name: string; content: string }>; nextCursor?: string }> {
    let url = `/api/repo/read/${this.encodeRepoId(repoId)}/files-paginated?branch=${branch}&folder=${encodeURIComponent(folder)}&limit=${limit}`;
    if (cursor) {
      url += `&cursor=${encodeURIComponent(cursor)}`;
    }
    return this.callGitApi(url, 'GET') as Promise<{
      files: Array<{ name: string; content: string }>;
      nextCursor?: string;
    }>;
  }

  async listFilesPaginated(
    repoId: string,
    branch: string,
    folder: string,
    limit: number,
    cursor?: string,
  ): Promise<{ files: Array<{ name: string; path: string }>; nextCursor?: string }> {
    let url = `/api/repo/read/${this.encodeRepoId(repoId)}/files-paginated?branch=${branch}&folder=${encodeURIComponent(folder)}&limit=${limit}&metadataOnly=true`;
    if (cursor) {
      url += `&cursor=${encodeURIComponent(cursor)}`;
    }
    return this.callGitApi(url, 'GET') as Promise<{
      files: Array<{ name: string; path: string }>;
      nextCursor?: string;
    }>;
  }

  async readBlobsByOid(repoId: string, oids: string[]): Promise<Array<{ oid: string; content: string | null }>> {
    return this.callGitApi(`/api/repo/read/${this.encodeRepoId(repoId)}/blobs-by-oid`, 'POST', { oids }) as Promise<
      Array<{ oid: string; content: string | null }>
    >;
  }

  async getStatus(repoId: string): Promise<any> {
    return this.callGitApi(`/api/repo/diff/${this.encodeRepoId(repoId)}/status`, 'GET');
  }

  async hasDirtyFiles(repoId: string): Promise<HasDirtyFilesResponse> {
    return this.callGitApi(
      `/api/repo/diff/${this.encodeRepoId(repoId)}/status/has-dirty`,
      'GET',
    ) as Promise<HasDirtyFilesResponse>;
  }

  async getStatusCount(repoId: string): Promise<DirtyFileCountResponse> {
    return this.callGitApi(
      `/api/repo/diff/${this.encodeRepoId(repoId)}/status/count`,
      'GET',
    ) as Promise<DirtyFileCountResponse>;
  }

  async getDiff(repoId: string, path: string): Promise<string> {
    return this.callGitApi(
      `/api/repo/read/${this.encodeRepoId(repoId)}/diff?path=${encodeURIComponent(path)}`,
      'GET',
    ) as Promise<string>;
  }

  async getFolderDiff(repoId: string, folder: string): Promise<Array<{ path: string; status: FileDiffStatus }>> {
    return this.callGitApi(
      `/api/repo/diff/${this.encodeRepoId(repoId)}/folder-diff?folder=${encodeURIComponent(folder)}`,
      'GET',
    ) as Promise<Array<{ path: string; status: 'added' | 'modified' | 'deleted' }>>;
  }

  async getGraph(repoId: string): Promise<any> {
    return this.callGitApi(`/api/repo/debug/${this.encodeRepoId(repoId)}/graph`, 'GET');
  }

  async createCheckpoint(repoId: string, name: string): Promise<void> {
    await this.callGitApi(`/api/repo/checkpoint/${this.encodeRepoId(repoId)}`, 'POST', { name });
  }

  async listCheckpoints(repoId: string): Promise<{ name: string; timestamp: number; message: string }[]> {
    return this.callGitApi(`/api/repo/checkpoint/${this.encodeRepoId(repoId)}`, 'GET') as Promise<
      { name: string; timestamp: number; message: string }[]
    >;
  }

  async revertToCheckpoint(repoId: string, name: string): Promise<void> {
    await this.callGitApi(`/api/repo/checkpoint/${this.encodeRepoId(repoId)}/revert`, 'POST', { name });
  }

  async deleteCheckpoint(repoId: string, name: string): Promise<void> {
    await this.callGitApi(`/api/repo/checkpoint/${this.encodeRepoId(repoId)}/${encodeURIComponent(name)}`, 'DELETE');
  }

  async stripConnectionPrefix(repoId: string): Promise<StripPrefixResult> {
    return this.callGitApi(
      `/api/repo/manage/${this.encodeRepoId(repoId)}/strip-prefix`,
      'POST',
    ) as Promise<StripPrefixResult>;
  }

  async buildIndex(repoId: string): Promise<{ count: number }> {
    return this.callGitApi(`/api/repo/index/${this.encodeRepoId(repoId)}/build`, 'POST') as Promise<{ count: number }>;
  }

  async dumpIndex(repoId: string): Promise<GitIndexDump> {
    return this.callGitApi(`/api/repo/index/${this.encodeRepoId(repoId)}/dump`, 'GET') as Promise<GitIndexDump>;
  }
}

export interface StripPrefixResult {
  case: 'A' | 'B' | 'C' | 'empty';
  prefixStripped?: string;
  newMain?: string;
  newDirty?: string;
  newMergeBase?: string;
}

export interface GitIndexFile {
  folder: string;
  filename: string;
  remoteId: string | null;
}

export interface GitIndexReference {
  sourceFolder: string;
  sourceFilename: string;
  targetTableId: string;
  targetRemoteId: string;
}

export interface GitIndexDump {
  files: GitIndexFile[];
  references: GitIndexReference[];
}

export interface StripPrefixResult {
  case: 'A' | 'B' | 'C' | 'empty';
  prefixStripped?: string;
  newMain?: string;
  newDirty?: string;
  newMergeBase?: string;
}
