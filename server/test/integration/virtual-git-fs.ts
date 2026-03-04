import { DIRTY_BRANCH, MAIN_BRANCH } from 'src/scratch-git/scratch-git.service';

type BranchFiles = Map<string, string>; // path → content

const MERGE_BASE = 'merge_base';

/**
 * In-memory git filesystem used in place of the real ScratchGitService.
 * Tracks files committed to each branch and a merge_base snapshot.
 *
 * Semantics mirror the real Rust microservice:
 *   - merge_base: the state of main at the last rebase
 *   - dirty: user edits applied on top of merge_base
 *   - getStatus(): diff(merge_base, dirty) — only user edits
 *   - rebaseDirty(): advance dirty and merge_base to main, preserving user edits
 */
export class VirtualGitFs {
  private readonly branches = new Map<string, BranchFiles>();

  constructor() {
    this.branches.set(MAIN_BRANCH, new Map());
    this.branches.set(DIRTY_BRANCH, new Map());
    this.branches.set(MERGE_BASE, new Map());
  }

  /** Seed a branch with files without triggering a "commit" */
  seed(branch: string, files: { path: string; content: string }[]): void {
    const b = this.getBranch(branch);
    for (const f of files) b.set(f.path, f.content);
  }

  commitFiles(branch: string, files: { path: string; content: string }[]): void {
    const b = this.getBranch(branch);
    for (const f of files) b.set(f.path, f.content);
  }

  deleteFiles(branch: string, paths: string[]): void {
    const b = this.getBranch(branch);
    for (const p of paths) b.delete(p);
  }

  /** Diff merge_base vs dirty → list of user changes */
  getStatus(): { path: string; status: 'added' | 'modified' | 'deleted' }[] {
    const base = this.getBranch(MERGE_BASE);
    const dirty = this.getBranch(DIRTY_BRANCH);
    const result: { path: string; status: 'added' | 'modified' | 'deleted' }[] = [];

    for (const [path, content] of dirty) {
      if (!base.has(path)) {
        result.push({ path, status: 'added' });
      } else if (base.get(path) !== content) {
        result.push({ path, status: 'modified' });
      }
    }
    for (const path of base.keys()) {
      if (!dirty.has(path)) {
        result.push({ path, status: 'deleted' });
      }
    }
    return result;
  }

  readFiles(branch: string, paths: string[]): { path: string; content: string | null }[] {
    const b = this.getBranch(branch);
    return paths.map((p) => ({ path: p, content: b.get(p) ?? null }));
  }

  /**
   * Rebase dirty onto main, preserving user edits.
   * 1. Compute user changes = diff(merge_base, dirty)
   * 2. Advance dirty to main
   * 3. Re-apply user changes on top
   * 4. Advance merge_base to main
   */
  rebaseDirty(): void {
    const main = this.getBranch(MAIN_BRANCH);
    const base = this.getBranch(MERGE_BASE);
    const dirty = this.getBranch(DIRTY_BRANCH);

    // Collect user edits relative to merge_base
    const userAdded = new Map<string, string>();
    const userModified = new Map<string, string>();
    const userDeleted = new Set<string>();

    for (const [path, content] of dirty) {
      if (!base.has(path)) {
        userAdded.set(path, content);
      } else if (base.get(path) !== content) {
        userModified.set(path, content);
      }
    }
    for (const path of base.keys()) {
      if (!dirty.has(path)) {
        userDeleted.add(path);
      }
    }

    // Advance dirty to main
    const newDirty = new Map(main);

    // Re-apply user edits
    for (const [path, content] of userAdded) newDirty.set(path, content);
    for (const [path, content] of userModified) newDirty.set(path, content);
    for (const path of userDeleted) newDirty.delete(path);

    this.branches.set(DIRTY_BRANCH, newDirty);
    // Advance merge_base to main
    this.branches.set(MERGE_BASE, new Map(main));
  }

  getAllFiles(branch: string): Map<string, string> {
    return new Map(this.getBranch(branch));
  }

  /** Return files on a branch whose paths start with a given folder prefix. */
  getFilesByFolder(branch: string, folderPrefix: string): { path: string; content: string }[] {
    const b = this.getBranch(branch);
    const prefix = folderPrefix.endsWith('/') ? folderPrefix : `${folderPrefix}/`;
    const result: { path: string; content: string }[] = [];
    for (const [path, content] of b) {
      if (path.startsWith(prefix)) result.push({ path, content });
    }
    return result;
  }

  /** Return file metadata for paths under a folder prefix (compatible with ScratchGitService.listRepoFiles) */
  listFiles(branch: string, folderPrefix: string): { path: string; name: string; type: 'file' | 'folder' }[] {
    return this.getFilesByFolder(branch, folderPrefix).map(({ path }) => ({
      path,
      name: path.split('/').pop()!,
      type: 'file' as const,
    }));
  }

  private getBranch(branch: string): BranchFiles {
    if (!this.branches.has(branch)) {
      this.branches.set(branch, new Map());
    }
    return this.branches.get(branch)!;
  }
}
