import { ScratchGitClient } from '../src/client';
import { file, newRepoId } from '../src/helpers';

const client = new ScratchGitClient();

describe('Repo Checkpoint', () => {
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

  describe('create', () => {
    it('should create checkpoint that appears in list', async () => {
      await client.commitFiles(repoId, [file('a.md', 'content')], 'add', 'main');
      await client.rebase(repoId);

      await client.createCheckpoint(repoId, 'cp1');

      const list = await client.listCheckpoints(repoId);
      const names = list.map((c) => c.name);
      expect(names).toContain('cp1');
    });

    it('should capture both main and dirty state', async () => {
      await client.commitFiles(repoId, [file('main.md', 'main-v1')], 'add main', 'main');
      await client.rebase(repoId);
      await client.commitFiles(repoId, [file('dirty.md', 'dirty-v1')], 'add dirty', 'dirty');

      await client.createCheckpoint(repoId, 'snapshot');

      // Modify both branches
      await client.commitFiles(repoId, [file('main.md', 'main-v2')], 'update main', 'main');
      await client.commitFiles(repoId, [file('dirty.md', 'dirty-v2')], 'update dirty', 'dirty');

      // Revert to checkpoint
      await client.revertToCheckpoint(repoId, 'snapshot');

      const main = await client.getFile(repoId, 'main.md', 'main');
      const dirty = await client.getFile(repoId, 'dirty.md', 'dirty');
      expect(main.content).toBe('main-v1');
      expect(dirty.content).toBe('dirty-v1');
    });

    it('should allow recreating checkpoint after deleting previous one with same name', async () => {
      await client.commitFiles(repoId, [file('doc.md', 'v1')], 'v1', 'main');
      await client.rebase(repoId);
      await client.createCheckpoint(repoId, 'dup');

      // Delete and recreate with updated state
      await client.deleteCheckpoint(repoId, 'dup');
      await client.commitFiles(repoId, [file('doc.md', 'v2')], 'v2', 'main');
      await client.rebase(repoId);
      await client.createCheckpoint(repoId, 'dup');

      // Modify and revert — should get v2, not v1
      await client.commitFiles(repoId, [file('doc.md', 'v3')], 'v3', 'main');
      await client.revertToCheckpoint(repoId, 'dup');

      const result = await client.getFile(repoId, 'doc.md', 'main');
      expect(result.content).toBe('v2');
    });
  });

  describe('list', () => {
    it('should return empty list for fresh repo', async () => {
      const list = await client.listCheckpoints(repoId);
      expect(list).toEqual([]);
    });

    it('should list multiple checkpoints with metadata', async () => {
      await client.commitFiles(repoId, [file('a.md', 'a')], 'first commit', 'main');
      await client.rebase(repoId);
      await client.createCheckpoint(repoId, 'cp1');

      await client.commitFiles(repoId, [file('b.md', 'b')], 'second commit', 'main');
      await client.rebase(repoId);
      await client.createCheckpoint(repoId, 'cp2');

      const list = await client.listCheckpoints(repoId);
      expect(list.length).toBeGreaterThanOrEqual(2);

      for (const cp of list) {
        expect(typeof cp.name).toBe('string');
        expect(typeof cp.timestamp).toBe('number');
        expect(typeof cp.message).toBe('string');
      }
    });
  });

  describe('revert', () => {
    it('should restore main branch to checkpoint state', async () => {
      await client.commitFiles(repoId, [file('doc.md', 'checkpoint-state')], 'add', 'main');
      await client.rebase(repoId);
      await client.createCheckpoint(repoId, 'restore-point');

      await client.commitFiles(repoId, [file('doc.md', 'after-checkpoint')], 'update', 'main');

      await client.revertToCheckpoint(repoId, 'restore-point');

      const result = await client.getFile(repoId, 'doc.md', 'main');
      expect(result.content).toBe('checkpoint-state');
    });

    it('should restore dirty branch to checkpoint state', async () => {
      await client.commitFiles(repoId, [file('dirty.md', 'checkpoint-dirty')], 'add', 'dirty');
      await client.createCheckpoint(repoId, 'restore-point');

      await client.commitFiles(repoId, [file('dirty.md', 'after-checkpoint')], 'update', 'dirty');

      await client.revertToCheckpoint(repoId, 'restore-point');

      const result = await client.getFile(repoId, 'dirty.md', 'dirty');
      expect(result.content).toBe('checkpoint-dirty');
    });

    it('should return error for non-existent checkpoint', async () => {
      const res = await client.rawRequest('POST', `/api/repo/checkpoint/${repoId}/revert`, {
        name: 'nonexistent',
      });
      expect(res.status).toBe(500);
    });
  });

  describe('delete', () => {
    it('should remove checkpoint from list', async () => {
      await client.commitFiles(repoId, [file('a.md', 'a')], 'add', 'main');
      await client.rebase(repoId);
      await client.createCheckpoint(repoId, 'to-delete');

      await client.deleteCheckpoint(repoId, 'to-delete');

      const list = await client.listCheckpoints(repoId);
      const names = list.map((c) => c.name);
      expect(names).not.toContain('to-delete');
    });

    it('should succeed when deleting non-existent checkpoint (idempotent)', async () => {
      const result = await client.deleteCheckpoint(repoId, 'nonexistent');
      expect(result).toEqual({ success: true });
    });
  });
});
