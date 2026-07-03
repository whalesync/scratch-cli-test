import { describe, expect, it } from 'vitest';
import type { WorkspaceConnection } from '../../../../types/local-files';
import { deriveConnectorDisplayNameForFolder, folderLeafName } from '../derive-review-banner-context';

function connection(
  overrides: Partial<WorkspaceConnection> & Pick<WorkspaceConnection, 'dirName' | 'displayName'>,
): WorkspaceConnection {
  return { id: overrides.id ?? overrides.dirName, service: overrides.service ?? 'airtable', ...overrides };
}

const CONNECTIONS: WorkspaceConnection[] = [
  connection({ dirName: 'salesforce-tables', displayName: 'Salesforce (prod)', service: 'salesforce' }),
  connection({ dirName: 'webflow-cms', displayName: 'Marketing Site', service: 'webflow' }),
];

describe('deriveConnectorDisplayNameForFolder', () => {
  it('matches the first path segment against a connection dirName and returns its displayName', () => {
    expect(deriveConnectorDisplayNameForFolder('/salesforce-tables/deals', CONNECTIONS)).toBe('Salesforce (prod)');
  });

  it('uses only the FIRST segment even for deeply nested folder paths', () => {
    expect(deriveConnectorDisplayNameForFolder('/webflow-cms/collections/blog-posts', CONNECTIONS)).toBe(
      'Marketing Site',
    );
  });

  it('returns null when no connection dirName matches the first segment', () => {
    expect(deriveConnectorDisplayNameForFolder('/notion-pages/tasks', CONNECTIONS)).toBeNull();
  });

  it('returns null for a null or empty folder path', () => {
    expect(deriveConnectorDisplayNameForFolder(null, CONNECTIONS)).toBeNull();
    expect(deriveConnectorDisplayNameForFolder('', CONNECTIONS)).toBeNull();
    expect(deriveConnectorDisplayNameForFolder('/', CONNECTIONS)).toBeNull();
  });

  it('returns null when there are no connections', () => {
    expect(deriveConnectorDisplayNameForFolder('/salesforce-tables/deals', [])).toBeNull();
  });
});

describe('folderLeafName', () => {
  it('returns the last path segment', () => {
    expect(folderLeafName('/salesforce-tables/deals')).toBe('deals');
    expect(folderLeafName('/webflow-cms/collections/blog-posts')).toBe('blog-posts');
  });

  it('returns the only segment for a single-segment path', () => {
    expect(folderLeafName('/salesforce-tables')).toBe('salesforce-tables');
  });

  it('returns null for a null or empty path', () => {
    expect(folderLeafName(null)).toBeNull();
    expect(folderLeafName('')).toBeNull();
    expect(folderLeafName('/')).toBeNull();
  });
});
