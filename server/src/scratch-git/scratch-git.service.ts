import { Injectable } from '@nestjs/common';
import { FileDiffStatus, WorkbookId } from '@spinner/shared-types';
import { ScratchGitClient } from './scratch-git.client';

// The object returned by listRepoFiles
export interface RepoFileRef {
  name: string;
  path: string;
  type: 'file' | 'folder';
}

export const MAIN_BRANCH = 'main';
export const DIRTY_BRANCH = 'dirty';

@Injectable()
export class ScratchGitService {
  constructor(private readonly scratchGitClient: ScratchGitClient) {}

  async initRepo(workbookId: WorkbookId): Promise<void> {
    await this.scratchGitClient.initRepo(workbookId);
  }

  async deleteRepo(workbookId: WorkbookId): Promise<void> {
    await this.scratchGitClient.deleteRepo(workbookId);
  }

  async discardChanges(workbookId: WorkbookId, path?: string): Promise<void> {
    await this.scratchGitClient.resetRepo(workbookId, path);
  }

  async rebaseDirty(workbookId: WorkbookId) {
    await this.scratchGitClient.rebaseDirty(workbookId);
  }

  async commitFilesToBranch(
    workbookId: WorkbookId,
    branch: string,
    files: { path: string; content: string }[],
    message: string,
  ) {
    await this.commitFilesBatch(workbookId, branch, files, message);
  }

  private async commitFilesBatch(
    workbookId: WorkbookId,
    branch: string,
    files: { path: string; content: string }[],
    message: string,
  ) {
    const filesByDir = new Map<string, typeof files>();

    for (const file of files) {
      const dir = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : '.';
      if (!filesByDir.has(dir)) {
        filesByDir.set(dir, []);
      }
      filesByDir.get(dir)!.push(file);
    }

    const sortedDirs = Array.from(filesByDir.keys()).sort();

    for (const dir of sortedDirs) {
      const dirFiles = filesByDir.get(dir);
      if (dirFiles) {
        await this.scratchGitClient.commitFiles(workbookId, branch, dirFiles, message);
      }
    }
  }

  async listRepoFiles(workbookId: WorkbookId, branch: string, folder: string): Promise<any[]> {
    return this.scratchGitClient.list(workbookId, branch, folder);
  }

  async getRepoFile(workbookId: WorkbookId, branch: string, path: string): Promise<{ content: string } | null> {
    return this.scratchGitClient.getFile(workbookId, branch, path);
  }

  async getRepoFilesPaginated(
    workbookId: WorkbookId,
    branch: string,
    folder: string,
    limit: number,
    cursor?: string,
  ): Promise<{ files: Array<{ name: string; content: string }>; nextCursor?: string }> {
    return this.scratchGitClient.readFilesPaginated(workbookId, branch, folder, limit, cursor);
  }

  async readRepoFiles(
    workbookId: WorkbookId,
    branch: string,
    paths: string[],
  ): Promise<Array<{ path: string; content: string | null }>> {
    return this.scratchGitClient.readFiles(workbookId, branch, paths);
  }

  async readRepoFilesFromFolder(
    workbookId: WorkbookId,
    branch: string,
    folderPath: string,
    filenames: string[],
  ): Promise<Array<{ path: string; content: string | null }>> {
    return this.scratchGitClient.readFilesFromFolder(workbookId, branch, folderPath, filenames);
  }

  // Groups paths by their parent folder and calls readFilesFromFolder per group,
  // which uses a single optimized tree walk per folder instead of one per file.
  async readRepoFilesByFolder(
    workbookId: WorkbookId,
    branch: string,
    paths: string[],
  ): Promise<Array<{ path: string; content: string | null }>> {
    if (paths.length === 0) return [];

    const byFolder = new Map<string, string[]>();
    for (const p of paths) {
      const normalized = p.startsWith('/') ? p.slice(1) : p;
      const folder = normalized.includes('/') ? normalized.substring(0, normalized.lastIndexOf('/')) : '';
      const filename = normalized.includes('/') ? normalized.substring(normalized.lastIndexOf('/') + 1) : normalized;
      if (!byFolder.has(folder)) byFolder.set(folder, []);
      byFolder.get(folder)!.push(filename);
    }

    const groups = await Promise.all(
      Array.from(byFolder.entries()).map(([folder, filenames]) =>
        this.scratchGitClient.readFilesFromFolder(workbookId, branch, folder, filenames),
      ),
    );

    return groups.flat();
  }

