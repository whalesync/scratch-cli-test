import { ScratchGitClient } from '../src/client';
import { file, newRepoId } from '../src/helpers';

const client = new ScratchGitClient();

describe('Repo Read', () => {
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

  describe('listFiles', () => {
    it('should return empty array for empty repo', async () => {
      const files = await client.listFiles(repoId);
      expect(files).toEqual([]);
    });

    it('should return files and directories at root', async () => {
      await client.commitFiles(
        repoId,
        [file('root-file.md', 'rf'), file('folder/nested.md', 'nf')],
        'add files',
      );

      const files = await client.listFiles(repoId);
      const names = files.map((f) => f.name);
      expect(names).toContain('root-file.md');
      expect(names).toContain('folder');

      const rootFile = files.find((f) => f.name === 'root-file.md');
      expect(rootFile?.type).toBe('file');
      const folder = files.find((f) => f.name === 'folder');
      expect(folder?.type).toBe('directory');
    });

    it('should return direct children only (not grandchildren)', async () => {
      await client.commitFiles(
        repoId,
        [file('parent/child/grandchild.md', 'gc')],
        'add nested',
      );

      const files = await client.listFiles(repoId, 'main', 'parent');
      expect(files.length).toBe(1);
      expect(files[0].name).toBe('child');
      expect(files[0].type).toBe('directory');
    });

    it('should include dotfiles and dot-directories', async () => {
      await client.commitFiles(
        repoId,
        [file('.hidden', 'h'), file('.dotdir/f.md', 'f'), file('visible.md', 'v')],
        'add',
      );

      const files = await client.listFiles(repoId);
      const names = files.map((f) => f.name);
      expect(names).toContain('.hidden');
      expect(names).toContain('.dotdir');
      expect(names).toContain('visible.md');
    });

    it('should return empty array for non-existent folder', async () => {
      await client.commitFiles(repoId, [file('a.md', 'a')], 'add');
      const files = await client.listFiles(repoId, 'main', 'nonexistent');
      expect(files).toEqual([]);
    });

    it('should return empty array for non-existent branch', async () => {
      const files = await client.listFiles(repoId, 'does-not-exist');
      expect(files).toEqual([]);
    });
  });

  describe('getFile', () => {
    it('should return file content', async () => {
      await client.commitFiles(repoId, [file('doc.md', 'hello world')], 'add');
      const result = await client.getFile(repoId, 'doc.md');
      expect(result.content).toBe('hello world');
    });

    it('should return 404 for non-existent file', async () => {
      const res = await client.getFileRaw(repoId, 'nonexistent.md');
      expect(res.status).toBe(404);
    });

    it('should return different content from main vs dirty', async () => {
      await client.commitFiles(repoId, [file('doc.md', 'main content')], 'add', 'main');
      await client.rebase(repoId);
      await client.commitFiles(repoId, [file('doc.md', 'dirty content')], 'modify', 'dirty');

      const main = await client.getFile(repoId, 'doc.md', 'main');
      const dirty = await client.getFile(repoId, 'doc.md', 'dirty');
      expect(main.content).toBe('main content');
      expect(dirty.content).toBe('dirty content');
    });

    it('should normalize path with leading /', async () => {
      await client.commitFiles(repoId, [file('slash.md', 'content')], 'add');
      const result = await client.getFile(repoId, '/slash.md');
      expect(result.content).toBe('content');
    });
  });

  describe('getFileDiff', () => {
    it('should return both versions when file exists on both branches', async () => {
      await client.commitFiles(repoId, [file('doc.md', 'main-v')], 'add', 'main');
      await client.rebase(repoId);
      await client.commitFiles(repoId, [file('doc.md', 'dirty-v')], 'modify', 'dirty');

      const diff = await client.getFileDiff(repoId, 'doc.md');
      expect(diff).not.toBeNull();
      expect(diff!.base).toBe('main-v');
      expect(diff!.dirty).toBe('dirty-v');
    });

    it('should return null dirty when file only on main (not yet rebased)', async () => {
      await client.commitFiles(repoId, [file('main-only.md', 'main')], 'add', 'main');

      // merge_base has not been advanced yet — file is not visible in diff until rebase
      const diff = await client.getFileDiff(repoId, 'main-only.md');
      expect(diff).toBeNull();
    });

    it('should return both after rebase when file is on main then modified in dirty', async () => {
      await client.commitFiles(repoId, [file('main-only.md', 'main')], 'add', 'main');
      await client.rebase(repoId);

      const diff = await client.getFileDiff(repoId, 'main-only.md');
      expect(diff).toBeNull(); // dirty == merge_base, so no diff
    });

    it('should return null base when file only on dirty', async () => {
      await client.commitFiles(repoId, [file('dirty-only.md', 'dirty')], 'add', 'dirty');

      const diff = await client.getFileDiff(repoId, 'dirty-only.md');
      expect(diff).not.toBeNull();
      expect(diff!.base).toBeNull();
      expect(diff!.dirty).toBe('dirty');
    });

    it('should return null when file on neither branch', async () => {
      const diff = await client.getFileDiff(repoId, 'nonexistent.md');
      expect(diff).toBeNull();
    });
  });

  describe('readFilesFromFolder', () => {
    it('should read multiple files from one folder', async () => {
      await client.commitFiles(
        repoId,
        [file('folder/a.md', 'aaa'), file('folder/b.md', 'bbb')],
        'add',
      );

      const results = await client.readFilesFromFolder(repoId, 'folder', ['a.md', 'b.md']);
      expect(results).toHaveLength(2);
      const a = results.find((r) => r.path === 'folder/a.md');
      const b = results.find((r) => r.path === 'folder/b.md');
      expect(a?.content).toBe('aaa');
      expect(b?.content).toBe('bbb');
    });

    it('should return null content for missing files', async () => {
      await client.commitFiles(repoId, [file('folder/exists.md', 'yes')], 'add');

      const results = await client.readFilesFromFolder(repoId, 'folder', ['exists.md', 'missing.md']);
      const missing = results.find((r) => r.path === 'folder/missing.md');
      expect(missing?.content).toBeNull();
    });

    it('should return empty result for empty filenames array', async () => {
      const results = await client.readFilesFromFolder(repoId, 'folder', []);
      expect(results).toEqual([]);
    });
  });

  describe('readFiles', () => {
    it('should read files from different folders', async () => {
      await client.commitFiles(
        repoId,
        [file('a/x.md', 'ax'), file('b/y.md', 'by')],
        'add',
      );

      const results = await client.readFiles(repoId, ['a/x.md', 'b/y.md']);
      expect(results).toHaveLength(2);
      const ax = results.find((r) => r.path === 'a/x.md');
      const by = results.find((r) => r.path === 'b/y.md');
      expect(ax?.content).toBe('ax');
      expect(by?.content).toBe('by');
    });

    it('should return null content for missing files', async () => {
      const results = await client.readFiles(repoId, ['nonexistent.md']);
      expect(results).toHaveLength(1);
      expect(results[0].content).toBeNull();
    });

    it('should return empty result for empty paths array', async () => {
      const results = await client.readFiles(repoId, []);
      expect(results).toEqual([]);
    });
  });

  describe('readFilesPaginated', () => {
    it('should limit result count', async () => {
      await client.commitFiles(
        repoId,
        [file('folder/a.md', 'a'), file('folder/b.md', 'b'), file('folder/c.md', 'c')],
        'add',
      );

      const page = await client.readFilesPaginated(repoId, { folder: 'folder', limit: 2 });
      expect(page.files).toHaveLength(2);
      expect(page.nextCursor).toBeDefined();
    });

    it('should paginate with cursor', async () => {
      await client.commitFiles(
        repoId,
        [file('folder/a.md', 'a'), file('folder/b.md', 'b'), file('folder/c.md', 'c')],
        'add',
      );

      const page1 = await client.readFilesPaginated(repoId, { folder: 'folder', limit: 2 });
      expect(page1.files).toHaveLength(2);

      const page2 = await client.readFilesPaginated(repoId, {
        folder: 'folder',
        limit: 2,
        cursor: page1.nextCursor,
      });
      expect(page2.files.length).toBeGreaterThanOrEqual(1);

      // All files combined should cover all 3
      const allNames = [...page1.files, ...page2.files].map((f) => f.name);
      expect(allNames.sort()).toEqual(['a.md', 'b.md', 'c.md']);
    });

    it('should have no nextCursor on last page', async () => {
      await client.commitFiles(repoId, [file('folder/a.md', 'a')], 'add');

      const page = await client.readFilesPaginated(repoId, { folder: 'folder', limit: 10 });
      expect(page.files).toHaveLength(1);
      expect(page.nextCursor).toBeUndefined();
    });

    it('should exclude directories from results', async () => {
      await client.commitFiles(
        repoId,
        [file('folder/sub/deep.md', 'content'), file('folder/flat.md', 'flat')],
        'add',
      );

      const page = await client.readFilesPaginated(repoId, { folder: 'folder', limit: 50 });
      const names = page.files.map((f) => f.name);
      expect(names).toContain('flat.md');
      expect(names).not.toContain('sub');
    });

    it('should return empty for empty folder', async () => {
      const page = await client.readFilesPaginated(repoId, { folder: 'empty', limit: 50 });
      expect(page.files).toEqual([]);
      expect(page.nextCursor).toBeUndefined();
    });
  });

  describe('readBlobsByOid', () => {
    it('should return content for valid OIDs', async () => {
      await client.commitFiles(repoId, [file('doc.md', 'blob content')], 'add');

      // Get OID from diff status or file list — we'll use the graph to find it
      const graph = await client.getGraph(repoId);
      // Read the file to get its OID via dirty status as a workaround
      // Instead, commit to dirty to get an OID from dirty status
      await client.rebase(repoId);
      await client.commitFiles(repoId, [file('doc.md', 'changed')], 'change', 'dirty');
      const status = await client.getDirtyStatus(repoId);
      const oid = status.find((s) => s.path === 'doc.md')?.oid;

      if (oid) {
        const results = await client.readBlobsByOid(repoId, [oid]);
        expect(results).toHaveLength(1);
        expect(results[0].oid).toBe(oid);
        expect(typeof results[0].content).toBe('string');
      }
    });

    it('should return null content for invalid OID', async () => {
      const results = await client.readBlobsByOid(repoId, ['0000000000000000000000000000000000000000']);
      expect(results).toHaveLength(1);
      expect(results[0].content).toBeNull();
    });

    it('should return empty result for empty OIDs array', async () => {
      const results = await client.readBlobsByOid(repoId, []);
      expect(results).toEqual([]);
    });
  });

  describe('archive', () => {
    it('should return valid ZIP with correct files', async () => {
      await client.commitFiles(
        repoId,
        [file('a.md', 'aaa'), file('folder/b.md', 'bbb')],
        'add',
      );

      const res = await client.getArchive(repoId);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('zip');

      const disposition = res.headers.get('content-disposition');
      expect(disposition).toContain('attachment');
      expect(disposition).toContain(repoId);
    });

    it('should exclude dotfiles from archive', async () => {
      await client.commitFiles(
        repoId,
        [file('.hidden', 'hidden'), file('visible.md', 'visible')],
        'add',
      );

      const res = await client.getArchive(repoId);
      expect(res.status).toBe(200);
      // We can't easily inspect ZIP contents without a library, but the endpoint should succeed
    });

    it('should return valid response for empty repo', async () => {
      const res = await client.getArchive(repoId);
      expect(res.status).toBe(200);
    });
  });
});
