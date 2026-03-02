import { DIRTY_BRANCH, MAIN_BRANCH } from 'src/scratch-git/scratch-git.service';

type BranchFiles = Map<string, string>; // path → content

/**
 * In-memory git filesystem used in place of the real ScratchGitService.
 * Tracks files committed to each branch.
 */
export class VirtualGitFs {
  private readonly branches = new Map<string, BranchFiles>();

  constructor() {
    this.branches.set(MAIN_BRANCH, new Map());
    this.branches.set(DIRTY_BRANCH, new Map());
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

  /** Diff dirty vs main → list of changes */
  getStatus(): { path: string; status: 'added' | 'modified' | 'deleted' }[] {
    const main = this.getBranch(MAIN_BRANCH);
    const dirty = this.getBranch(DIRTY_BRANCH);
    const result: { path: string; status: 'added' | 'modified' | 'deleted' }[] = [];

    for (const [path, content] of dirty) {
      if (!main.has(path)) {
        result.push({ path, status: 'added' });
      } else if (main.get(path) !== content) {
        result.push({ path, status: 'modified' });
      }
    }
    for (const path of main.keys()) {
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

  /** Copy main onto dirty (simulates a rebase) */
  rebaseDirty(): void {
    const main = this.getBranch(MAIN_BRANCH);
    this.branches.set(DIRTY_BRANCH, new Map(main));
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
