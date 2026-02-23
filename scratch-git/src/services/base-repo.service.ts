/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import git from 'isomorphic-git';
import fs from 'node:fs';
import path from 'node:path';
import { DirtyFile } from '../../lib/types';

const REPOS_BASE_DIR = process.env.GIT_REPOS_DIR || 'repos';

export class BaseRepoService {
  constructor(protected readonly repoId: string) {}

  public getRepoPath(): string {
    if (path.isAbsolute(REPOS_BASE_DIR)) {
      return path.join(REPOS_BASE_DIR, `${this.repoId}.git`);
    }
    return path.join(process.cwd(), REPOS_BASE_DIR, `${this.repoId}.git`);
  }

  protected async resolveRef(ref: string): Promise<string> {
    const dir = this.getRepoPath();
    // Sometimes isomorphic-git fails to resolve short refs like 'dirty' (possibly due to packed-refs or ambiguity).
    // If resolution fails, we attempt to resolve the full ref 'refs/heads/dirty'.
    try {
      return await git.resolveRef({ fs, dir, gitdir: dir, ref });
    } catch {
      return await git.resolveRef({ fs, dir, gitdir: dir, ref: `refs/heads/${ref}` });
    }
  }

  protected async forceRef(ref: string, oid: string): Promise<void> {
    const dir = this.getRepoPath();
    await git.writeRef({
      fs,
      dir,
      gitdir: dir,
      ref: `refs/heads/${ref}`,
      value: oid,
      force: true,
    });
  }

  public async compareCommits(oidA: string, oidB: string): Promise<DirtyFile[]> {
    const dir = this.getRepoPath();
    const filesA = await this.getTreeFiles(dir, oidA);
    const filesB = await this.getTreeFiles(dir, oidB);
    const dirty: DirtyFile[] = [];

    for (const [path, oid] of filesB) {
      const hashA = filesA.get(path);
      if (!hashA) dirty.push({ path, status: 'added', oid });
      else if (hashA !== oid) dirty.push({ path, status: 'modified', oid });
    }
    for (const [path] of filesA) {
      if (!filesB.has(path)) dirty.push({ path, status: 'deleted' });
    }
    return dirty;
  }

  protected async getTreeFiles(dir: string, commitOid: string): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    await git.walk({
      fs,
      dir,
      gitdir: dir,
      trees: [git.TREE({ ref: commitOid })],
      map: async (filepath, [entry]) => {
        if (entry && (await entry.type()) === 'blob') {
          if (!filepath.split('/').some((p) => p.startsWith('.'))) files.set(filepath, await entry.oid());
        }
        return entry && (await entry.type()) === 'tree' ? true : undefined;
      },
    });
    return files;
  }

  public async getFileContent(branch: string, filePath: string): Promise<string | null> {
    const dir = this.getRepoPath();
    if (filePath.startsWith('/')) {
      filePath = filePath.slice(1);
    }
    try {
      const commitOid = await this.resolveRef(branch);
      const { blob } = await git.readBlob({
        fs,
        dir,
        gitdir: dir,
        oid: commitOid,
        filepath: filePath,
      });
      return new TextDecoder().decode(blob);
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      if (err && (err as any).code !== 'NotFoundError' && (err as any).name !== 'NotFoundError') {
        console.error(`Error getting file content for ${filePath} on branch ${branch}:`, err);
      }
      return null;
    }
  }

  public async fileExists(branch: string, filePath: string): Promise<boolean> {
    return (await this.getFileContent(branch, filePath)) !== null;
  }
}
