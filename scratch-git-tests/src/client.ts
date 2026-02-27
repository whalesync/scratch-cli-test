import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATE_FILE = path.join(os.tmpdir(), 'scratch-git-tests-state.json');

function getBaseUrl(): string {
  if (process.env.SCRATCH_GIT_URL) {
    return process.env.SCRATCH_GIT_URL.replace(/\/$/, '');
  }
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  return `http://localhost:${state.port}`;
}

// ── Types ──────────────────────────────────────────────────────────────

export interface GitFile {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

export interface DirtyFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  oid?: string;
}

export interface FileInput {
  path: string;
  content: string;
}

export interface RenameInput {
  oldName: string;
  newName: string;
}

interface Envelope<T> {
  data: T;
  status: { gcInProgress: number | null };
}

// ── Client ─────────────────────────────────────────────────────────────

export class ScratchGitClient {
  private baseUrl: string;

  constructor() {
    this.baseUrl = getBaseUrl();
  }

  // ── Low-level ──

  private async request<T>(method: string, path: string, body?: unknown, rawResponse = false): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const opts: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(url, opts);

    if (rawResponse) {
      return res as unknown as T;
    }

    const json = (await res.json()) as Envelope<T> | T;

    // Unwrap envelope
    if (json && typeof json === 'object' && 'data' in json && 'status' in json) {
      const envelope = json as Envelope<T>;
      return envelope.data;
    }
    return json as T;
  }

  async rawRequest(method: string, path: string, body?: unknown): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const opts: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts);
  }

  // ── Health ──

  async health(): Promise<{ status: string }> {
    return this.request('GET', '/health');
  }

  // ── Manage ──

  async initRepo(id: string): Promise<{ success: true }> {
    return this.request('POST', `/api/repo/manage/${id}/init`, {});
  }

  async repoExists(id: string): Promise<{ repoId: string; repoPath: string; exists: boolean; hasHead: boolean }> {
    return this.request('GET', `/api/repo/manage/${id}/exists`);
  }

  async deleteRepo(id: string): Promise<{ success: true }> {
    return this.request('DELETE', `/api/repo/manage/${id}`, {});
  }

  async resetRepo(id: string, repoPath?: string): Promise<{ success: true }> {
    return this.request('POST', `/api/repo/manage/${id}/reset`, repoPath ? { path: repoPath } : {});
  }

  async countObjects(id: string): Promise<{ stats: string; gcInProgress: number | null }> {
    return this.request('GET', `/api/repo/manage/${id}/count-objects`);
  }

  async gc(id: string, aggressive?: boolean): Promise<{ success: true; statsBefore: string; statsAfter: string }> {
    return this.request('POST', `/api/repo/manage/${id}/gc`, aggressive ? { aggressive: true } : {});
  }

  // ── Read ──

  async listFiles(id: string, branch?: string, folder?: string): Promise<GitFile[]> {
    const params = new URLSearchParams();
    if (branch) params.set('branch', branch);
    if (folder) params.set('folder', folder);
    const qs = params.toString();
    return this.request('GET', `/api/repo/read/${id}/list${qs ? '?' + qs : ''}`);
  }

  async getFile(id: string, filePath: string, branch?: string): Promise<{ content: string }> {
    const params = new URLSearchParams({ path: filePath });
    if (branch) params.set('branch', branch);
    return this.request('GET', `/api/repo/read/${id}/file?${params}`);
  }

  async getFileRaw(id: string, filePath: string, branch?: string): Promise<Response> {
    const params = new URLSearchParams({ path: filePath });
    if (branch) params.set('branch', branch);
    return this.rawRequest('GET', `/api/repo/read/${id}/file?${params}`);
  }

  async getFileDiff(id: string, filePath: string): Promise<{ main: string | null; dirty: string | null } | null> {
    const params = new URLSearchParams({ path: filePath });
    return this.request('GET', `/api/repo/read/${id}/diff?${params}`);
  }

  async readFilesFromFolder(
    id: string,
    folderPath: string,
    filenames: string[],
    branch?: string,
  ): Promise<Array<{ path: string; content: string | null }>> {
    return this.request('POST', `/api/repo/read/${id}/files-from-folder`, {
      folderPath,
      filenames,
      ...(branch ? { branch } : {}),
    });
  }

  async readFiles(id: string, paths: string[], branch?: string): Promise<Array<{ path: string; content: string | null }>> {
    return this.request('POST', `/api/repo/read/${id}/files`, {
      paths,
      ...(branch ? { branch } : {}),
    });
  }

  async readFilesPaginated(
    id: string,
    opts: { branch?: string; folder?: string; limit?: number; cursor?: string },
  ): Promise<{ files: Array<{ name: string; content: string }>; nextCursor?: string }> {
    const params = new URLSearchParams();
    if (opts.branch) params.set('branch', opts.branch);
    if (opts.folder) params.set('folder', opts.folder);
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts.cursor) params.set('cursor', opts.cursor);
    const qs = params.toString();
    return this.request('GET', `/api/repo/read/${id}/files-paginated${qs ? '?' + qs : ''}`);
  }

  async readBlobsByOid(id: string, oids: string[]): Promise<Array<{ oid: string; content: string | null }>> {
    return this.request('POST', `/api/repo/read/${id}/blobs-by-oid`, { oids });
  }

  async getArchive(id: string, branch?: string): Promise<Response> {
    const params = new URLSearchParams();
    if (branch) params.set('branch', branch);
    const qs = params.toString();
    return this.rawRequest('GET', `/api/repo/read/${id}/archive${qs ? '?' + qs : ''}`);
  }

  // ── Write ──

  async commitFiles(
    id: string,
    files: FileInput[],
    message?: string,
    branch?: string,
  ): Promise<{ success: true }> {
    const params = new URLSearchParams();
    if (branch) params.set('branch', branch);
    const qs = params.toString();
    return this.request('POST', `/api/repo/write/${id}/files${qs ? '?' + qs : ''}`, {
      files,
      ...(message ? { message } : {}),
    });
  }

  async deleteFiles(
    id: string,
    files: string[],
    message?: string,
    branch?: string,
  ): Promise<{ success: true }> {
    const params = new URLSearchParams();
    if (branch) params.set('branch', branch);
    const qs = params.toString();
    return this.request('DELETE', `/api/repo/write/${id}/files${qs ? '?' + qs : ''}`, {
      files,
      ...(message ? { message } : {}),
    });
  }

  async deleteFolder(
    id: string,
    folder: string,
    branch?: string,
    message?: string,
  ): Promise<{ success: true }> {
    const params = new URLSearchParams({ folder });
    if (branch) params.set('branch', branch);
    const qs = params.toString();
    return this.request('DELETE', `/api/repo/write/${id}/folder?${qs}`, message ? { message } : {});
  }

  async deleteDataFolder(id: string, folderPath: string): Promise<{ success: true }> {
    return this.request('DELETE', `/api/repo/write/${id}/data-folder`, { path: folderPath });
  }

  async publishFile(id: string, fileInput: FileInput, message?: string): Promise<{ success: true }> {
    return this.request('POST', `/api/repo/write/${id}/publish`, {
      file: fileInput,
      ...(message ? { message } : {}),
    });
  }

  async discardChanges(id: string, filePath: string): Promise<{ success: true }> {
    return this.request('POST', `/api/repo/write/${id}/discard-changes`, { path: filePath });
  }

  async rebase(id: string, strategy?: string): Promise<{ rebased: boolean; conflicts: string[] }> {
    return this.request('POST', `/api/repo/write/${id}/rebase`, strategy ? { strategy } : {});
  }

  async renameFiles(
    id: string,
    folderPath: string,
    renames: RenameInput[],
    message?: string,
  ): Promise<{ success: true }> {
    return this.request('POST', `/api/repo/write/${id}/rename`, {
      folderPath,
      renames,
      ...(message ? { message } : {}),
    });
  }

  // ── Diff ──

  async getDirtyStatus(id: string): Promise<DirtyFile[]> {
    return this.request('GET', `/api/repo/diff/${id}/status`);
  }

  async hasDirtyFiles(id: string): Promise<{ dirty: boolean }> {
    return this.request('GET', `/api/repo/diff/${id}/status/has-dirty`);
  }

  async getDirtyStatusCount(id: string): Promise<{ count: number }> {
    return this.request('GET', `/api/repo/diff/${id}/status/count`);
  }

  async getFolderDiff(id: string, folder: string): Promise<DirtyFile[]> {
    const params = new URLSearchParams({ folder });
    return this.request('GET', `/api/repo/diff/${id}/folder-diff?${params}`);
  }

  // ── Checkpoint ──

  async createCheckpoint(id: string, name: string): Promise<{ success: true }> {
    return this.request('POST', `/api/repo/checkpoint/${id}`, { name });
  }

  async listCheckpoints(id: string): Promise<Array<{ name: string; timestamp: number; message: string }>> {
    return this.request('GET', `/api/repo/checkpoint/${id}`);
  }

  async revertToCheckpoint(id: string, name: string): Promise<{ success: true }> {
    return this.request('POST', `/api/repo/checkpoint/${id}/revert`, { name });
  }

  async deleteCheckpoint(id: string, name: string): Promise<{ success: true }> {
    return this.request('DELETE', `/api/repo/checkpoint/${id}/${name}`);
  }

  // ── Debug ──

  async getGraph(id: string): Promise<{
    commits: Array<{
      oid: string;
      message: string;
      parents: string[];
      timestamp: number;
      author: { name: string; email: string };
    }>;
    refs: Array<{ name: string; oid: string; type: 'branch' | 'tag' }>;
  }> {
    return this.request('GET', `/api/repo/debug/${id}/graph`);
  }
}
