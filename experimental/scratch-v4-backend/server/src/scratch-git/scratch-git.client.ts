import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

export interface UpsertFilesOptions {
  repoPath: string;
  folder: string;
  message: string;
  files: Array<{ path: string; content: string }>;
}

export interface UpsertFilesResult {
  commitOid: string;
  filesWritten: number;
}

export interface RebaseDirtyResult {
  commitOid: string;
  advanced: boolean;
}

export type DiffStatus = 'added' | 'modified' | 'deleted';

export interface DiffEntry {
  path: string;
  status: DiffStatus;
}

export interface DiffResult {
  files: DiffEntry[];
}

export interface ReadFileEntry {
  path: string;
  content: string;
}

export interface ReadFilesResult {
  files: ReadFileEntry[];
}

@Injectable()
export class ScratchGitClient {
  private readonly http: AxiosInstance;
  private readonly logger = new Logger(ScratchGitClient.name);

  constructor(private readonly config: ConfigService) {
    const baseURL = config.getOrThrow('SCRATCHMD_URL');
    this.http = axios.create({ baseURL, timeout: 120_000 });
  }

  /**
   * Initialize a bare git repo at the given absolute path.
   * Calls POST /api/repos/init
   */
  async initRepo(repoPath: string): Promise<void> {
    this.logger.log(`initRepo: ${repoPath}`);
    await this.http.post('/api/repos/init', { path: repoPath });
  }

  /**
   * Upsert files into the master branch of a repo.
   * Calls POST /api/repos/upsert-files
   */
  async upsertFiles(opts: UpsertFilesOptions): Promise<UpsertFilesResult> {
    this.logger.debug(
      `upsertFiles: ${opts.repoPath} folder=${opts.folder} files=${opts.files.length}`,
    );
    const response = await this.http.post<UpsertFilesResult>('/api/repos/upsert-files', {
      repoPath: opts.repoPath,
      folder: opts.folder,
      message: opts.message,
      files: opts.files,
    });
    return response.data;
  }

  async rebaseDirty(repoPath: string): Promise<RebaseDirtyResult> {
    this.logger.debug(`rebaseDirty: ${repoPath}`);
    const response = await this.http.post<RebaseDirtyResult>('/api/repos/rebase-dirty', { repoPath });
    return response.data;
  }

  async diff(repoPath: string, baseBranch: string, headBranch: string): Promise<DiffResult> {
    this.logger.debug(`diff: ${repoPath} ${baseBranch}..${headBranch}`);
    const response = await this.http.post<DiffResult>('/api/repos/diff', { repoPath, baseBranch, headBranch });
    return response.data;
  }

  async readFiles(repoPath: string, branch: string, folderPath: string, fileNames: string[]): Promise<ReadFileEntry[]> {
    this.logger.debug(`readFiles: ${repoPath} ${branch}:${folderPath} (${fileNames.length} files)`);
    const response = await this.http.post<ReadFilesResult>('/api/repos/read-files', { repoPath, branch, folderPath, fileNames });
    return response.data.files;
  }
}
