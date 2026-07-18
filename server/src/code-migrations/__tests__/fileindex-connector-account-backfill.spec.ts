import { resolveFolderPathsToConnectorAccountIds } from '../fileindex-connector-account-backfill';

describe('resolveFolderPathsToConnectorAccountIds', () => {
  it('maps a folderPath owned by exactly one connection (leading slash stripped)', () => {
    const { unambiguousFolderPathToConnectorAccountId, ambiguousFolderPaths } = resolveFolderPathsToConnectorAccountIds(
      [
        { path: '/Contacts', connectorAccountId: 'coa_hubspot' },
        { path: '/Companies', connectorAccountId: 'coa_hubspot' },
      ],
    );

    expect(ambiguousFolderPaths.size).toBe(0);
    expect(unambiguousFolderPathToConnectorAccountId.get('Contacts')).toBe('coa_hubspot');
    expect(unambiguousFolderPathToConnectorAccountId.get('Companies')).toBe('coa_hubspot');
  });

  it('marks a folderPath shared by two connections as ambiguous and excludes it', () => {
    const { unambiguousFolderPathToConnectorAccountId, ambiguousFolderPaths } = resolveFolderPathsToConnectorAccountIds(
      [
        { path: '/Contacts', connectorAccountId: 'coa_hubspot' },
        { path: '/Contacts', connectorAccountId: 'coa_hubspot_testing' },
        { path: '/Deals', connectorAccountId: 'coa_hubspot' },
      ],
    );

    expect(ambiguousFolderPaths.has('Contacts')).toBe(true);
    expect(unambiguousFolderPathToConnectorAccountId.has('Contacts')).toBe(false);
    // The non-shared folder is still resolved.
    expect(unambiguousFolderPathToConnectorAccountId.get('Deals')).toBe('coa_hubspot');
  });

  it('ignores folders with no path or no connection (e.g. scratch folders)', () => {
    const { unambiguousFolderPathToConnectorAccountId } = resolveFolderPathsToConnectorAccountIds([
      { path: null, connectorAccountId: 'coa_hubspot' },
      { path: '/Scratch', connectorAccountId: null },
      { path: '/Contacts', connectorAccountId: 'coa_hubspot' },
    ]);

    expect(unambiguousFolderPathToConnectorAccountId.size).toBe(1);
    expect(unambiguousFolderPathToConnectorAccountId.get('Contacts')).toBe('coa_hubspot');
  });
});
