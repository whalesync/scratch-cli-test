import { Injectable } from '@nestjs/common';
import { FileDiffStatus } from '@spinner/shared-types';
// Trigger reload
import { ScratchConfigService } from 'src/config/scratch-config.service';

@Injectable()
export class ScratchGitClient {
  private readonly gitApiUrl: string;

  constructor(private readonly configService: ScratchConfigService) {
    this.gitApiUrl = this.configService.getScratchGitApiUrl();
  }

  private async callGitApi(endpoint: string, method: string, body?: any): Promise<unknown> {
    const options: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`${this.gitApiUrl}${endpoint}`, options);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Git API Error ${endpoint}: ${response.status} ${text}`);
    }
    return response.json();
  }

  async initRepo(repoId: string): Promise<void> {
    await this.callGitApi(`/api/repo/manage/${repoId}/init`, 'POST');
  }

  async deleteRepo(repoId: string): Promise<void> {
    await this.callGitApi(`/api/repo/manage/${repoId}`, 'DELETE');
  }

  async resetRepo(repoId: string, path?: string): Promise<void> {
    await this.callGitApi(`/api/repo/manage/${repoId}/reset`, 'POST', { path });
  }

  async commitFiles(
    repoId: string,
    branch: string,
    files: Array<{ path: string; content: string }>,
    message: string,
  ): Promise<void> {
    await this.callGitApi(`/api/repo/write/${repoId}/files?branch=${branch}`, 'POST', {
      files,
      message,
    });
  }

  async deleteFolder(repoId: string, folder: string, message: string, branch?: string): Promise<void> {
    const branchParam = branch ? `&branch=${encodeURIComponent(branch)}` : '';
    await this.callGitApi(
      `/api/repo/write/${repoId}/folder?folder=${encodeURIComponent(folder)}${branchParam}`,
      'DELETE',
      {
        message,
      },
    );
  }

  async removeDataFolder(repoId: string, folder: string): Promise<void> {
    await this.callGitApi(`/api/repo/write/${repoId}/data-folder`, 'DELETE', { path: folder });
  }

  async deleteFiles(repoId: string, branch: string, files: string[], message: string): Promise<void> {
    await this.callGitApi(`/api/repo/write/${repoId}/files?branch=${branch}`, 'DELETE', {
      files,
      message,
    });
  }

  async publishFile(repoId: string, file: { path: string; content: string }, message: string): Promise<void> {
    await this.callGitApi(`/api/repo/write/${repoId}/publish`, 'POST', {
      file,
      message,
    });
  }

  async rebaseDirty(repoId: string): Promise<{ rebased: boolean; conflicts: string[] }> {
    return this.callGitApi(`/api/repo/write/${repoId}/rebase`, 'POST') as Promise<{
      rebased: boolean;
      conflicts: string[];
    }>;
  }

  async list(repoId: string, branch: string, folder: string): Promise<any[]> {
    return this.callGitApi(
      `/api/repo/read/${repoId}/list?branch=${branch}&folder=${encodeURIComponent(folder)}`,
      'GET',
    ) as Promise<any[]>;
  }

  async getFile(repoId: string, branch: string, path: string): Promise<{ content: string } | null> {
    try {
      console.log(`[ScratchGitClient] getFile: ${path} branch=${branch}`);
      const response = await this.callGitApi(
        `/api/repo/read/${repoId}/file?branch=${branch}&path=${encodeURIComponent(path)}`,
        'GET',
      );
      return response as { content: string };
    } catch (err) {
      console.error(`[ScratchGitClient] getFile error for ${path} (${branch}):`, err);
      return null;
    }
  }

  async readFiles(
    repoId: string,
    branch: string,
    paths: string[],
  ): Promise<Array<{ path: string; content: string | null }>> {
    return this.callGitApi(`/api/repo/read/${repoId}/files`, 'POST', { branch, paths }) as Promise<
      Array<{ path: string; content: string | null }>
    >;
  }

  async readFilesFromFolder(
    repoId: string,
    branch: string,
    folderPath: string,
    filenames: string[],
  ): Promise<Array<{ path: string; content: string | null }>> {
    return this.callGitApi(`/api/repo/read/${repoId}/files-from-folder`, 'POST', {
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
    let url = `/api/repo/read/${repoId}/files-paginated?branch=${branch}&folder=${encodeURIComponent(folder)}&limit=${limit}`;
    if (cursor) {
      url += `&cursor=${encodeURIComponent(cursor)}`;
    }
    return this.callGitApi(url, 'GET') as Promise<{
      files: Array<{ name: string; content: string }>;
      nextCursor?: string;
    }>;
  }

  async getStatus(repoId: string): Promise<any> {
    return this.callGitApi(`/api/repo/diff/${repoId}/status`, 'GET');
  }

  async getDiff(repoId: string, path: string): Promise<string> {
    return this.callGitApi(`/api/repo/read/${repoId}/diff?path=${encodeURIComponent(path)}`, 'GET') as Promise<string>;
  }

  async getFolderDiff(repoId: string, folder: string): Promise<Array<{ path: string; status: FileDiffStatus }>> {
    return this.callGitApi(
      `/api/repo/diff/${repoId}/folder-diff?folder=${encodeURIComponent(folder)}`,
      'GET',
    ) as Promise<Array<{ path: string; status: 'added' | 'modified' | 'deleted' }>>;
  }

  async getGraph(repoId: string): Promise<any> {
    return this.callGitApi(`/api/repo/debug/${repoId}/graph`, 'GET');
  }

  async createCheckpoint(repoId: string, name: string): Promise<void> {
    await this.callGitApi(`/api/repo/checkpoint/${repoId}`, 'POST', { name });
  }

  async listCheckpoints(repoId: string): Promise<{ name: string; timestamp: number; message: string }[]> {
    return this.callGitApi(`/api/repo/checkpoint/${repoId}`, 'GET') as Promise<
      { name: string; timestamp: number; message: string }[]
    >;
  }

  async revertToCheckpoint(repoId: string, name: string): Promise<void> {
    await this.callGitApi(`/api/repo/checkpoint/${repoId}/revert`, 'POST', { name });
  }

  async deleteCheckpoint(repoId: string, name: string): Promise<void> {
    await this.callGitApi(`/api/repo/checkpoint/${repoId}/${encodeURIComponent(name)}`, 'DELETE');
  }
}
