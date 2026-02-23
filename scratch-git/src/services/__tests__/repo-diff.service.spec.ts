import os from 'node:os';
import path from 'node:path';
import { DIRTY_BRANCH, MAIN_BRANCH } from '../../../lib/constants';
import { RepoDiffService } from '../repo-diff.service';
import { RepoManageService } from '../repo-manage.service';
import { RepoWriteService } from '../repo-write.service';

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
// getDirtyStatus
// ---------------------------------------------------------------------------
describe('getDirtyStatus', () => {
  it('returns empty array when main === dirty', async () => {
    const diff = new RepoDiffService(repoId);
    const status = await diff.getDirtyStatus();
    expect(status).toEqual([]);
  });

  it('detects added files', async () => {
    const writer = new RepoWriteService(repoId);
    await writer.commitFiles(DIRTY_BRANCH, [{ path: 'new.md', content: 'new' }], 'add');

    const diff = new RepoDiffService(repoId);
    const status = await diff.getDirtyStatus();
    expect(status).toEqual([expect.objectContaining({ path: 'new.md', status: 'added' })]);
  });

  it('detects modified files', async () => {
    const writer = new RepoWriteService(repoId);
    await writer.commitFiles(MAIN_BRANCH, [{ path: 'f.md', content: 'v1' }], 'seed');
    await writer.rebaseDirty();
    await writer.commitFiles(DIRTY_BRANCH, [{ path: 'f.md', content: 'v2' }], 'modify');

    const diff = new RepoDiffService(repoId);
    const status = await diff.getDirtyStatus();
    expect(status).toEqual([expect.objectContaining({ path: 'f.md', status: 'modified' })]);
  });

  it('detects deleted files', async () => {
    const writer = new RepoWriteService(repoId);
    await writer.commitFiles(MAIN_BRANCH, [{ path: 'f.md', content: 'v1' }], 'seed');
    await writer.rebaseDirty();
    await writer.deleteFiles(DIRTY_BRANCH, ['f.md'], 'delete');

    const diff = new RepoDiffService(repoId);
    const status = await diff.getDirtyStatus();
    expect(status).toEqual([{ path: 'f.md', status: 'deleted' }]);
  });

  it('detects multiple change types at once', async () => {
    const writer = new RepoWriteService(repoId);
    await writer.commitFiles(
      MAIN_BRANCH,
      [
        { path: 'modify.md', content: 'v1' },
        { path: 'delete.md', content: 'v1' },
      ],
      'seed',
    );
    await writer.rebaseDirty();

    await writer.commitFiles(
      DIRTY_BRANCH,
      [
        { path: 'modify.md', content: 'v2' },
        { path: 'added.md', content: 'new' },
      ],
      'edit',
    );
    await writer.deleteFiles(DIRTY_BRANCH, ['delete.md'], 'delete');

    const diff = new RepoDiffService(repoId);
    const status = await diff.getDirtyStatus();
    const sorted = status.sort((a, b) => a.path.localeCompare(b.path));
    expect(sorted).toEqual([
      expect.objectContaining({ path: 'added.md', status: 'added' }),
      { path: 'delete.md', status: 'deleted' },
      expect.objectContaining({ path: 'modify.md', status: 'modified' }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// getFolderDirtyStatus
// ---------------------------------------------------------------------------
describe('getFolderDirtyStatus', () => {
  it('returns empty array when main === dirty', async () => {
    const diff = new RepoDiffService(repoId);
    const status = await diff.getFolderDirtyStatus('folder');
    expect(status).toEqual([]);
  });

  it('returns only changes within the specified folder', async () => {
    const writer = new RepoWriteService(repoId);
    await writer.commitFiles(
      MAIN_BRANCH,
      [
        { path: 'target/a.md', content: 'a' },
        { path: 'other/b.md', content: 'b' },
      ],
      'seed',
    );
    await writer.rebaseDirty();

    await writer.commitFiles(
      DIRTY_BRANCH,
      [
        { path: 'target/a.md', content: 'a-modified' },
        { path: 'other/b.md', content: 'b-modified' },
      ],
      'edit both',
    );

    const diff = new RepoDiffService(repoId);
    const status = await diff.getFolderDirtyStatus('target');
    expect(status).toEqual([expect.objectContaining({ path: 'target/a.md', status: 'modified' })]);
  });

  it('strips leading / from folder path', async () => {
    const writer = new RepoWriteService(repoId);
    await writer.commitFiles(MAIN_BRANCH, [{ path: 'dir/f.md', content: 'v1' }], 'seed');
    await writer.rebaseDirty();
    await writer.commitFiles(DIRTY_BRANCH, [{ path: 'dir/f.md', content: 'v2' }], 'edit');

    const diff = new RepoDiffService(repoId);
    const status = await diff.getFolderDirtyStatus('/dir');
    expect(status).toEqual([expect.objectContaining({ path: 'dir/f.md', status: 'modified' })]);
  });

  it('includes nested changes within folder', async () => {
    const writer = new RepoWriteService(repoId);
    await writer.commitFiles(MAIN_BRANCH, [{ path: 'dir/sub/deep.md', content: 'v1' }], 'seed');
    await writer.rebaseDirty();
    await writer.commitFiles(DIRTY_BRANCH, [{ path: 'dir/sub/deep.md', content: 'v2' }], 'edit');

    const diff = new RepoDiffService(repoId);
    const status = await diff.getFolderDirtyStatus('dir');
    expect(status).toEqual([expect.objectContaining({ path: 'dir/sub/deep.md', status: 'modified' })]);
  });

  it('returns empty when no changes match folder', async () => {
    const writer = new RepoWriteService(repoId);
    await writer.commitFiles(MAIN_BRANCH, [{ path: 'other/f.md', content: 'v1' }], 'seed');
    await writer.rebaseDirty();
    await writer.commitFiles(DIRTY_BRANCH, [{ path: 'other/f.md', content: 'v2' }], 'edit');

    const diff = new RepoDiffService(repoId);
    const status = await diff.getFolderDirtyStatus('target');
    expect(status).toEqual([]);
  });
});
