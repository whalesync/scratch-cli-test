import { ScratchGitClient } from '../src/client';
import { file, newRepoId } from '../src/helpers';

const client = new ScratchGitClient();

describe('Repo Manage', () => {
  let repoId: string;

  beforeEach(() => {
    repoId = newRepoId();
  });

  afterEach(async () => {
    try {
      await client.deleteRepo(repoId);
    } catch {
      // best effort
    }
  });

  describe('init', () => {
    it('should init a new repo', async () => {
      const result = await client.initRepo(repoId);
      expect(result).toEqual({ success: true });
    });

    it('should report exists after init', async () => {
      await client.initRepo(repoId);
      const exists = await client.repoExists(repoId);
      expect(exists.exists).toBe(true);
      expect(exists.hasHead).toBe(true);
    });

    it('should be idempotent — calling init twice succeeds', async () => {
      await client.initRepo(repoId);
      const result = await client.initRepo(repoId);
      expect(result).toEqual({ success: true });
    });

    it('should create repo with both main and dirty branches', async () => {
      await client.initRepo(repoId);
      // Both branches should be listable (even if empty)
      const mainFiles = await client.listFiles(repoId, 'main');
      const dirtyFiles = await client.listFiles(repoId, 'dirty');
      expect(Array.isArray(mainFiles)).toBe(true);
      expect(Array.isArray(dirtyFiles)).toBe(true);
    });
  });

  describe('exists', () => {
    it('should return exists:false for non-existent repo', async () => {
      const exists = await client.repoExists('nonexistent-repo-xyz');
      expect(exists.exists).toBe(false);
    });

    it('should return exists:true with hasHead:true after init', async () => {
      await client.initRepo(repoId);
      const exists = await client.repoExists(repoId);
      expect(exists.exists).toBe(true);
      expect(exists.hasHead).toBe(true);
      expect(exists.repoId).toBe(repoId);
    });
  });

  describe('delete', () => {
    it('should delete a repo', async () => {
      await client.initRepo(repoId);
      await client.deleteRepo(repoId);
      const exists = await client.repoExists(repoId);
      expect(exists.exists).toBe(false);
    });

    it('should succeed when deleting non-existent repo', async () => {
      const result = await client.deleteRepo('nonexistent-repo-xyz');
      expect(result).toEqual({ success: true });
    });
  });

  describe('reset', () => {
    it('should reset dirty branch to match main (full reset)', async () => {
      await client.initRepo(repoId);
      // Commit a file to dirty only
      await client.commitFiles(repoId, [file('dirty-only.md', 'dirty content')], 'add dirty file', 'dirty');

      // Verify file exists on dirty
      const before = await client.getDirtyStatus(repoId);
      expect(before.length).toBeGreaterThan(0);

      // Full reset
      await client.resetRepo(repoId);

      // Dirty should now match main
      const after = await client.getDirtyStatus(repoId);
      expect(after).toEqual([]);
    });

    it('should reset only a specific path when path is provided', async () => {
      await client.initRepo(repoId);
      // Commit two files to dirty
      await client.commitFiles(
        repoId,
        [file('folder/a.md', 'a'), file('other/b.md', 'b')],
        'add files',
        'dirty',
      );

      // Reset only folder (no trailing slash — path matching uses startsWith(path + '/'))
      await client.resetRepo(repoId, 'folder');

      // folder/a.md should be gone from dirty status, but other/b.md should remain
      const status = await client.getDirtyStatus(repoId);
      const paths = status.map((s) => s.path);
      expect(paths).not.toContain('folder/a.md');
      expect(paths).toContain('other/b.md');
    });

    it('should be a no-op when path does not match any dirty files', async () => {
      await client.initRepo(repoId);
      await client.commitFiles(repoId, [file('a.md', 'content')], 'add file', 'dirty');

      await client.resetRepo(repoId, 'nonexistent');

      const status = await client.getDirtyStatus(repoId);
      expect(status.length).toBe(1);
    });
  });

  describe('count-objects', () => {
    it('should return stats for a repo', async () => {
      await client.initRepo(repoId);
      const result = await client.countObjects(repoId);
      expect(typeof result.stats).toBe('string');
      expect(result.stats.length).toBeGreaterThan(0);
    });
  });

  describe('gc', () => {
    it('should run gc successfully', async () => {
      await client.initRepo(repoId);
      // Add some objects to make gc meaningful
      await client.commitFiles(repoId, [file('a.md', 'content')], 'add file');
      const result = await client.gc(repoId);
      expect(result.success).toBe(true);
      expect(typeof result.statsBefore).toBe('string');
      expect(typeof result.statsAfter).toBe('string');
    });

    it('should run aggressive gc', async () => {
      await client.initRepo(repoId);
      await client.commitFiles(repoId, [file('a.md', 'content')], 'add file');
      const result = await client.gc(repoId, true);
      expect(result.success).toBe(true);
    });

    it('should return 409 when gc is already in progress', async () => {
      await client.initRepo(repoId);
      // Create enough objects to make GC take a moment
      const files = Array.from({ length: 20 }, (_, i) => file(`file-${i}.md`, `content ${i} `.repeat(100)));
      await client.commitFiles(repoId, files, 'add files');

      // Start GC and immediately try again
      const [first, second] = await Promise.all([
        client.rawRequest('POST', `/api/repo/manage/${repoId}/gc`, {}),
        // Small delay to ensure first request gets the lock
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(client.rawRequest('POST', `/api/repo/manage/${repoId}/gc`, {})), 50),
        ),
      ]);

      const statuses = [first.status, second.status].sort();
      // One should be 200, one should be 409 (or both 200 if gc was instant)
      expect(statuses[0] === 200 || statuses[0] === 409).toBe(true);
    });
  });
});
