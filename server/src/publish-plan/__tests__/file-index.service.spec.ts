import { DbService } from '../../db/db.service';
import { fileIndexLookupKey, FileIndexService, pickPreferredRecordId } from '../file-index.service';

describe('pickPreferredRecordId', () => {
  it('prefers the row belonging to the requested connection', () => {
    const rows = [
      { connectorAccountId: 'coa_a', recordId: 'rec_a' },
      { connectorAccountId: 'coa_b', recordId: 'rec_b' },
    ];
    expect(pickPreferredRecordId(rows, 'coa_a')).toBe('rec_a');
    expect(pickPreferredRecordId(rows, 'coa_b')).toBe('rec_b');
  });

  it('falls back to the first row when no connection is requested', () => {
    const rows = [
      { connectorAccountId: 'coa_a', recordId: 'rec_a' },
      { connectorAccountId: 'coa_b', recordId: 'rec_b' },
    ];
    expect(pickPreferredRecordId(rows, undefined)).toBe('rec_a');
    expect(pickPreferredRecordId(rows, null)).toBe('rec_a');
  });

  // A scoped lookup is a STRICT match (DEV-11242): neither another connection's row nor an
  // unscoped one can satisfy it. Resolving to either would hand the asking connection a
  // record id that belongs to someone else.
  it('returns null when the requested connection has no row, rather than taking an UNSCOPED one', () => {
    const rows = [{ connectorAccountId: null, recordId: 'legacy_rec' }];
    expect(pickPreferredRecordId(rows, 'coa_a')).toBeNull();
  });

  it('returns null when the requested connection has no row, rather than another connection’s', () => {
    const rows = [{ connectorAccountId: 'coa_b', recordId: 'rec_b' }];
    expect(pickPreferredRecordId(rows, 'coa_a')).toBeNull();
  });

  it('still resolves a connector-less (scratch) row for an unscoped lookup', () => {
    const rows = [{ connectorAccountId: null, recordId: 'rec_scratch' }];
    expect(pickPreferredRecordId(rows, undefined)).toBe('rec_scratch');
  });

  it('returns null for no rows at all', () => {
    expect(pickPreferredRecordId([], 'coa_a')).toBeNull();
    expect(pickPreferredRecordId([], undefined)).toBeNull();
  });
});

describe('FileIndexService.getRecordIds', () => {
  let service: FileIndexService;
  let fileIndexFindMany: jest.Mock;

  beforeEach(() => {
    fileIndexFindMany = jest.fn();
    const db = {
      client: { fileIndex: { findMany: fileIndexFindMany } },
    } as unknown as DbService;
    service = new FileIndexService(db);
  });

  /** Both connections hold `Contacts/marcos.json`, with distinct record ids. */
  const twoConnectionsShareTheSamePath = () =>
    fileIndexFindMany.mockResolvedValue([
      { folderPath: 'Contacts', filename: 'marcos.json', recordId: 'rec_hubspot', connectorAccountId: 'coa_hubspot' },
      {
        folderPath: 'Contacts',
        filename: 'marcos.json',
        recordId: 'rec_hubspot_testing',
        connectorAccountId: 'coa_hubspot_testing',
      },
    ]);

  it('disambiguates two connections that share a folderPath+filename by connectorAccountId', async () => {
    twoConnectionsShareTheSamePath();

    const hubspotLookup = { folderPath: 'Contacts', filename: 'marcos.json', connectorAccountId: 'coa_hubspot' };
    const scopedToHubspot = await service.getRecordIds('wkb_1', [hubspotLookup]);
    expect(scopedToHubspot.get(fileIndexLookupKey(hubspotLookup))).toBe('rec_hubspot');

    const testingLookup = {
      folderPath: 'Contacts',
      filename: 'marcos.json',
      connectorAccountId: 'coa_hubspot_testing',
    };
    const scopedToTesting = await service.getRecordIds('wkb_1', [testingLookup]);
    expect(scopedToTesting.get(fileIndexLookupKey(testingLookup))).toBe('rec_hubspot_testing');
  });

  // The regression this keying exists for: with the result keyed `folderPath:filename` these
  // two lookups collapsed onto one entry, so BOTH refs resolved to whichever connection was
  // registered first — publish then wrote the wrong record id to the service.
  it('keeps both connections distinct when they are looked up in the SAME batch', async () => {
    twoConnectionsShareTheSamePath();

    const hubspotLookup = { folderPath: 'Contacts', filename: 'marcos.json', connectorAccountId: 'coa_hubspot' };
    const testingLookup = {
      folderPath: 'Contacts',
      filename: 'marcos.json',
      connectorAccountId: 'coa_hubspot_testing',
    };

    const result = await service.getRecordIds('wkb_1', [hubspotLookup, testingLookup]);

    expect(result.get(fileIndexLookupKey(hubspotLookup))).toBe('rec_hubspot');
    expect(result.get(fileIndexLookupKey(testingLookup))).toBe('rec_hubspot_testing');
    // One DB round trip still — the two lookups share a folderPath, so they batch together.
    expect(fileIndexFindMany).toHaveBeenCalledTimes(1);
  });

  it('falls back to a workbook-global match when no connection is provided', async () => {
    fileIndexFindMany.mockResolvedValue([
      { folderPath: 'Contacts', filename: 'marcos.json', recordId: 'rec_first', connectorAccountId: 'coa_hubspot' },
    ]);

    const unscopedLookup = { folderPath: 'Contacts', filename: 'marcos.json' };
    const result = await service.getRecordIds('wkb_1', [unscopedLookup]);
    expect(result.get(fileIndexLookupKey(unscopedLookup))).toBe('rec_first');
  });

  it('resolves an UNSCOPED lookup workbook-globally (the connector-less scratch folder case)', async () => {
    fileIndexFindMany.mockResolvedValue([
      { folderPath: 'Notes', filename: 'idea.json', recordId: 'scratch_rec', connectorAccountId: null },
    ]);

    const unscopedLookup = { folderPath: 'Notes', filename: 'idea.json' };
    const result = await service.getRecordIds('wkb_1', [unscopedLookup]);
    expect(result.get(fileIndexLookupKey(unscopedLookup))).toBe('scratch_rec');
  });

  // Omitting the lookup (rather than returning another connection's id) is what makes a
  // scoped lookup strict — callers already treat a missing key as "no record id".
  it('omits a lookup whose only row belongs to a different connection', async () => {
    fileIndexFindMany.mockResolvedValue([
      { folderPath: 'Contacts', filename: 'marcos.json', recordId: 'rec_other', connectorAccountId: 'coa_other' },
    ]);

    const lookup = { folderPath: 'Contacts', filename: 'marcos.json', connectorAccountId: 'coa_hubspot' };
    const result = await service.getRecordIds('wkb_1', [lookup]);

    // Absent, not wrong — the caller surfaces it as unresolved instead of publishing
    // another connection's remote id into this connection's record.
    expect(result.has(fileIndexLookupKey(lookup))).toBe(false);
  });
});
