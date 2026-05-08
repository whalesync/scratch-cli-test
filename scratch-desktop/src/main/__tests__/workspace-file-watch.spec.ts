import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceFileWatchService } from '../workspace-file-watch';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await import('fs/promises').then(({ rm }) => rm(dir, { recursive: true, force: true }));
    }),
  );
});

describe('WorkspaceFileWatchService', () => {
  it('watches exact folder paths and skips non-existent ones', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'spinner-watch-'));
    tempDirs.push(workspaceRoot);

    const folderA = join(workspaceRoot, 'conn', 'public', 'posts');
    await mkdir(folderA, { recursive: true });

    const service = new WorkspaceFileWatchService();
    const mockWebContents = { send: vi.fn(), isDestroyed: () => false } as never;

    const watched = await service.watchWorkspaceFiles(mockWebContents, workspaceRoot, [
      folderA,
      join(workspaceRoot, 'conn', 'public', 'missing'),
    ]);

    expect(watched).toEqual([folderA]);
    expect(service.getWatchedFolders()).toEqual([folderA]);

    service.clearWorkspaceFileWatch();
  });

  it('is a no-op if folder list has not changed', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'spinner-watch-'));
    tempDirs.push(workspaceRoot);

    const folderA = join(workspaceRoot, 'conn', 'posts');
    await mkdir(folderA, { recursive: true });

    const service = new WorkspaceFileWatchService();
    const mockWebContents = { send: vi.fn(), isDestroyed: () => false } as never;

    const first = await service.watchWorkspaceFiles(mockWebContents, workspaceRoot, [folderA]);
    const second = await service.watchWorkspaceFiles(mockWebContents, workspaceRoot, [folderA]);

    expect(first).toEqual([folderA]);
    expect(second).toEqual([folderA]);

    service.clearWorkspaceFileWatch();
  });

  it('fires a debounced IPC event when a file changes', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'spinner-watch-'));
    tempDirs.push(workspaceRoot);

    const folderA = join(workspaceRoot, 'conn', 'posts');
    await mkdir(folderA, { recursive: true });

    const service = new WorkspaceFileWatchService();
    const mockWebContents = { send: vi.fn(), isDestroyed: () => false } as never;

    await service.watchWorkspaceFiles(mockWebContents, workspaceRoot, [folderA]);

    await writeFile(join(folderA, 'test.json'), '{}');

    // wait for debounce
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(mockWebContents.send).toHaveBeenCalledWith(
      expect.stringContaining('workspace-files-changed'),
      expect.objectContaining({ workspacePath: workspaceRoot }),
    );

    service.clearWorkspaceFileWatch();
  });
});
