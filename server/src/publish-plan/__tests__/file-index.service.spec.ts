import { DbService } from '../../db/db.service';
import { FileIndexService, pickPreferredRecordId } from '../file-index.service';

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

  it('falls back to the first row when the requested connection has no matching row (legacy data)', () => {
    const rows = [{ connectorAccountId: null, recordId: 'legacy_rec' }];
    expect(pickPreferredRecordId(rows, 'coa_a')).toBe('legacy_rec');
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

  it('disambiguates two connections that share a folderPath+filename by connectorAccountId', async () => {
    // Two connections both have Contacts/marcos.json with distinct record ids.
    fileIndexFindMany.mockResolvedValue([
      { folderPath: 'Contacts', filename: 'marcos.json', recordId: 'rec_hubspot', connectorAccountId: 'coa_hubspot' },
      {
        folderPath: 'Contacts',
        filename: 'marcos.json',
        recordId: 'rec_hubspot_testing',
        connectorAccountId: 'coa_hubspot_testing',
      },
    ]);

    const scopedToHubspot = await service.getRecordIds('wkb_1', [
      { folderPath: 'Contacts', filename: 'marcos.json', connectorAccountId: 'coa_hubspot' },
    ]);
    expect(scopedToHubspot.get('Contacts:marcos.json')).toBe('rec_hubspot');

    const scopedToTesting = await service.getRecordIds('wkb_1', [
      { folderPath: 'Contacts', filename: 'marcos.json', connectorAccountId: 'coa_hubspot_testing' },
    ]);
    expect(scopedToTesting.get('Contacts:marcos.json')).toBe('rec_hubspot_testing');
  });

  it('falls back to a workbook-global match when no connection is provided', async () => {
    fileIndexFindMany.mockResolvedValue([
      { folderPath: 'Contacts', filename: 'marcos.json', recordId: 'rec_first', connectorAccountId: 'coa_hubspot' },
    ]);

    const result = await service.getRecordIds('wkb_1', [{ folderPath: 'Contacts', filename: 'marcos.json' }]);
    expect(result.get('Contacts:marcos.json')).toBe('rec_first');
  });
});
