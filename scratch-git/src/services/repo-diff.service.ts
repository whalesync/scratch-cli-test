import git from 'isomorphic-git';
import fs from 'node:fs';
import { DIRTY_BRANCH, MAIN_BRANCH } from '../../lib/constants';
import { DirtyFile } from '../../lib/types';
import { BaseRepoService } from './base-repo.service';

export class RepoDiffService extends BaseRepoService {
  async getDirtyStatus(): Promise<DirtyFile[]> {
    try {
      const [mainCommit, dirtyCommit] = await Promise.all([
        this.resolveRef(MAIN_BRANCH),
        this.resolveRef(DIRTY_BRANCH),
      ]);
      if (mainCommit === dirtyCommit) return [];
      return this.compareCommits(mainCommit, dirtyCommit);
    } catch {
      return [];
    }
  }

  async hasDirtyFiles(): Promise<boolean> {
    try {
      const [mainCommit, dirtyCommit] = await Promise.all([
        this.resolveRef(MAIN_BRANCH),
        this.resolveRef(DIRTY_BRANCH),
      ]);
      if (mainCommit === dirtyCommit) return false;
      const dir = this.getRepoPath();
      const [mainObj, dirtyObj] = await Promise.all([
        git.readCommit({ fs, dir, gitdir: dir, oid: mainCommit }),
        git.readCommit({ fs, dir, gitdir: dir, oid: dirtyCommit }),
      ]);
      return mainObj.commit.tree !== dirtyObj.commit.tree;
    } catch {
      return false;
    }
  }

  async getDirtyStatusCount(): Promise<number> {
    try {
      const [mainCommit, dirtyCommit] = await Promise.all([
        this.resolveRef(MAIN_BRANCH),
        this.resolveRef(DIRTY_BRANCH),
      ]);
      if (mainCommit === dirtyCommit) return 0;
      const changes = await this.compareCommits(mainCommit, dirtyCommit);
      return changes.length;
    } catch {
      return 0;
    }
  }

  async getFolderDirtyStatus(folderPath: string): Promise<DirtyFile[]> {
    const folder = folderPath.startsWith('/') ? folderPath.slice(1) : folderPath;
    try {
      const [mainCommit, dirtyCommit] = await Promise.all([
        this.resolveRef(MAIN_BRANCH),
        this.resolveRef(DIRTY_BRANCH),
      ]);
      if (mainCommit === dirtyCommit) return [];
      const allChanges = await this.compareCommits(mainCommit, dirtyCommit);
      const prefix = folder.endsWith('/') ? folder : folder + '/';
      return allChanges.filter((f) => f.path.startsWith(prefix));
    } catch {
      return [];
    }
  }
}
