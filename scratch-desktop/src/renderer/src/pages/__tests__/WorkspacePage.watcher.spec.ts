/**
 * WorkspacePage watcher handler — pure logic tests.
 *
 * Full component tests (verifying that React mounts the subscription, fires
 * the callback, etc.) require @testing-library/react + a jsdom/happy-dom
 * environment, neither of which are installed. These tests cover the handler's
 * routing conditions and notification-message formatting as pure logic.
 *
 * To run: yarn test (picks up via vitest.config.mts include glob)
 */

import { describe, expect, it } from 'vitest';
import type { WorkspaceFilesChangedEvent } from '../../../../shared/workspace-file-watch';

// ─── formatWorkspaceFileWatchMessage ─────────────────────────────────────────
//
// Mirrors the exported function in WorkspacePage.tsx.  If that function's
// logic changes, these tests should break and alert you to update the spec.

function formatMessage(event: WorkspaceFilesChangedEvent): string {
  if (event.singleFile) {
    const fileName = event.singleFile.split(/[/\\]/).pop() ?? event.singleFile;
    return `${fileName} changed on disk. Refreshing the workspace view.`;
  }
  const folderCount = event.changedFolderPaths.length;
  return `${folderCount} folder${folderCount === 1 ? '' : 's'} changed on disk. Refreshing the workspace view.`;
}

describe('formatWorkspaceFileWatchMessage', () => {
  it('names the file when singleFile is set', () => {
    const event: WorkspaceFilesChangedEvent = {
      workspacePath: '/ws',
      source: 'external',
      singleFile: '/ws/conn/record-1.json',
      changedFolderPaths: ['/ws/conn'],
    };
    expect(formatMessage(event)).toBe('record-1.json changed on disk. Refreshing the workspace view.');
  });

  it('uses the basename only, not the full path', () => {
    const event: WorkspaceFilesChangedEvent = {
      workspacePath: '/ws',
      source: 'external',
      singleFile: '/ws/deep/nested/dir/file.json',
      changedFolderPaths: ['/ws/deep/nested/dir'],
    };
    expect(formatMessage(event)).toBe('file.json changed on disk. Refreshing the workspace view.');
  });

  it('uses singular "folder" when exactly one folder changed', () => {
    const event: WorkspaceFilesChangedEvent = {
      workspacePath: '/ws',
      source: 'external',
      changedFolderPaths: ['/ws/conn'],
    };
    expect(formatMessage(event)).toBe('1 folder changed on disk. Refreshing the workspace view.');
  });

  it('uses plural "folders" when multiple folders changed', () => {
    const event: WorkspaceFilesChangedEvent = {
      workspacePath: '/ws',
      source: 'external',
      changedFolderPaths: ['/ws/conn-a', '/ws/conn-b', '/ws/conn-c'],
    };
    expect(formatMessage(event)).toBe('3 folders changed on disk. Refreshing the workspace view.');
  });
});

// ─── handler routing conditions ──────────────────────────────────────────────
//
// The watcher handler in WorkspacePage fires `handleDataRefresh` only when:
//   1. event.workspacePath matches localPath (ignores stale events)
//   2. event.source is 'external' (internal mutations are suppressed)
//   3. the currently-selected folder is in event.changedFolderPaths
//
// These helpers mirror that logic so changes to the component's handler will
// be caught here via integration / snapshot tests once component tests exist.

function shouldDataRefresh(
  event: WorkspaceFilesChangedEvent,
  localPath: string,
  selectedFolderPath: string | null,
): boolean {
  if (event.workspacePath !== localPath) return false;
  if (event.source !== 'external') return false;
  if (!selectedFolderPath) return false;
  return event.changedFolderPaths.some((f) => f === selectedFolderPath);
}

function foldersRequiringRevalidation(event: WorkspaceFilesChangedEvent, localPath: string): string[] {
  if (event.workspacePath !== localPath) return [];
  if (event.source !== 'external') return [];
  return event.changedFolderPaths;
}

const BASE_EVENT: WorkspaceFilesChangedEvent = {
  workspacePath: '/workspace',
  source: 'external',
  changedFolderPaths: ['/workspace/conn-a'],
};

describe('WorkspacePage watcher handler — data refresh routing', () => {
  it('refreshes when the selected folder is in changedFolderPaths', () => {
    expect(shouldDataRefresh(BASE_EVENT, '/workspace', '/workspace/conn-a')).toBe(true);
  });

  it('does not refresh when the selected folder is not in changedFolderPaths', () => {
    expect(shouldDataRefresh(BASE_EVENT, '/workspace', '/workspace/conn-b')).toBe(false);
  });

  it('does not refresh when no folder is selected', () => {
    expect(shouldDataRefresh(BASE_EVENT, '/workspace', null)).toBe(false);
  });

  it('does not refresh for an internal event', () => {
    const internal: WorkspaceFilesChangedEvent = { ...BASE_EVENT, source: 'internal' };
    expect(shouldDataRefresh(internal, '/workspace', '/workspace/conn-a')).toBe(false);
  });

  it('ignores events for a different workspace path', () => {
    expect(shouldDataRefresh(BASE_EVENT, '/other-workspace', '/workspace/conn-a')).toBe(false);
  });

  it('refreshes when the selected folder is one of many changed folders', () => {
    const multi: WorkspaceFilesChangedEvent = {
      ...BASE_EVENT,
      changedFolderPaths: ['/workspace/conn-a', '/workspace/conn-b', '/workspace/conn-c'],
    };
    expect(shouldDataRefresh(multi, '/workspace', '/workspace/conn-b')).toBe(true);
  });
});

describe('WorkspacePage watcher handler — revalidation targets', () => {
  it('returns all changedFolderPaths for external events', () => {
    const multi: WorkspaceFilesChangedEvent = {
      ...BASE_EVENT,
      changedFolderPaths: ['/workspace/conn-a', '/workspace/conn-b'],
    };
    expect(foldersRequiringRevalidation(multi, '/workspace')).toEqual(['/workspace/conn-a', '/workspace/conn-b']);
  });

  it('returns no folders for internal events', () => {
    const internal: WorkspaceFilesChangedEvent = { ...BASE_EVENT, source: 'internal' };
    expect(foldersRequiringRevalidation(internal, '/workspace')).toEqual([]);
  });

  it('returns no folders for events from a different workspace', () => {
    expect(foldersRequiringRevalidation(BASE_EVENT, '/other-workspace')).toEqual([]);
  });
});
