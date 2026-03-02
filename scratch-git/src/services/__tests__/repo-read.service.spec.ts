import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DIRTY_BRANCH, MAIN_BRANCH } from '../../../lib/constants';
import { RepoManageService } from '../repo-manage.service';
import { RepoReadService } from '../repo-read.service';
import { RepoWriteService } from '../repo-write.service';

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

const TEST_REPOS_DIR = path.join(os.tmpdir(), `scratch-git-test-${process.pid}`);
process.env.GIT_REPOS_DIR = TEST_REPOS_DIR;

let repoId: string;

function newRepoId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

beforeEach(async () => {
  repoId = newRepoId();
  await new RepoManageService(repoId).initRepo();
});

afterEach(async () => {
  await new RepoManageService(repoId).deleteRepo();
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------
describe('list', () => {
  it('returns empty array for empty repo', async () => {
    const reader = new RepoReadService(repoId);
    const files = await reader.list(MAIN_BRANCH, '');
    expect(files).toEqual([]);
  });

  it('lists root-level files', async () => {
    const writer = new RepoWriteService(repoId);
    await writer.commitFiles(
      MAIN_BRANCH,
      [
        { path: 'a.md', content: 'a' },
        { path: 'b.md', content: 'b' },
      ],
      'add files',
    );

    const reader = new RepoReadService(repoId);
    const files = await reader.list(MAIN_BRANCH, '');
    const names = files.map((f) => f.name).sort();
    expect(names).toEqual(['a.md', 'b.md']);
    expect(files.every((f) => f.type === 'file')).toBe(true);
  });

  it('lists directories at root level', async () => {
    const writer = new RepoWriteService(repoId);
    await writer.commitFiles(MAIN_BRANCH, [{ path: 'folder/file.md', content: 'x' }], 'add nested');

    const reader = new RepoReadService(repoId);
    const files = await reader.list(MAIN_BRANCH, '');
    expect(files).toEqual([{ name: 'folder', path: 'folder', type: 'directory' }]);
  });

  it('lists only direct children of a folder', async () => {
    const writer = new RepoWriteService(repoId);
    await writer.commitFiles(
      MAIN_BRANCH,
      [
        { path: 'dir/a.md', content: 'a' },
        { path: 'dir/b.md', content: 'b' },
        { path: 'dir/sub/deep.md', content: 'deep' },
      ],
      'add files',
    );

    const reader = new RepoReadService(repoId);
    const files = await reader.list(MAIN_BRANCH, 'dir');
    const names = files.map((f) => f.name).sort();
    expect(names).toEqual(['a.md', 'b.md', 'sub']);
  });

  it('does not include root-level files when listing a folder', async () => {
    const writer = new RepoWriteService(repoId);
    await writer.commitFiles(
      MAIN_BRANCH,
      [
        { path: 'root.md', content: 'root' },
        { path: 'dir/child.md', content: 'child' },
      ],
      'add files',
    );

    const reader = new RepoReadService(repoId);
    const files = await reader.list(MAIN_BRANCH, 'dir');
    expect(files).toEqual([{ name: 'child.md', path: 'dir/child.md', type: 'file' }]);
  });

  it('includes dotfiles and dotfolders', async () => {
    const writer = new RepoWriteService(repoId);
    await writer.commitFiles(
      MAIN_BRANCH,
      [
        { path: '.hidden', content: 'x' },
        { path: 'visible.md', content: 'y' },
      ],
      'add files',
    );

    const reader = new RepoReadService(repoId);
    const files = await reader.list(MAIN_BRANCH, '');
    const names = files.map((f) => f.name).sort();
    expect(names).toEqual(['.hidden', 'visible.md']);
  });

  it('includes dotfiles in subfolders', async () => {
    const writer = new RepoWriteService(repoId);
    await writer.commitFiles(
      MAIN_BRANCH,
      [
        { path: 'dir/.schema.json', content: '{}' },
        { path: 'dir/file.md', content: 'x' },
      ],
      'add files',
    );

    const reader = new RepoReadService(repoId);
    const files = await reader.list(MAIN_BRANCH, 'dir');
    const names = files.map((f) => f.name).sort();
    expect(names).toEqual(['.schema.json', 'file.md']);
  });
});

// ---------------------------------------------------------------------------
// getFileContentInBothBranches
// ---------------------------------------------------------------------------
describe('getFileContentInBothBranches', () => {
  it('returns null when file exists on neither branch', async () => {
    const reader = new RepoReadService(repoId);
    const result = await reader.getFileContentInBothBranches('nope.md');
    expect(result).toBeNull();
  });

  it('returns content from both branches when they differ', async () => {
    const writer = new RepoWriteService(repoId);
    await writer.commitFiles(MAIN_BRANCH, [{ path: 'f.md', content: 'main-v' }], 'seed');
    await writer.rebaseDirty();
    await writer.commitFiles(DIRTY_BRANCH, [{ path: 'f.md', content: 'dirty-v' }], 'edit');

    const reader = new RepoReadService(repoId);
    const result = await reader.getFileContentInBothBranches('f.md');
    expect(result).toEqual({ main: 'main-v', dirty: 'dirty-v' });
  });

  it('returns null for main when file only exists on dirty', async () => {
    const writer = new RepoWriteService(repoId);
    await writer.commitFiles(DIRTY_BRANCH, [{ path: 'new.md', content: 'dirty-only' }], 'add');

    const reader = new RepoReadService(repoId);
    const result = await reader.getFileContentInBothBranches('new.md');
    expect(result).toEqual({ main: null, dirty: 'dirty-only' });
  });
});

// ---------------------------------------------------------------------------
// readFiles
// ---------------------------------------------------------------------------
describe('readFiles', () => {
  it('reads multiple files by path', async () => {
    const writer = new RepoWriteService(repoId);
    await writer.commitFiles(
      MAIN_BRANCH,
      [
        { path: 'a.md', content: 'aaa' },
        { path: 'b.md', content: 'bbb' },
      ],
      'add',
    );

    const reader = new RepoReadService(repoId);
    const results = await reader.readFiles(MAIN_BRANCH, ['a.md', 'b.md']);
    expect(results).toEqual([
      { path: 'a.md', content: 'aaa' },
      { path: 'b.md', content: 'bbb' },
    ]);
  });

  it('returns null for missing files', async () => {
    const reader = new RepoReadService(repoId);
    const results = await reader.readFiles(MAIN_BRANCH, ['missing.md']);
    expect(results).toEqual([{ path: 'missing.md', content: null }]);
  });
});

// ---------------------------------------------------------------------------
// readFilesPaginated
// ---------------------------------------------------------------------------
describe('readFilesPaginated', () => {
  beforeEach(async () => {
    const writer = new RepoWriteService(repoId);
    await writer.commitFiles(
      MAIN_BRANCH,
      [
        { path: 'dir/a.md', content: 'a' },
        { path: 'dir/b.md', content: 'b' },
        { path: 'dir/c.md', content: 'c' },
        { path: 'dir/d.md', content: 'd' },
        { path: 'dir/e.md', content: 'e' },
      ],
      'add files',
    );
  });

  it('returns first page with nextCursor', async () => {
    const reader = new RepoReadService(repoId);
    const result = await reader.readFilesPaginated(MAIN_BRANCH, 'dir', 2);

    expect(result.files).toEqual([
      { name: 'a.md', content: 'a' },
      { name: 'b.md', content: 'b' },
    ]);
    expect(result.nextCursor).toBe('b.md');
  });

  it('returns next page using cursor', async () => {
    const reader = new RepoReadService(repoId);
    const result = await reader.readFilesPaginated(MAIN_BRANCH, 'dir', 2, 'b.md');

    expect(result.files).toEqual([
      { name: 'c.md', content: 'c' },
      { name: 'd.md', content: 'd' },
    ]);
    expect(result.nextCursor).toBe('d.md');
  });

  it('returns last page without nextCursor', async () => {
    const reader = new RepoReadService(repoId);
    const result = await reader.readFilesPaginated(MAIN_BRANCH, 'dir', 2, 'd.md');

    expect(result.files).toEqual([{ name: 'e.md', content: 'e' }]);
    expect(result.nextCursor).toBeUndefined();
  });

  it('returns all files when limit exceeds count', async () => {
    const reader = new RepoReadService(repoId);
    const result = await reader.readFilesPaginated(MAIN_BRANCH, 'dir', 100);

    expect(result.files).toHaveLength(5);
    expect(result.nextCursor).toBeUndefined();
  });

  it('excludes directories from paginated results', async () => {
    const writer = new RepoWriteService(repoId);
    await writer.commitFiles(MAIN_BRANCH, [{ path: 'dir/sub/nested.md', content: 'n' }], 'add nested');

    const reader = new RepoReadService(repoId);
    const result = await reader.readFilesPaginated(MAIN_BRANCH, 'dir', 100);

    // Should have 5 files (a-e), not the 'sub' directory
    const names = result.files.map((f) => f.name);
    expect(names).not.toContain('sub');
    expect(names).toContain('a.md');
  });
});

// ---------------------------------------------------------------------------
// createArchive
// ---------------------------------------------------------------------------
describe('createArchive', () => {
  it('returns a readable stream containing repo files', async () => {
    const writer = new RepoWriteService(repoId);
    await writer.commitFiles(
      MAIN_BRANCH,
      [
        { path: 'file1.md', content: 'content1' },
        { path: 'dir/file2.md', content: 'content2' },
      ],
      'add files',
    );

    const reader = new RepoReadService(repoId);
    const stream = await reader.createArchive(MAIN_BRANCH);

    const buffer = await streamToBuffer(stream);

    // ZIP files start with PK signature (0x50 0x4b)
    expect(buffer[0]).toBe(0x50);
    expect(buffer[1]).toBe(0x4b);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('skips dotfiles in archive', async () => {
    const writer = new RepoWriteService(repoId);
    await writer.commitFiles(
      MAIN_BRANCH,
      [
        { path: '.hidden', content: 'secret' },
        { path: 'visible.md', content: 'visible' },
      ],
      'add files',
    );

    const reader = new RepoReadService(repoId);
    const stream = await reader.createArchive(MAIN_BRANCH);

    const buffer = await streamToBuffer(stream);

    // The archive should not contain '.hidden' - check by searching for the string in the zip
    const content = buffer.toString('binary');
    expect(content).not.toContain('.hidden');
    expect(content).toContain('visible.md');
  });
});
