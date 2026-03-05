import { ScratchGitClient } from '../src/client';
import { file, newRepoId } from '../src/helpers';

const client = new ScratchGitClient();

describe('Repo Diff', () => {
  let repoId: string;

  beforeEach(async () => {
    repoId = newRepoId();
    await client.initRepo(repoId);
  });

  afterEach(async () => {
    try {
      await client.deleteRepo(repoId);
    } catch {
      // best effort
    }
  });

  describe('getDirtyStatus', () => {
    it('should return empty array when no changes', async () => {
      const status = await client.getDirtyStatus(repoId);
      expect(status).toEqual([]);
    });

    it('should detect added file on dirty', async () => {
      await client.commitFiles(repoId, [file('new.md', 'content')], 'add', 'dirty');
      const status = await client.getDirtyStatus(repoId);
      expect(status).toHaveLength(1);
      expect(status[0].path).toBe('new.md');
      expect(status[0].status).toBe('added');
    });

    it('should detect modified file on dirty', async () => {
      await client.commitFiles(repoId, [file('doc.md', 'original')], 'add', 'main');
      await client.rebase(repoId);
      await client.commitFiles(repoId, [file('doc.md', 'modified')], 'modify', 'dirty');

      const status = await client.getDirtyStatus(repoId);
      expect(status).toHaveLength(1);
      expect(status[0].path).toBe('doc.md');
      expect(status[0].status).toBe('modified');
    });

    it('should detect deleted file from dirty', async () => {
      await client.commitFiles(repoId, [file('to-delete.md', 'content')], 'add', 'main');
      await client.rebase(repoId);
      await client.deleteFiles(repoId, ['to-delete.md'], 'delete', 'dirty');

      const status = await client.getDirtyStatus(repoId);
      expect(status).toHaveLength(1);
      expect(status[0].path).toBe('to-delete.md');
      expect(status[0].status).toBe('deleted');
    });

    it('should reflect multiple changes', async () => {
      await client.commitFiles(
        repoId,
        [file('keep.md', 'keep'), file('delete-me.md', 'del')],
        'add',
        'main',
      );
      await client.rebase(repoId);

      await client.commitFiles(repoId, [file('keep.md', 'modified')], 'modify', 'dirty');
      await client.deleteFiles(repoId, ['delete-me.md'], 'delete', 'dirty');
      await client.commitFiles(repoId, [file('brand-new.md', 'new')], 'add new', 'dirty');

      const status = await client.getDirtyStatus(repoId);
      expect(status).toHaveLength(3);

      const byPath = Object.fromEntries(status.map((s) => [s.path, s.status]));
      expect(byPath['keep.md']).toBe('modified');
      expect(byPath['delete-me.md']).toBe('deleted');
      expect(byPath['brand-new.md']).toBe('added');
    });
  });

  describe('hasDirtyFiles', () => {
    it('should return false when no changes', async () => {
      const result = await client.hasDirtyFiles(repoId);
      expect(result.dirty).toBe(false);
    });

    it('should return true when there are changes', async () => {
      await client.commitFiles(repoId, [file('x.md', 'x')], 'add', 'dirty');
      const result = await client.hasDirtyFiles(repoId);
      expect(result.dirty).toBe(true);
    });

    it('should compare tree OIDs — same tree different commits returns false', async () => {
      // Commit to main and rebase so merge_base is updated, then dirty has same content
      await client.commitFiles(repoId, [file('same.md', 'content')], 'add to main', 'main');
      await client.rebase(repoId);

      // After rebase, dirty has same tree as merge_base
      const result = await client.hasDirtyFiles(repoId);
      expect(result.dirty).toBe(false);
    });
  });

  describe('getDirtyStatusCount', () => {
    it('should return 0 when no changes', async () => {
      const result = await client.getDirtyStatusCount(repoId);
      expect(result.count).toBe(0);
    });

    it('should match dirty status array length', async () => {
      await client.commitFiles(repoId, [file('a.md', 'a'), file('b.md', 'b')], 'add', 'dirty');

      const count = await client.getDirtyStatusCount(repoId);
      const status = await client.getDirtyStatus(repoId);
      expect(count.count).toBe(status.length);
    });
  });

  describe('getFolderDiff', () => {
    it('should return only changes within specified folder', async () => {
      await client.commitFiles(
        repoId,
        [file('folder/inside.md', 'in'), file('outside.md', 'out')],
        'add',
        'dirty',
      );

      const diff = await client.getFolderDiff(repoId, 'folder');
      expect(diff).toHaveLength(1);
      expect(diff[0].path).toBe('folder/inside.md');
    });

    it('should normalize leading / on folder path', async () => {
      await client.commitFiles(repoId, [file('folder/x.md', 'x')], 'add', 'dirty');

      const diff = await client.getFolderDiff(repoId, '/folder');
      expect(diff).toHaveLength(1);
      expect(diff[0].path).toBe('folder/x.md');
    });

    it('should return empty array for non-existent folder', async () => {
      await client.commitFiles(repoId, [file('other/x.md', 'x')], 'add', 'dirty');

      const diff = await client.getFolderDiff(repoId, 'nonexistent');
      expect(diff).toEqual([]);
    });

    it('should exclude changes outside folder', async () => {
      await client.commitFiles(
        repoId,
        [file('a/x.md', 'x'), file('b/y.md', 'y')],
        'add',
        'dirty',
      );

      const diff = await client.getFolderDiff(repoId, 'a');
      const paths = diff.map((d) => d.path);
      expect(paths).toContain('a/x.md');
      expect(paths).not.toContain('b/y.md');
    });
  });
});
