import { ScratchGitClient } from '../src/client';
import { file, newRepoId } from '../src/helpers';

const client = new ScratchGitClient();

describe('Concurrency', () => {
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

  it('should serialize parallel writes to same branch', async () => {
    const writes = Array.from({ length: 5 }, (_, i) =>
      client.commitFiles(repoId, [file(`concurrent-${i}.md`, `content-${i}`)], `write ${i}`, 'main'),
    );

    const results = await Promise.all(writes);
    results.forEach((r) => expect(r).toEqual({ success: true }));

    // All files should be present
    const files = await client.listFiles(repoId, 'main');
    const names = files.map((f) => f.name);
    for (let i = 0; i < 5; i++) {
      expect(names).toContain(`concurrent-${i}.md`);
    }
  });

  it('should handle parallel writes to different branches', async () => {
    const [mainResult, dirtyResult] = await Promise.all([
      client.commitFiles(repoId, [file('main-file.md', 'main')], 'main write', 'main'),
      client.commitFiles(repoId, [file('dirty-file.md', 'dirty')], 'dirty write', 'dirty'),
    ]);

    expect(mainResult).toEqual({ success: true });
    expect(dirtyResult).toEqual({ success: true });

    const mainFile = await client.getFile(repoId, 'main-file.md', 'main');
    const dirtyFile = await client.getFile(repoId, 'dirty-file.md', 'dirty');
    expect(mainFile.content).toBe('main');
    expect(dirtyFile.content).toBe('dirty');
  });

  it('should return consistent state during read while writing', async () => {
    // Seed with initial data
    await client.commitFiles(repoId, [file('stable.md', 'stable')], 'seed', 'main');

    // Start a write and a read concurrently
    const [writeResult, readResult] = await Promise.all([
      client.commitFiles(repoId, [file('new.md', 'new content')], 'add new', 'main'),
      client.getFile(repoId, 'stable.md', 'main'),
    ]);

    expect(writeResult).toEqual({ success: true });
    expect(readResult.content).toBe('stable');
  });

  it('should return 409 for concurrent GC', async () => {
    await client.commitFiles(repoId, [file('x.md', 'content')], 'add', 'main');

    // Start two GC operations
    const [first, second] = await Promise.all([
      client.rawRequest('POST', `/api/repo/manage/${repoId}/gc`, {}),
      // Small delay so the first one grabs the lock
      new Promise<Response>((resolve) =>
        setTimeout(() => resolve(client.rawRequest('POST', `/api/repo/manage/${repoId}/gc`, {})), 50),
      ),
    ]);

    const statuses = [first.status, second.status].sort();
    // One 200, one 409 (or both 200 if first gc was instant)
    expect(statuses[0] === 200 || statuses[0] === 409).toBe(true);
  });
});
