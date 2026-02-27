import { ScratchGitClient } from '../src/client';
import { file, newRepoId } from '../src/helpers';

const client = new ScratchGitClient();

describe('Repo Rebase', () => {
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

  describe('fast-forward cases', () => {
    it('should be a no-op when dirty == main (same commit)', async () => {
      const result = await client.rebase(repoId);
      expect(result.rebased).toBe(true);
      expect(result.conflicts).toEqual([]);
    });

    it('should fast-forward dirty when main advanced and dirty unchanged', async () => {
      // Add file to main
      await client.commitFiles(repoId, [file('new.md', 'content')], 'add to main', 'main');

      // Rebase dirty onto main
      const result = await client.rebase(repoId);
      expect(result.rebased).toBe(true);

      // Dirty should now have the file
      const dirty = await client.getFile(repoId, 'new.md', 'dirty');
      expect(dirty.content).toBe('content');
    });

    it('should fast-forward when no user changes after merge base', async () => {
      // Set up initial state on both branches
      await client.commitFiles(repoId, [file('base.md', 'base')], 'add base', 'main');
      await client.rebase(repoId);

      // Only advance main
      await client.commitFiles(repoId, [file('main-only.md', 'main')], 'add on main', 'main');

      const result = await client.rebase(repoId);
      expect(result.rebased).toBe(true);

      // Dirty should have both files
      const base = await client.getFile(repoId, 'base.md', 'dirty');
      const mainOnly = await client.getFile(repoId, 'main-only.md', 'dirty');
      expect(base.content).toBe('base');
      expect(mainOnly.content).toBe('main');
    });
  });

  describe('merge cases — diff3 strategy (default)', () => {
    it('should merge non-conflicting changes on different files', async () => {
      // Base state
      await client.commitFiles(repoId, [file('shared.md', 'shared')], 'base', 'main');
      await client.rebase(repoId);

      // Main adds a file
      await client.commitFiles(repoId, [file('main-new.md', 'from main')], 'main add', 'main');
      // Dirty adds a different file
      await client.commitFiles(repoId, [file('dirty-new.md', 'from dirty')], 'dirty add', 'dirty');

      const result = await client.rebase(repoId);
      expect(result.rebased).toBe(true);
      expect(result.conflicts).toEqual([]);

      // Both files should be present on dirty
      const mainNew = await client.getFile(repoId, 'main-new.md', 'dirty');
      const dirtyNew = await client.getFile(repoId, 'dirty-new.md', 'dirty');
      expect(mainNew.content).toBe('from main');
      expect(dirtyNew.content).toBe('from dirty');
    });

    it('should merge non-conflicting changes on same file, different lines', async () => {
      const baseLine = 'line1\nline2\nline3\nline4\nline5\n';
      await client.commitFiles(repoId, [file('doc.md', baseLine)], 'base', 'main');
      await client.rebase(repoId);

      // Main changes first line
      await client.commitFiles(
        repoId,
        [file('doc.md', 'MAIN-CHANGED\nline2\nline3\nline4\nline5\n')],
        'main edit',
        'main',
      );
      // Dirty changes last line
      await client.commitFiles(
        repoId,
        [file('doc.md', 'line1\nline2\nline3\nline4\nDIRTY-CHANGED\n')],
        'dirty edit',
        'dirty',
      );

      const result = await client.rebase(repoId, 'diff3');
      expect(result.rebased).toBe(true);

      const merged = await client.getFile(repoId, 'doc.md', 'dirty');
      expect(merged.content).toContain('MAIN-CHANGED');
      expect(merged.content).toContain('DIRTY-CHANGED');
    });

    it('should resolve conflicts with dirty (user) side winning', async () => {
      await client.commitFiles(repoId, [file('doc.md', 'original')], 'base', 'main');
      await client.rebase(repoId);

      // Both change the same content
      await client.commitFiles(repoId, [file('doc.md', 'main version')], 'main edit', 'main');
      await client.commitFiles(repoId, [file('doc.md', 'dirty version')], 'dirty edit', 'dirty');

      const result = await client.rebase(repoId, 'diff3');
      expect(result.rebased).toBe(true);

      const merged = await client.getFile(repoId, 'doc.md', 'dirty');
      expect(merged.content).toBe('dirty version');
    });

    it('should always return empty conflicts array', async () => {
      await client.commitFiles(repoId, [file('doc.md', 'base')], 'base', 'main');
      await client.rebase(repoId);
      await client.commitFiles(repoId, [file('doc.md', 'main')], 'main', 'main');
      await client.commitFiles(repoId, [file('doc.md', 'dirty')], 'dirty', 'dirty');

      const result = await client.rebase(repoId, 'diff3');
      expect(result.conflicts).toEqual([]);
    });
  });

  describe('merge cases — ours strategy', () => {
    it('should keep dirty content as-is', async () => {
      await client.commitFiles(repoId, [file('doc.md', 'base')], 'base', 'main');
      await client.rebase(repoId);

      await client.commitFiles(repoId, [file('doc.md', 'main changed')], 'main', 'main');
      await client.commitFiles(repoId, [file('doc.md', 'dirty content')], 'dirty', 'dirty');

      const result = await client.rebase(repoId, 'ours');
      expect(result.rebased).toBe(true);

      const dirty = await client.getFile(repoId, 'doc.md', 'dirty');
      expect(dirty.content).toBe('dirty content');
    });

    it('should produce different results than diff3 for same-file non-conflicting edits', async () => {
      const baseLine = 'line1\nline2\nline3\nline4\nline5\n';
      const mainVersion = 'MAIN\nline2\nline3\nline4\nline5\n';
      const dirtyVersion = 'line1\nline2\nline3\nline4\nDIRTY\n';

      // Set up with diff3
      const diffRepoId = newRepoId();
      await client.initRepo(diffRepoId);
      await client.commitFiles(diffRepoId, [file('doc.md', baseLine)], 'base', 'main');
      await client.rebase(diffRepoId);
      await client.commitFiles(diffRepoId, [file('doc.md', mainVersion)], 'main', 'main');
      await client.commitFiles(diffRepoId, [file('doc.md', dirtyVersion)], 'dirty', 'dirty');
      await client.rebase(diffRepoId, 'diff3');
      const diff3Result = await client.getFile(diffRepoId, 'doc.md', 'dirty');
      await client.deleteRepo(diffRepoId);

      // Set up with ours
      const oursRepoId = newRepoId();
      await client.initRepo(oursRepoId);
      await client.commitFiles(oursRepoId, [file('doc.md', baseLine)], 'base', 'main');
      await client.rebase(oursRepoId);
      await client.commitFiles(oursRepoId, [file('doc.md', mainVersion)], 'main', 'main');
      await client.commitFiles(oursRepoId, [file('doc.md', dirtyVersion)], 'dirty', 'dirty');
      await client.rebase(oursRepoId, 'ours');
      const oursResult = await client.getFile(oursRepoId, 'doc.md', 'dirty');
      await client.deleteRepo(oursRepoId);

      // diff3 should include both MAIN and DIRTY changes
      expect(diff3Result.content).toContain('MAIN');
      expect(diff3Result.content).toContain('DIRTY');

      // ours should keep only dirty version (no MAIN)
      expect(oursResult.content).not.toContain('MAIN');
      expect(oursResult.content).toContain('DIRTY');
    });
  });

  describe('file additions/deletions', () => {
    it('should preserve file added on main and different file added on dirty', async () => {
      await client.commitFiles(repoId, [file('base.md', 'base')], 'base', 'main');
      await client.rebase(repoId);

      await client.commitFiles(repoId, [file('main-add.md', 'from main')], 'main add', 'main');
      await client.commitFiles(repoId, [file('dirty-add.md', 'from dirty')], 'dirty add', 'dirty');

      await client.rebase(repoId);

      const mainAdd = await client.getFile(repoId, 'main-add.md', 'dirty');
      const dirtyAdd = await client.getFile(repoId, 'dirty-add.md', 'dirty');
      expect(mainAdd.content).toBe('from main');
      expect(dirtyAdd.content).toBe('from dirty');
    });

    it('should keep dirty version when same file added on both branches', async () => {
      await client.commitFiles(repoId, [file('base.md', 'base')], 'base', 'main');
      await client.rebase(repoId);

      await client.commitFiles(repoId, [file('conflict.md', 'main version')], 'main add', 'main');
      await client.commitFiles(repoId, [file('conflict.md', 'dirty version')], 'dirty add', 'dirty');

      await client.rebase(repoId);

      const result = await client.getFile(repoId, 'conflict.md', 'dirty');
      expect(result.content).toBe('dirty version');
    });

    it('should keep both deleted when file deleted on both branches', async () => {
      await client.commitFiles(repoId, [file('shared.md', 'content')], 'add', 'main');
      await client.rebase(repoId);

      await client.deleteFiles(repoId, ['shared.md'], 'delete on main', 'main');
      await client.deleteFiles(repoId, ['shared.md'], 'delete on dirty', 'dirty');

      await client.rebase(repoId);

      const mainRes = await client.getFileRaw(repoId, 'shared.md', 'main');
      const dirtyRes = await client.getFileRaw(repoId, 'shared.md', 'dirty');
      expect(mainRes.status).toBe(404);
      expect(dirtyRes.status).toBe(404);
    });
  });

  describe('edge cases', () => {
    it('should rebase after publish — dirty rebased onto new main', async () => {
      // Publish a file
      await client.publishFile(repoId, file('pub.md', 'published'), 'publish');

      // Add a dirty change
      await client.commitFiles(repoId, [file('dirty-only.md', 'dirty')], 'dirty add', 'dirty');

      // Publish another file
      await client.publishFile(repoId, file('pub2.md', 'published 2'), 'publish 2');

      // Dirty should have all three files
      const pub = await client.getFile(repoId, 'pub.md', 'dirty');
      const pub2 = await client.getFile(repoId, 'pub2.md', 'dirty');
      const dirtyOnly = await client.getFile(repoId, 'dirty-only.md', 'dirty');
      expect(pub.content).toBe('published');
      expect(pub2.content).toBe('published 2');
      expect(dirtyOnly.content).toBe('dirty');
    });

    it('should handle large changeset (50+ files)', async () => {
      // Create base state
      await client.commitFiles(repoId, [file('base.md', 'base')], 'base', 'main');
      await client.rebase(repoId);

      // Add 50 files on main
      const mainFiles = Array.from({ length: 50 }, (_, i) => file(`main/file-${i}.md`, `main-${i}`));
      await client.commitFiles(repoId, mainFiles, 'add 50 main files', 'main');

      // Add 50 different files on dirty
      const dirtyFiles = Array.from({ length: 50 }, (_, i) => file(`dirty/file-${i}.md`, `dirty-${i}`));
      await client.commitFiles(repoId, dirtyFiles, 'add 50 dirty files', 'dirty');

      const result = await client.rebase(repoId);
      expect(result.rebased).toBe(true);

      // Verify some files from each side
      const m0 = await client.getFile(repoId, 'main/file-0.md', 'dirty');
      const d0 = await client.getFile(repoId, 'dirty/file-0.md', 'dirty');
      expect(m0.content).toBe('main-0');
      expect(d0.content).toBe('dirty-0');
    });
  });
});
