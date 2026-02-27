import { ScratchGitClient } from '../src/client';
import { file, newRepoId } from '../src/helpers';

const client = new ScratchGitClient();

describe('Repo Write', () => {
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

  describe('commitFiles', () => {
    it('should commit a single file to main', async () => {
      await client.commitFiles(repoId, [file('hello.md', 'world')], 'add hello');
      const result = await client.getFile(repoId, 'hello.md', 'main');
      expect(result.content).toBe('world');
    });

    it('should commit multiple files in one call', async () => {
      await client.commitFiles(
        repoId,
        [file('a.md', 'aaa'), file('b.md', 'bbb'), file('c.md', 'ccc')],
        'add multiple',
      );
      const a = await client.getFile(repoId, 'a.md', 'main');
      const b = await client.getFile(repoId, 'b.md', 'main');
      const c = await client.getFile(repoId, 'c.md', 'main');
      expect(a.content).toBe('aaa');
      expect(b.content).toBe('bbb');
      expect(c.content).toBe('ccc');
    });

    it('should overwrite existing file with new content', async () => {
      await client.commitFiles(repoId, [file('doc.md', 'v1')], 'v1');
      await client.commitFiles(repoId, [file('doc.md', 'v2')], 'v2');
      const result = await client.getFile(repoId, 'doc.md', 'main');
      expect(result.content).toBe('v2');
    });

    it('should normalize paths with leading /', async () => {
      await client.commitFiles(repoId, [file('/leading-slash.md', 'content')], 'add');
      const result = await client.getFile(repoId, 'leading-slash.md', 'main');
      expect(result.content).toBe('content');
    });

    it('should default to main branch when not specified', async () => {
      await client.commitFiles(repoId, [file('default-branch.md', 'on main')]);
      const result = await client.getFile(repoId, 'default-branch.md', 'main');
      expect(result.content).toBe('on main');
    });

    it('should commit to dirty branch explicitly', async () => {
      await client.commitFiles(repoId, [file('dirty-file.md', 'dirty content')], 'add', 'dirty');
      const dirty = await client.getFile(repoId, 'dirty-file.md', 'dirty');
      expect(dirty.content).toBe('dirty content');
    });

    it('should commit files in nested folders', async () => {
      await client.commitFiles(repoId, [file('folder/sub/deep.md', 'deep content')], 'add nested');
      const result = await client.getFile(repoId, 'folder/sub/deep.md', 'main');
      expect(result.content).toBe('deep content');
    });
  });

  describe('deleteFiles', () => {
    it('should delete a single file', async () => {
      await client.commitFiles(repoId, [file('to-delete.md', 'content')], 'add');
      await client.deleteFiles(repoId, ['to-delete.md'], 'delete');
      const res = await client.getFileRaw(repoId, 'to-delete.md', 'main');
      expect(res.status).toBe(404);
    });

    it('should delete multiple files in one call', async () => {
      await client.commitFiles(repoId, [file('d1.md', 'a'), file('d2.md', 'b')], 'add');
      await client.deleteFiles(repoId, ['d1.md', 'd2.md'], 'delete both');
      const r1 = await client.getFileRaw(repoId, 'd1.md', 'main');
      const r2 = await client.getFileRaw(repoId, 'd2.md', 'main');
      expect(r1.status).toBe(404);
      expect(r2.status).toBe(404);
    });

    it('should succeed when deleting non-existent file', async () => {
      const result = await client.deleteFiles(repoId, ['nonexistent.md'], 'delete');
      expect(result).toEqual({ success: true });
    });

    it('should normalize paths with leading /', async () => {
      await client.commitFiles(repoId, [file('slash-file.md', 'content')], 'add');
      await client.deleteFiles(repoId, ['/slash-file.md'], 'delete');
      const res = await client.getFileRaw(repoId, 'slash-file.md', 'main');
      expect(res.status).toBe(404);
    });
  });

  describe('deleteFolder', () => {
    it('should delete folder recursively', async () => {
      await client.commitFiles(
        repoId,
        [file('folder/a.md', 'a'), file('folder/b.md', 'b'), file('other.md', 'other')],
        'add',
        'dirty',
      );
      await client.deleteFolder(repoId, 'folder');
      const files = await client.listFiles(repoId, 'dirty');
      const names = files.map((f) => f.name);
      expect(names).not.toContain('folder');
      expect(names).toContain('other.md');
    });

    it('should default to dirty branch', async () => {
      await client.commitFiles(repoId, [file('myfolder/x.md', 'x')], 'add', 'dirty');
      await client.deleteFolder(repoId, 'myfolder');
      const files = await client.listFiles(repoId, 'dirty');
      expect(files.map((f) => f.name)).not.toContain('myfolder');
    });

    it('should delete folder on explicit branch', async () => {
      await client.commitFiles(repoId, [file('folder/x.md', 'x')], 'add', 'main');
      await client.deleteFolder(repoId, 'folder', 'main');
      const files = await client.listFiles(repoId, 'main');
      expect(files.map((f) => f.name)).not.toContain('folder');
    });
  });

  describe('deleteDataFolder', () => {
    it('should remove folder from both main and dirty', async () => {
      // Add folder to main
      await client.commitFiles(repoId, [file('data/a.md', 'main-a')], 'add to main', 'main');
      // Rebase dirty so it also has the file
      await client.rebase(repoId);
      // Add another file on dirty
      await client.commitFiles(repoId, [file('data/b.md', 'dirty-b')], 'add to dirty', 'dirty');

      await client.deleteDataFolder(repoId, 'data');

      const mainFiles = await client.listFiles(repoId, 'main');
      const dirtyFiles = await client.listFiles(repoId, 'dirty');
      expect(mainFiles.map((f) => f.name)).not.toContain('data');
      expect(dirtyFiles.map((f) => f.name)).not.toContain('data');
    });

    it('should preserve files outside the folder on both branches', async () => {
      await client.commitFiles(
        repoId,
        [file('data/x.md', 'x'), file('keep.md', 'keep')],
        'add',
        'main',
      );
      await client.rebase(repoId);

      await client.deleteDataFolder(repoId, 'data');

      const mainFile = await client.getFile(repoId, 'keep.md', 'main');
      expect(mainFile.content).toBe('keep');
      const dirtyFile = await client.getFile(repoId, 'keep.md', 'dirty');
      expect(dirtyFile.content).toBe('keep');
    });
  });

  describe('publish', () => {
    it('should publish file to main', async () => {
      await client.publishFile(repoId, file('pub.md', 'published content'), 'publish');
      const result = await client.getFile(repoId, 'pub.md', 'main');
      expect(result.content).toBe('published content');
    });

    it('should rebase dirty after publish', async () => {
      await client.publishFile(repoId, file('pub.md', 'published'), 'publish');
      // Dirty should also see the file after rebase
      const dirty = await client.getFile(repoId, 'pub.md', 'dirty');
      expect(dirty.content).toBe('published');
    });

    it('should preserve other dirty changes after publish', async () => {
      // Add a dirty-only file
      await client.commitFiles(repoId, [file('dirty-only.md', 'dirty')], 'add dirty', 'dirty');

      // Publish a different file
      await client.publishFile(repoId, file('pub.md', 'published'), 'publish');

      // Dirty-only file should still be on dirty
      const dirtyFile = await client.getFile(repoId, 'dirty-only.md', 'dirty');
      expect(dirtyFile.content).toBe('dirty');
    });
  });

  describe('discardChanges', () => {
    it('should discard modified file — content reverts to main version', async () => {
      await client.commitFiles(repoId, [file('doc.md', 'original')], 'add', 'main');
      await client.rebase(repoId);
      await client.commitFiles(repoId, [file('doc.md', 'modified')], 'modify', 'dirty');

      await client.discardChanges(repoId, 'doc.md');

      const dirty = await client.getFile(repoId, 'doc.md', 'dirty');
      expect(dirty.content).toBe('original');
    });

    it('should discard added file — file removed from dirty', async () => {
      await client.commitFiles(repoId, [file('new-file.md', 'new')], 'add', 'dirty');

      await client.discardChanges(repoId, 'new-file.md');

      const res = await client.getFileRaw(repoId, 'new-file.md', 'dirty');
      expect(res.status).toBe(404);
    });

    it('should discard deleted file — file restored on dirty from main', async () => {
      await client.commitFiles(repoId, [file('restore.md', 'original')], 'add', 'main');
      await client.rebase(repoId);
      await client.deleteFiles(repoId, ['restore.md'], 'delete', 'dirty');

      await client.discardChanges(repoId, 'restore.md');

      const dirty = await client.getFile(repoId, 'restore.md', 'dirty');
      expect(dirty.content).toBe('original');
    });

    it('should discard with path prefix — all matching files discarded', async () => {
      await client.commitFiles(repoId, [file('folder/a.md', 'a'), file('folder/b.md', 'b')], 'add', 'main');
      await client.rebase(repoId);
      await client.commitFiles(
        repoId,
        [file('folder/a.md', 'modified-a'), file('folder/b.md', 'modified-b')],
        'modify',
        'dirty',
      );

      await client.discardChanges(repoId, 'folder');

      const a = await client.getFile(repoId, 'folder/a.md', 'dirty');
      const b = await client.getFile(repoId, 'folder/b.md', 'dirty');
      expect(a.content).toBe('a');
      expect(b.content).toBe('b');
    });

    it('should be a no-op for non-matching path', async () => {
      await client.commitFiles(repoId, [file('exists.md', 'content')], 'add', 'dirty');
      const result = await client.discardChanges(repoId, 'nonexistent/');
      expect(result).toEqual({ success: true });
    });
  });

  describe('rename', () => {
    it('should rename files in folder', async () => {
      await client.commitFiles(repoId, [file('folder/old-name.md', 'content')], 'add', 'main');
      await client.rebase(repoId); // rename reads from dirty, so ensure file is on dirty

      await client.renameFiles(repoId, 'folder', [{ oldName: 'old-name.md', newName: 'new-name.md' }]);

      const mainFiles = await client.listFiles(repoId, 'main', 'folder');
      const dirtyFiles = await client.listFiles(repoId, 'dirty', 'folder');
      const mainNames = mainFiles.map((f) => f.name);
      const dirtyNames = dirtyFiles.map((f) => f.name);
      expect(mainNames).toContain('new-name.md');
      expect(mainNames).not.toContain('old-name.md');
      expect(dirtyNames).toContain('new-name.md');
      expect(dirtyNames).not.toContain('old-name.md');
    });

    it('should preserve file content after rename', async () => {
      await client.commitFiles(repoId, [file('folder/original.md', 'my content')], 'add', 'main');
      await client.rebase(repoId); // rename reads from dirty, so ensure file is on dirty

      await client.renameFiles(repoId, 'folder', [{ oldName: 'original.md', newName: 'renamed.md' }]);

      const result = await client.getFile(repoId, 'folder/renamed.md', 'main');
      expect(result.content).toBe('my content');
    });

    it('should preserve other uncommitted dirty changes', async () => {
      await client.commitFiles(repoId, [file('folder/to-rename.md', 'content')], 'add', 'main');
      await client.rebase(repoId);
      // Add a dirty-only change
      await client.commitFiles(repoId, [file('dirty-change.md', 'dirty')], 'add dirty', 'dirty');

      await client.renameFiles(repoId, 'folder', [{ oldName: 'to-rename.md', newName: 'renamed.md' }]);

      // Dirty change should survive
      const dirty = await client.getFile(repoId, 'dirty-change.md', 'dirty');
      expect(dirty.content).toBe('dirty');
    });
  });
});
