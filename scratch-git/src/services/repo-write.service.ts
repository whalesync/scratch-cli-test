import git from 'isomorphic-git';
import { diff3Merge } from 'node-diff3';
import fs from 'node:fs';
import { DIRTY_BRANCH, MAIN_BRANCH } from '../../lib/constants';
import { FileChange, TreeEntry } from '../../lib/types';
import { BaseRepoService } from './base-repo.service';
import { withWriteLock } from './git-lock';

const DEFAULT_AUTHOR = { name: 'Scratch', email: 'scratch@example.com' };

export class RepoWriteService extends BaseRepoService {
  constructor(repoId: string) {
    super(repoId);
  }

  async commitFiles(branch: string, files: Array<{ path: string; content: string }>, message: string): Promise<void> {
    return withWriteLock(this.repoId, branch, async () => {
      const changes: FileChange[] = files.map((f) => ({
        path: f.path.startsWith('/') ? f.path.slice(1) : f.path,
        content: f.content,
        type: 'modify',
      }));
      await this.commitChangesToRef(branch, changes, message);
    });
  }

  async deleteFiles(branch: string, filePaths: string[], message: string): Promise<void> {
    return withWriteLock(this.repoId, branch, async () => {
      const changes: FileChange[] = filePaths.map((p) => ({
        path: p.startsWith('/') ? p.slice(1) : p,
        type: 'delete',
      }));
      await this.commitChangesToRef(branch, changes, message);
    });
  }

  async deleteFolder(folderPath: string, message: string, branch: string = DIRTY_BRANCH): Promise<void> {
    const targetFolder = folderPath.startsWith('/') ? folderPath.slice(1) : folderPath;
    return withWriteLock(this.repoId, branch, async () => {
      const changes: FileChange[] = [
        {
          path: targetFolder,
          type: 'delete',
        },
      ];
      await this.commitChangesToRef(branch, changes, message);
    });
  }

  async removeDataFolder(folderPath: string): Promise<void> {
    const targetFolder = folderPath.startsWith('/') ? folderPath.slice(1) : folderPath;
    const message = `Remove data folder ${targetFolder}`;
    console.log(`[RepoWriteService] Removing data folder: ${targetFolder} from repo ${this.repoId}`);

    await withWriteLock(this.repoId, MAIN_BRANCH, async () => {
      const changes: FileChange[] = [{ path: targetFolder, type: 'delete' }];
      await this.commitChangesToRef(MAIN_BRANCH, changes, message);
    });

    await withWriteLock(this.repoId, DIRTY_BRANCH, async () => {
      const changes: FileChange[] = [{ path: targetFolder, type: 'delete' }];
      await this.commitChangesToRef(DIRTY_BRANCH, changes, message);
    });

    console.log(`[RepoWriteService] Rebasing dirty after removal of ${targetFolder}`);
    await this.rebaseDirty();
  }

