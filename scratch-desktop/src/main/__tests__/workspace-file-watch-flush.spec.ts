/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceFilesChangedEvent } from '../../shared/workspace-file-watch';
import { WorkspaceFileWatchService } from '../workspace-file-watch';

// Mock runScratchmd so validation tests don't spawn the CLI binary.
vi.mock('../scratchmd', () => ({
  runScratchmd: vi.fn().mockResolvedValue(undefined),
}));

// ─── flush payload helpers ────────────────────────────────────────────────────

function makeService() {
  const service = new WorkspaceFileWatchService();
  const received: WorkspaceFilesChangedEvent[] = [];

  const mockSubscriber = {
    isDestroyed: () => false,
    send: (_channel: string, payload: WorkspaceFilesChangedEvent) => {
      received.push(payload);
    },
  } as unknown as WebContents;

  // Bypass watchWorkspaceFiles (which starts chokidar) — wire up state directly.
  (service as any).subscriber = mockSubscriber;
  (service as any).activeWorkspacePath = '/workspace';

  function addPaths(paths: string[], external = true) {
    for (const p of paths) (service as any).pendingPaths.add(p);
    if (external) (service as any).pendingHasExternal = true;
  }

  function flush(): WorkspaceFilesChangedEvent {
    (service as any).flushPendingChanges();
    return received[received.length - 1];
  }

  return { service, received, addPaths, flush };
}

// ─── singleFile ───────────────────────────────────────────────────────────────

describe('WorkspaceFileWatchService — flushPendingChanges payload', () => {
  it('sets singleFile when exactly one path changed', () => {
    const { addPaths, flush } = makeService();
    addPaths(['/workspace/conn/a.json']);
    expect(flush().singleFile).toBe('/workspace/conn/a.json');
  });

  it('leaves singleFile undefined when multiple paths changed', () => {
    const { addPaths, flush } = makeService();
    addPaths(['/workspace/conn/a.json', '/workspace/conn/b.json']);
    expect(flush().singleFile).toBeUndefined();
  });

  // ─── changedFolderPaths ─────────────────────────────────────────────────────

  it('sets changedFolderPaths to the parent dir of a single changed file', () => {
    const { addPaths, flush } = makeService();
    addPaths(['/workspace/conn/a.json']);
    expect(flush().changedFolderPaths).toEqual(['/workspace/conn']);
  });

  it('deduplicates changedFolderPaths when multiple files share a parent', () => {
    const { addPaths, flush } = makeService();
    addPaths(['/workspace/conn-a/a.json', '/workspace/conn-a/b.json', '/workspace/conn-b/c.json']);
    expect(flush().changedFolderPaths).toEqual(['/workspace/conn-a', '/workspace/conn-b']);
  });

  it('sorts changedFolderPaths lexicographically', () => {
    const { addPaths, flush } = makeService();
    addPaths(['/workspace/z/a.json', '/workspace/a/b.json', '/workspace/m/c.json']);
    expect(flush().changedFolderPaths).toEqual(['/workspace/a', '/workspace/m', '/workspace/z']);
  });

  // ─── source classification ──────────────────────────────────────────────────

  it('sets source to "external" when pendingHasExternal is true', () => {
    const { addPaths, flush } = makeService();
    addPaths(['/workspace/conn/a.json'], true);
    expect(flush().source).toBe('external');
  });

  it('sets source to "internal" when pendingHasExternal is false', () => {
    const { addPaths, flush } = makeService();
    addPaths(['/workspace/conn/a.json'], false);
    expect(flush().source).toBe('internal');
  });

  it('includes workspacePath in the payload', () => {
    const { addPaths, flush } = makeService();
    addPaths(['/workspace/conn/a.json']);
    expect(flush().workspacePath).toBe('/workspace');
  });

  it('sends nothing when there are no pending paths', () => {
    const { received, flush } = makeService();
    flush();
    expect(received).toHaveLength(0);
  });
});

// ─── dirty-flag concurrency ───────────────────────────────────────────────────

describe('WorkspaceFileWatchService — runValidationForPaths dirty flag', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('runs validation immediately when idle', async () => {
    const { runScratchmd } = await import('../scratchmd');
    vi.mocked(runScratchmd).mockResolvedValue(undefined);

    const service = new WorkspaceFileWatchService();
    await service.runValidationForPaths('/workspace', ['/workspace/conn-a']);

    expect(vi.mocked(runScratchmd)).toHaveBeenCalledOnce();
    expect(vi.mocked(runScratchmd)).toHaveBeenCalledWith(
      ['refresh-record-index', '--path', '/workspace/conn-a'],
      '/workspace',
    );
  });

  it('queues a second call that arrives while the first is running, then drains', async () => {
    const { runScratchmd } = await import('../scratchmd');

    let firstResolve!: () => void;
    vi.mocked(runScratchmd)
      .mockImplementationOnce(() => new Promise<void>((r) => (firstResolve = r)))
      .mockResolvedValueOnce(undefined);

    const service = new WorkspaceFileWatchService();

    // Start first run — does not complete yet.
    const firstRun = service.runValidationForPaths('/workspace', ['/workspace/conn-a']);

    // Second call arrives while first is in-flight — should be queued, not dropped.
    void service.runValidationForPaths('/workspace', ['/workspace/conn-b']);

    // Only the first CLI call should have started.
    expect(vi.mocked(runScratchmd)).toHaveBeenCalledTimes(1);

    // Unblock the first run.
    firstResolve();
    await firstRun;

    // After first completes the queued paths should have been drained.
    expect(vi.mocked(runScratchmd)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runScratchmd).mock.calls[1]).toEqual([
      ['refresh-record-index', '--path', '/workspace/conn-b'],
      '/workspace',
    ]);
  });

  it('merges multiple queued paths into one subsequent run', async () => {
    const { runScratchmd } = await import('../scratchmd');

    let firstResolve!: () => void;
    vi.mocked(runScratchmd)
      .mockImplementationOnce(() => new Promise<void>((r) => (firstResolve = r)))
      .mockResolvedValueOnce(undefined);

    const service = new WorkspaceFileWatchService();
    const firstRun = service.runValidationForPaths('/workspace', ['/workspace/conn-a']);

    // Two more calls arrive while first is in-flight.
    void service.runValidationForPaths('/workspace', ['/workspace/conn-b']);
    void service.runValidationForPaths('/workspace', ['/workspace/conn-c']);

    firstResolve();
    await firstRun;

    // Both queued paths should appear in a single second CLI invocation.
    expect(vi.mocked(runScratchmd)).toHaveBeenCalledTimes(2);
    const secondCallArgs = vi.mocked(runScratchmd).mock.calls[1][0];
    expect(secondCallArgs).toContain('/workspace/conn-b');
    expect(secondCallArgs).toContain('/workspace/conn-c');
  });
});
