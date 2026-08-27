/**
 * DEV-11362 — single-folder (table-scoped) publish target resolution
 * (pure-logic tests).
 *
 * The load-bearing bits are the null-guards on `connectorAccountId` and `path`
 * (a folder missing either must resolve to `ok:false` so "Publish this table"
 * is disabled rather than publishing nothing) and that the connection name is
 * derived from the workspace-relative path's first segment.
 */

import { DataFolder } from '@spinner/shared-types';
import { describe, expect, it } from 'vitest';
import { resolveSingleFolderPublishTarget } from '../single-folder-publish-target';

// Only `connectorAccountId` + `path` are read; cast minimal fixtures.
const folder = (
  connectorAccountId: string | null,
  path: string | null,
): Pick<DataFolder, 'connectorAccountId' | 'path'> => ({
  connectorAccountId,
  path,
});

describe('resolveSingleFolderPublishTarget', () => {
  it('resolves a mapped folder node into a table publish target', () => {
    const result = resolveSingleFolderPublishTarget('Notion/People', 'People', folder('ca_notion', '/People'));
    expect(result).toEqual({
      ok: true,
      target: {
        connectionId: 'ca_notion',
        connectionName: 'Notion',
        folderWorkspaceRelativePath: 'Notion/People',
        folderRepoRelativePath: '/People',
        folderDisplayName: 'People',
      },
    });
  });

  it('derives the connection name from the first path segment (nested folder)', () => {
    const result = resolveSingleFolderPublishTarget(
      'Notion/Team/People',
      'People',
      folder('ca_notion', '/Team/People'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.connectionName).toBe('Notion');
    expect(result.target.folderRepoRelativePath).toBe('/Team/People');
  });

  it('errors when the folder has no connector account id (null)', () => {
    const result = resolveSingleFolderPublishTarget('Local/People', 'People', folder(null, '/People'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('No connector account id');
  });

  it('errors when the folder has no path', () => {
    const result = resolveSingleFolderPublishTarget('Notion/People', 'People', folder('ca_notion', null));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('No folder path');
  });

  it('errors on a top-level path with no connection segment', () => {
    const result = resolveSingleFolderPublishTarget('People', 'People', folder('ca_notion', '/People'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('not a table inside a connection');
  });
});