  async renameFiles(
    folderPath: string,
    renames: { oldName: string; newName: string }[],
    message: string,
  ): Promise<void> {
    const dir = this.getRepoPath();
    const commitOid = await this.resolveRef(DIRTY_BRANCH);

    try {
      const { commit } = await git.readCommit({ fs, dir, gitdir: dir, oid: commitOid });
      let currentOid = commit.tree;

      const normalizedFolder = folderPath.startsWith('/') ? folderPath.slice(1) : folderPath;
      const cleanFolder = normalizedFolder.endsWith('/') ? normalizedFolder.slice(0, -1) : normalizedFolder;

      if (cleanFolder) {
        const parts = cleanFolder.split('/');
        for (const part of parts) {
          const { tree } = await git.readTree({ fs, dir, gitdir: dir, oid: currentOid });
          const entry = tree.find((e) => e.path === part);
          if (!entry) throw new Error(`Folder ${part} not found`);
          currentOid = entry.oid;
        }
      }

      const { tree: folderTree } = await git.readTree({ fs, dir, gitdir: dir, oid: currentOid });
      const changesForDirty: FileChange[] = [];

      // Pre-calculate MAIN branch tree for the same folder to see what actually exists in MAIN
      const mainCommitOid = await this.resolveRef(MAIN_BRANCH);
      const { commit: mainCommitVal } = await git.readCommit({ fs, dir, gitdir: dir, oid: mainCommitOid });
      let mainCurrentOid = mainCommitVal.tree;
      let mainFolderTree: { path: string; oid: string }[] = [];

      try {
        if (cleanFolder) {
          const parts = cleanFolder.split('/');
          for (const part of parts) {
            const { tree } = await git.readTree({ fs, dir, gitdir: dir, oid: mainCurrentOid });
            const entry = tree.find((e) => e.path === part);
            if (!entry) throw new Error('Not found');
            mainCurrentOid = entry.oid;
          }
        }
        const { tree } = await git.readTree({ fs, dir, gitdir: dir, oid: mainCurrentOid });
        mainFolderTree = tree.map((e) => ({ path: e.path, oid: e.oid }));
      } catch {
        // It's possible the folder doesn't exist in MAIN at all yet.
        mainFolderTree = [];
      }

      const changesForMain: FileChange[] = [];

      for (const rename of renames) {
        const entryInDirty = folderTree.find((e) => e.path === rename.oldName);
        if (!entryInDirty) throw new Error(`File ${rename.oldName} not found in ${cleanFolder}`);

        const oldFilePath = cleanFolder ? `${cleanFolder}/${rename.oldName}` : rename.oldName;
        const newFilePath = cleanFolder ? `${cleanFolder}/${rename.newName}` : rename.newName;

        // Always apply to dirty
        changesForDirty.push({ path: oldFilePath, type: 'delete' });
        changesForDirty.push({ path: newFilePath, type: 'add', oid: entryInDirty.oid });

        // Only apply to main if it actually existed in main prior to this rename
        const entryInMain = mainFolderTree.find((e) => e.path === rename.oldName);
        if (entryInMain) {
          changesForMain.push({ path: oldFilePath, type: 'delete' });
          changesForMain.push({ path: newFilePath, type: 'add', oid: entryInMain.oid });
        }
      }

      // Apply to MAIN branch
      let newMainCommitOid: string = mainCommitOid;
      await withWriteLock(this.repoId, MAIN_BRANCH, async () => {
        if (changesForMain.length > 0) {
          const { tree: mainTree } = await git.readTree({ fs, dir, gitdir: dir, oid: mainCommitVal.tree });
          const newMainTreeOid = await this.applyChangesToTree(dir, mainTree, changesForMain);
          newMainCommitOid = await git.writeCommit({
            fs,
            dir,
            gitdir: dir,
            commit: {
              tree: newMainTreeOid,
              parent: [mainCommitOid],
              author: { ...DEFAULT_AUTHOR, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 },
              committer: { ...DEFAULT_AUTHOR, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 },
              message,
            },
          });
          await this.forceRef(MAIN_BRANCH, newMainCommitOid);
        }
      });

      // Apply to DIRTY branch with an efficient squashed rebase on top of MAIN
      await withWriteLock(this.repoId, DIRTY_BRANCH, async () => {
        const dirtyCommitOid = await this.resolveRef(DIRTY_BRANCH);
        const { commit: dirtyCommitVal } = await git.readCommit({ fs, dir, gitdir: dir, oid: dirtyCommitOid });
        const { tree: dirtyTree } = await git.readTree({ fs, dir, gitdir: dir, oid: dirtyCommitVal.tree });

        const newDirtyTreeOid = await this.applyChangesToTree(dir, dirtyTree, changesForDirty);

        // If the resulting DIRTY tree matches the new MAIN tree exactly (meaning there were no other uncommitted changes),
        // we can do a strict fast-forward pointer update to the same commit.
        const mainCommitVal2 = await git.readCommit({ fs, dir, gitdir: dir, oid: newMainCommitOid });

        if (newDirtyTreeOid === mainCommitVal2.commit.tree) {
          await this.forceRef(DIRTY_BRANCH, newMainCommitOid);
        } else {
          // Create a squashed commit that keeps all other uncommitted changes but rebases the parent
          // cleanly on top of the new MAIN commit we just generated without needing a slow 3-way merge
          const newDirtyCommitOid = await git.writeCommit({
            fs,
            dir,
            gitdir: dir,
            commit: {
              tree: newDirtyTreeOid,
              parent: [newMainCommitOid],
              author: { ...DEFAULT_AUTHOR, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 },
              committer: { ...DEFAULT_AUTHOR, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 },
              message: 'Uncommitted changes after rename',
            },
          });
          await this.forceRef(DIRTY_BRANCH, newDirtyCommitOid);
        }
      });
    } catch (e) {
      throw new Error(`Cannot rename files: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async publishFile(file: { path: string; content: string }, message: string): Promise<void> {
    await this.commitFiles(MAIN_BRANCH, [file], message);
    await this.rebaseDirty();
  }

  async discardChanges(
    path: string,
    changes: Array<{ path: string; status: 'added' | 'modified' | 'deleted' }>,
  ): Promise<void> {
    const normalizedTarget = path.startsWith('/') ? path.slice(1) : path;

    const changesToDiscard = changes.filter(
      (change) => change.path === normalizedTarget || change.path.startsWith(normalizedTarget + '/'),
    );

    if (changesToDiscard.length === 0) return;

    return withWriteLock(this.repoId, DIRTY_BRANCH, async () => {
      const revertChanges: FileChange[] = [];

      for (const change of changesToDiscard) {
        if (change.status === 'added') {
          revertChanges.push({ path: change.path, type: 'delete' });
        } else {
          const mainContent = await this.getFileContent(MAIN_BRANCH, change.path);
          if (mainContent !== null) {
            revertChanges.push({
              path: change.path,
              content: mainContent,
              type: 'modify',
            });
          }
        }
      }

      if (revertChanges.length > 0) {
        await this.commitChangesToRef(DIRTY_BRANCH, revertChanges, `Discard changes to ${normalizedTarget}`);
      }
    });
  }

  async rebaseDirty(strategy: 'ours' | 'diff3' = 'diff3'): Promise<{ rebased: boolean; conflicts: string[] }> {
    const dir = this.getRepoPath();

    // Ensure dirty exists
    try {
      await this.resolveRef(DIRTY_BRANCH);
    } catch {
      const mainOid = await this.resolveRef(MAIN_BRANCH);
      await git.branch({
        fs,
        dir,
        gitdir: dir,
        ref: DIRTY_BRANCH,
        object: mainOid,
        checkout: false,
      });
      return { rebased: true, conflicts: [] };
    }

    const [mainCommit, dirtyCommit] = await Promise.all([this.resolveRef(MAIN_BRANCH), this.resolveRef(DIRTY_BRANCH)]);

    if (mainCommit === dirtyCommit) {
      return { rebased: true, conflicts: [] };
    }

    const mergeBaseOids = await git.findMergeBase({
      fs,
      dir,
      gitdir: dir,
      oids: [mainCommit, dirtyCommit],
    });
    if (mergeBaseOids.length === 0) {
      await this.forceRef(DIRTY_BRANCH, mainCommit);
      return { rebased: true, conflicts: [] };
    }
    const mergeBase = mergeBaseOids[0] as string;

    const userChanges = await this.compareCommits(mergeBase, dirtyCommit);

    if (userChanges.length === 0) {
      await this.forceRef(DIRTY_BRANCH, mainCommit);
      return { rebased: true, conflicts: [] };
    }

    const edits: Array<{
      path: string;
      status: 'deleted' | 'added' | 'modified';
      content: string | null;
      baseContent: string | null;
    }> = [];

    const BATCH_SIZE = 50;
    for (let i = 0; i < userChanges.length; i += BATCH_SIZE) {
      const batch = userChanges.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (change) => {
          if (change.status === 'deleted') {
            return {
              path: change.path,
              status: 'deleted' as const,
              content: null,
              baseContent: null,
            };
          }
          const content = await this.getFileContent(DIRTY_BRANCH, change.path);
          let baseContent: string | null = null;
          if (strategy === 'diff3' && change.status === 'modified') {
            try {
              const { blob } = await git.readBlob({
                fs,
                dir,
                gitdir: dir,
                oid: mergeBase,
                filepath: change.path,
              });
              baseContent = new TextDecoder().decode(blob);
            } catch {
              // ignore
            }
          }
          return {
            path: change.path,
            status: change.status,
            content,
            baseContent,
          };
        }),
      );
      edits.push(...batchResults);
    }

    await this.forceRef(DIRTY_BRANCH, mainCommit);

    const conflicts: string[] = [];
    const changesToCommit: FileChange[] = [];

    const mainTreeFiles = await this.getTreeFiles(dir, mainCommit);

    for (const edit of edits) {
      if (edit.status === 'deleted') {
        const existsOnMain = mainTreeFiles.has(edit.path);
        if (existsOnMain) changesToCommit.push({ path: edit.path, type: 'delete' });
      } else if (edit.content !== null) {
        const mainContent = await this.getFileContent(MAIN_BRANCH, edit.path);

        let finalContent = edit.content;

        if (strategy === 'diff3' && edit.status === 'modified') {
          if (edit.baseContent !== null && mainContent !== null && edit.baseContent !== mainContent) {
            finalContent = this.mergeFileContents(edit.baseContent, edit.content, mainContent);
          }
        }

        if (mainContent !== finalContent) {
          changesToCommit.push({
            path: edit.path,
            content: finalContent,
            type: 'modify',
          });
        }
      }
    }

    if (changesToCommit.length > 0) {
      await this.commitChangesToRef(DIRTY_BRANCH, changesToCommit, 'Rebase dirty on main');
    }

    return { rebased: true, conflicts };
  }

  // --- Private Helpers ---

  private async commitChangesToRef(ref: string, changes: FileChange[], message: string) {
    const dir = this.getRepoPath();
    const parentCommit = await this.resolveRef(ref);
    const { tree: currentTree } = await git.readTree({
      fs,
      dir,
      gitdir: dir,
      oid: parentCommit,
    });

    const newTreeOid = await this.applyChangesToTree(dir, currentTree, changes);
    const newCommit = await git.writeCommit({
      fs,
      dir,
      gitdir: dir,
      commit: {
        tree: newTreeOid,
        parent: [parentCommit],
        author: {
          ...DEFAULT_AUTHOR,
          timestamp: Math.floor(Date.now() / 1000),
          timezoneOffset: 0,
        },
        committer: {
          ...DEFAULT_AUTHOR,
          timestamp: Math.floor(Date.now() / 1000),
          timezoneOffset: 0,
        },
        message,
      },
    });
    await this.forceRef(ref, newCommit);
  }

  private async applyChangesToTree(
    dir: string,
    currentEntries: TreeEntry[],
    changes: FileChange[],
    prefix = '',
  ): Promise<string> {
    const directChangesMap: Map<string, FileChange> = new Map();
    const subtreeChanges: Map<string, FileChange[]> = new Map();

    for (const change of changes) {
      const relativePath = prefix ? change.path.slice(prefix.length + 1) : change.path;
      const slashIndex = relativePath.indexOf('/');
      if (slashIndex === -1) {
        directChangesMap.set(relativePath, { ...change, path: relativePath });
      } else {
        const subtreeName = relativePath.slice(0, slashIndex);
        const existing = subtreeChanges.get(subtreeName) || [];
        existing.push(change);
        subtreeChanges.set(subtreeName, existing);
      }
    }

    const currentEntryPaths = new Set(currentEntries.map((e) => e.path));

    const newEntries: TreeEntry[] = [];
    for (const entry of currentEntries) {
      const direct = directChangesMap.get(entry.path);
      const subtree = subtreeChanges.get(entry.path);

      if (direct) {
        if (direct.type === 'delete') continue;
        const newBlob =
          direct.oid ||
          (await git.writeBlob({
            fs,
            dir,
            gitdir: dir,
            blob: Buffer.from(direct.content || ''),
          }));
        newEntries.push({
          mode: '100644',
          path: entry.path,
          oid: newBlob,
          type: 'blob',
        });
      } else if (subtree && entry.type === 'tree') {
        const { tree } = await git.readTree({
          fs,
          dir,
          gitdir: dir,
          oid: entry.oid,
        });
        const newSubtreeOid = await this.applyChangesToTree(
          dir,
          tree as unknown as TreeEntry[],
          subtree,
          prefix ? `${prefix}/${entry.path}` : entry.path,
        );
        newEntries.push({
          mode: entry.mode,
          path: entry.path,
          oid: newSubtreeOid,
          type: 'tree',
        });
        subtreeChanges.delete(entry.path);
      } else {
        newEntries.push(entry);
      }
    }

    for (const [path, change] of directChangesMap) {
      if ((change.type === 'add' || change.type === 'modify') && !currentEntryPaths.has(path)) {
        const newBlob =
          change.oid ||
          (await git.writeBlob({
            fs,
            dir,
            gitdir: dir,
            blob: Buffer.from(change.content || ''),
          }));
        newEntries.push({
          mode: '100644',
          path: change.path,
          oid: newBlob,
          type: 'blob',
        });
      }
    }

    for (const [name, subChanges] of subtreeChanges) {
      if (!currentEntryPaths.has(name)) {
        const newSubtreeOid = await this.applyChangesToTree(dir, [], subChanges, prefix ? `${prefix}/${name}` : name);
        newEntries.push({
          mode: '040000',
          path: name,
          oid: newSubtreeOid,
          type: 'tree',
        });
      }
    }

    newEntries.sort((a, b) => {
      const aName = a.type === 'tree' ? `${a.path}/` : a.path;
      const bName = b.type === 'tree' ? `${b.path}/` : b.path;
      return aName.localeCompare(bName);
    });

    return git.writeTree({ fs, dir, gitdir: dir, tree: newEntries });
  }

  private mergeFileContents(base: string, ours: string, theirs: string): string {
    if (ours === base) return theirs;
    if (theirs === base) return ours;
    if (ours === theirs) return ours;

    const baseLines = base.split('\n');
    const oursLines = ours.split('\n');
    const theirsLines = theirs.split('\n');

    const result = diff3Merge(oursLines, baseLines, theirsLines);

    const mergedLines: string[] = [];
    for (const region of result) {
      if (region.ok) {
        mergedLines.push(...region.ok);
      } else if (region.conflict) {
        mergedLines.push(...region.conflict.a);
      }
    }
    return mergedLines.join('\n');
  }
}
