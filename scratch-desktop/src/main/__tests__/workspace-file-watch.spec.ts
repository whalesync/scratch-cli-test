import { mkdir, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveWorkspaceWatchRoots, shouldIgnoreWorkspaceWatchPath } from '../workspace-file-watch';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await import('fs/promises').then(({ rm }) => rm(dir, { recursive: true, force: true }));
    }),
  );
});

describe('workspace file watch helpers', () => {
  it('ignores scratch internals, dotfiles, and editor temp files', () => {
    expect(shouldIgnoreWorkspaceWatchPath('/tmp/workspace/.scratch/.scratchmd')).toBe(true);
    expect(shouldIgnoreWorkspaceWatchPath('/tmp/workspace/conn/.git/index')).toBe(true);
    expect(shouldIgnoreWorkspaceWatchPath('/tmp/workspace/conn/.DS_Store')).toBe(true);
    expect(shouldIgnoreWorkspaceWatchPath('/tmp/workspace/conn/post-1.json.swp')).toBe(true);
    expect(shouldIgnoreWorkspaceWatchPath('/tmp/workspace/conn/public/post-1.json')).toBe(false);
  });

  it('resolves only existing unique connection roots', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'spinner-watch-'));
    tempDirs.push(workspaceRoot);

    await mkdir(join(workspaceRoot, 'Connection A'), { recursive: true });
    await mkdir(join(workspaceRoot, 'Connection B'), { recursive: true });

    const roots = await resolveWorkspaceWatchRoots(workspaceRoot, [
      { dirName: 'Connection B' },
      { dirName: 'Connection A' },
      { dirName: 'Connection A' },
      { dirName: 'Missing Connection' },
    ]);

    expect(roots).toEqual([join(workspaceRoot, 'Connection A'), join(workspaceRoot, 'Connection B')]);
  });
});
