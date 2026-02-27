import { ScratchGitClient } from '../src/client';
import { file, newRepoId } from '../src/helpers';

const client = new ScratchGitClient();

describe('Repo Debug', () => {
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

  describe('getGraph', () => {
    it('should return valid structure for fresh repo', async () => {
      const graph = await client.getGraph(repoId);
      expect(Array.isArray(graph.commits)).toBe(true);
      expect(Array.isArray(graph.refs)).toBe(true);

      // Should have at least the initial commit
      expect(graph.commits.length).toBeGreaterThanOrEqual(1);

      // Should have main and dirty refs
      const refNames = graph.refs.map((r) => r.name);
      expect(refNames).toContain('main');
      expect(refNames).toContain('dirty');
    });

    it('should show commit history with parent links', async () => {
      await client.commitFiles(repoId, [file('a.md', 'a')], 'first', 'main');
      await client.commitFiles(repoId, [file('b.md', 'b')], 'second', 'main');

      const graph = await client.getGraph(repoId);

      // Find 'second' commit — message may include trailing newline
      const second = graph.commits.find((c) => c.message.trim() === 'second');
      expect(second).toBeDefined();
      expect(second!.parents.length).toBeGreaterThanOrEqual(1);

      // Commits should have required fields
      for (const commit of graph.commits) {
        expect(typeof commit.oid).toBe('string');
        expect(typeof commit.message).toBe('string');
        expect(Array.isArray(commit.parents)).toBe(true);
        expect(typeof commit.timestamp).toBe('number');
        expect(typeof commit.author).toBe('object');
        expect(typeof commit.author.name).toBe('string');
        expect(typeof commit.author.email).toBe('string');
      }
    });

    it('should show tags after checkpoint', async () => {
      await client.commitFiles(repoId, [file('a.md', 'a')], 'add', 'main');
      await client.rebase(repoId);
      await client.createCheckpoint(repoId, 'test-cp');

      const graph = await client.getGraph(repoId);
      const tagRefs = graph.refs.filter((r) => r.type === 'tag');
      const tagNames = tagRefs.map((r) => r.name);
      expect(tagNames).toContain('main_test-cp');
      expect(tagNames).toContain('dirty_test-cp');
    });

    it('should show both main and dirty refs', async () => {
      const graph = await client.getGraph(repoId);
      const branchRefs = graph.refs.filter((r) => r.type === 'branch');
      const branchNames = branchRefs.map((r) => r.name);
      expect(branchNames).toContain('main');
      expect(branchNames).toContain('dirty');
    });
  });
});
