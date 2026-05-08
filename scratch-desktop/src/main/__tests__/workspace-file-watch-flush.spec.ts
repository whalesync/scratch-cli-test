/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import type { WebContents } from 'electron';
import { describe, expect, it } from 'vitest';
import type { WorkspaceFilesChangedEvent } from '../../shared/workspace-file-watch';
import { WorkspaceFileWatchService } from '../workspace-file-watch';

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