  async readBlobsByOid(
    workbookId: WorkbookId,
    oids: string[],
  ): Promise<Array<{ oid: string; content: string | null }>> {
    return this.scratchGitClient.readBlobsByOid(workbookId, oids);
  }

  async commitFile(workbookId: WorkbookId, path: string, content: string, message: string): Promise<void> {
    await this.scratchGitClient.commitFiles(workbookId, 'dirty', [{ path, content }], message);
  }

  async deleteFile(workbookId: WorkbookId, paths: string[], message: string): Promise<void> {
    await this.deleteFilesFromBranch(workbookId, DIRTY_BRANCH, paths, message);
  }

  async deleteFilesFromBranch(workbookId: WorkbookId, branch: string, paths: string[], message: string): Promise<void> {
    await this.scratchGitClient.deleteFiles(workbookId, branch, paths, message);
  }

  async deleteFolder(workbookId: WorkbookId, folderPath: string, message: string, branch?: string): Promise<void> {
    await this.scratchGitClient.deleteFolder(workbookId, folderPath, message, branch);
  }

  async deleteFolderFromAllBranches(workbookId: WorkbookId, folderPath: string, message: string): Promise<void> {
    // Delete from both main and dirty branches to avoid orphaned files in git status
    await this.scratchGitClient.deleteFolder(workbookId, folderPath, message, MAIN_BRANCH);
    await this.scratchGitClient.deleteFolder(workbookId, folderPath, message, DIRTY_BRANCH);
  }

  async removeDataFolder(workbookId: WorkbookId, folderPath: string): Promise<void> {
    await this.scratchGitClient.removeDataFolder(workbookId, folderPath);
  }

  async publishFile(workbookId: WorkbookId, path: string, content: string, message: string): Promise<void> {
    await this.scratchGitClient.publishFile(workbookId, { path, content }, message);
  }

  async getRepoStatus(workbookId: WorkbookId): Promise<any> {
    return this.scratchGitClient.getStatus(workbookId);
  }

  async getFileDiff(workbookId: WorkbookId, path: string): Promise<any> {
    return this.scratchGitClient.getDiff(workbookId, path);
  }

  async getFolderDiff(
    workbookId: WorkbookId,
    folderPath: string,
  ): Promise<Array<{ path: string; status: FileDiffStatus }>> {
    return this.scratchGitClient.getFolderDiff(workbookId, folderPath);
  }

  async getGraph(workbookId: WorkbookId): Promise<any> {
    return this.scratchGitClient.getGraph(workbookId);
  }

  async createCheckpoint(workbookId: WorkbookId, name: string): Promise<void> {
    await this.scratchGitClient.createCheckpoint(workbookId, name);
  }

  async listCheckpoints(workbookId: WorkbookId): Promise<{ name: string; timestamp: number; message: string }[]> {
    return this.scratchGitClient.listCheckpoints(workbookId);
  }

  async revertToCheckpoint(workbookId: WorkbookId, name: string): Promise<void> {
    await this.scratchGitClient.revertToCheckpoint(workbookId, name);
  }

  async deleteCheckpoint(workbookId: WorkbookId, name: string): Promise<void> {
    await this.scratchGitClient.deleteCheckpoint(workbookId, name);
  }

  async deleteAllFilesInDataFolder(workbookId: WorkbookId, folderPath: string): Promise<void> {
    // Delete the folder from dirty branch only to ensure a diff is generated
    await this.deleteFolder(workbookId, folderPath, `Delete all records in ${folderPath}`, DIRTY_BRANCH);
  }
}
