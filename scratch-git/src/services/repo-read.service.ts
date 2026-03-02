import archiver from 'archiver';
import git from 'isomorphic-git';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { DIRTY_BRANCH, MAIN_BRANCH } from '../../lib/constants';
import { GitFile } from '../../lib/types';
import { BaseRepoService } from './base-repo.service';

export class RepoReadService extends BaseRepoService {
  async list(branch: string, folderPath: string): Promise<GitFile[]> {
    const dir = this.getRepoPath();
    try {
      const commitOid = await this.resolveRef(branch);
      const files: GitFile[] = [];
      await git.walk({
        fs,
        dir,
        gitdir: dir,
        trees: [git.TREE({ ref: commitOid })],
        map: async (filepath, [entry]) => {
          if (!entry) return;
          if (folderPath && !filepath.startsWith(folderPath + '/')) return;
          if (folderPath && filepath !== folderPath && filepath.slice(folderPath.length + 1).includes('/')) return; // Direct children only
          if (!folderPath && filepath.includes('/')) return; // Root children only

          const relativePath = folderPath ? filepath.slice(folderPath.length + 1) : filepath;
          if (relativePath === '' || relativePath === '.') return;

          const type = await entry.type();
          if (type === 'blob') files.push({ name: relativePath, path: filepath, type: 'file' });
          else if (type === 'tree')
            files.push({
              name: relativePath,
              path: filepath,
              type: 'directory',
            });
        },
      });
      return files;
    } catch {
      return [];
    }
  }

  async getFileContentInBothBranches(filePath: string): Promise<{ main: string | null; dirty: string | null } | null> {
    const mainContent = await this.getFileContent(MAIN_BRANCH, filePath);
    const dirtyContent = await this.getFileContent(DIRTY_BRANCH, filePath);
    if (mainContent === null && dirtyContent === null) return null;
    return { main: mainContent, dirty: dirtyContent };
  }

  // Optimized variant: resolve ref once, single tree walk over the folder subtree to build path→oid,
  // then fetch all blobs in parallel (no per-file tree traversal).
  async readFilesFromFolder(
    branch: string,
    folderPath: string,
    filenames: string[],
  ): Promise<Array<{ path: string; content: string | null }>> {
    if (filenames.length === 0) return [];

    const dir = this.getRepoPath();
    const folder = folderPath.startsWith('/') ? folderPath.slice(1) : folderPath;
    // Full paths as stored in git (no leading slash)
    const fullPaths = filenames.map((name) => (folder ? `${folder}/${name}` : name));
    const pathSet = new Set(fullPaths);

    let commitOid: string;
    try {
      commitOid = await this.resolveRef(branch);
    } catch {
      return fullPaths.map((p) => ({ path: p, content: null }));
    }

    const oidMap = new Map<string, string>();
    await git.walk({
      fs,
      dir,
      gitdir: dir,
      trees: [git.TREE({ ref: commitOid })],
      map: async (filepath, [entry]) => {
        if (!entry) return undefined;
        const type = await entry.type();
        if (type === 'tree') {
          // Descend only into the target folder (skip everything else)
          if (folder === '') return true;
          return filepath === folder || folder.startsWith(filepath + '/') ? true : undefined;
        }
        if (type === 'blob' && pathSet.has(filepath)) {
          oidMap.set(filepath, await entry.oid());
        }
        return undefined;
      },
    });

    return Promise.all(
      fullPaths.map(async (p) => {
        const oid = oidMap.get(p);
        if (!oid) return { path: p, content: null };
        try {
          const { blob } = await git.readBlob({ fs, dir, gitdir: dir, oid });
          return { path: p, content: new TextDecoder().decode(blob) };
        } catch {
          return { path: p, content: null };
        }
      }),
    );
  }

  // TODO: optimize this
  async readFiles(branch: string, paths: string[]): Promise<Array<{ path: string; content: string | null }>> {
    const results = await Promise.all(
      paths.map(async (path) => {
        const content = await this.getFileContent(branch, path);
        return { path, content };
      }),
    );
    return results;
  }

  async readFilesPaginated(
    branch: string,
    folderPath: string,
    limit: number,
    cursor?: string,
  ): Promise<{ files: Array<{ name: string; content: string }>; nextCursor?: string }> {
    const allFiles = await this.list(branch, folderPath);
    // Sort by name for consistent pagination
    allFiles.sort((a, b) => a.name.localeCompare(b.name));

    // Filter for files only (no directories) and apply cursor
    let fileEntries = allFiles.filter((f) => f.type === 'file');

    if (cursor) {
      const cursorIndex = fileEntries.findIndex((f) => f.name === cursor);
      if (cursorIndex !== -1) {
        fileEntries = fileEntries.slice(cursorIndex + 1);
      }
    }

    // Apply limit
    const paginatedEntries = fileEntries.slice(0, limit);
    const nextCursor = paginatedEntries.length > 0 ? paginatedEntries[paginatedEntries.length - 1].name : undefined;
    const hasMore = fileEntries.length > limit;

    // Fetch content for paginated entries
    const filesWithContent = await Promise.all(
      paginatedEntries.map(async (entry) => {
        const content = await this.getFileContent(branch, entry.path);
        return {
          name: entry.name,
          content: content || '',
        };
      }),
    );

    return {
      files: filesWithContent,
      nextCursor: hasMore ? nextCursor : undefined,
    };
  }

  async readBlobsByOid(oids: string[]): Promise<Array<{ oid: string; content: string | null }>> {
    if (oids.length === 0) return [];
    const dir = this.getRepoPath();
    return Promise.all(
      oids.map(async (oid) => {
        try {
          const { blob } = await git.readBlob({ fs, dir, gitdir: dir, oid });
          return { oid, content: new TextDecoder().decode(blob) };
        } catch {
          return { oid, content: null };
        }
      }),
    );
  }

  async createArchive(branch: string): Promise<Readable> {
    const dir = this.getRepoPath();
    const commitOid = await this.resolveRef(branch);

    const archive = archiver('zip', { zlib: { level: 6 } });

    // Walk tree and add all files (skip dotfiles)
    await git.walk({
      fs,
      dir,
      gitdir: dir,
      trees: [git.TREE({ ref: commitOid })],
      map: async (filepath, [entry]) => {
        if (!entry) return;
        // Skip hidden files/directories (starting with .)
        if (filepath.split('/').some((p) => p.startsWith('.'))) return;

        const type = await entry.type();
        if (type === 'blob') {
          const { blob } = await git.readBlob({
            fs,
            dir,
            gitdir: dir,
            oid: await entry.oid(),
          });
          archive.append(Buffer.from(blob), { name: filepath });
        }
      },
    });

    // added void since linter was complaining, assuming the non-awaited behavior is expected
    void archive.finalize();
    return archive;
  }
}
