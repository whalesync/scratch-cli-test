import { Prisma } from '@prisma/client';
import { DbService } from '../../db/db.service';
import { FileIndexEntry, fileIndexLookupKey, FileIndexService, pickPreferredRecordId } from '../file-index.service';

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

  let runQueryWithCustomPlan: jest.Mock;

  beforeEach(() => {
    fileIndexFindMany = jest.fn();
    runQueryWithCustomPlan = jest.fn((query: Promise<unknown>) => query);
    const db = {
      client: { fileIndex: { findMany: fileIndexFindMany } },
      runQueryWithCustomPlanForBoundParameterValues: runQueryWithCustomPlan,
    } as unknown as DbService;
    service = new FileIndexService(db);
  });

  it('runs every per-folder chunk with a custom query plan (skewed tenants make generic plans scan whole folders)', async () => {
    fileIndexFindMany.mockResolvedValue([]);
    const lookups = [
      ...Array.from({ length: 1500 }, (_, i) => ({ folderPath: 'Contacts', filename: `c-${i}.json` })),
      { folderPath: 'Companies', filename: 'google.json' },
    ];

    await service.getRecordIds('wkb_1', lookups);

    expect(fileIndexFindMany).toHaveBeenCalledTimes(3);
    expect(runQueryWithCustomPlan).toHaveBeenCalledTimes(3);
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

describe('FileIndexService.deleteRowsForDeletedFiles', () => {
  let service: FileIndexService;
  let fileIndexDeleteMany: jest.Mock;

  beforeEach(() => {
    fileIndexDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const db = {
      client: { fileIndex: { deleteMany: fileIndexDeleteMany } },
      runQueryWithCustomPlanForBoundParameterValues: (query: Promise<unknown>) => query,
    } as unknown as DbService;
    service = new FileIndexService(db);
  });

  it('deletes by (folderPath, filename) grouped per folder and scoped to the connection', async () => {
    await service.deleteRowsForDeletedFiles('wkb_1', 'coa_1', [
      'Companies/google.json',
      'Companies/atlas.json',
      'Contacts/marcos.json',
    ]);

    expect(fileIndexDeleteMany).toHaveBeenCalledTimes(2);
    expect(fileIndexDeleteMany).toHaveBeenCalledWith({
      where: {
        workbookId: 'wkb_1',
        connectorAccountId: 'coa_1',
        folderPath: 'Companies',
        filename: { in: ['google.json', 'atlas.json'] },
      },
    });
    expect(fileIndexDeleteMany).toHaveBeenCalledWith({
      where: {
        workbookId: 'wkb_1',
        connectorAccountId: 'coa_1',
        folderPath: 'Contacts',
        filename: { in: ['marcos.json'] },
      },
    });
  });

  it('chunks a large folder into deletes of at most 1000 filenames', async () => {
    const paths = Array.from({ length: 2500 }, (_, i) => `Companies/rec-${i}.json`);

    await service.deleteRowsForDeletedFiles('wkb_1', 'coa_1', paths);

    const chunkSizes = fileIndexDeleteMany.mock.calls.map(
      (call: [{ where: { filename: { in: string[] } } }]) => call[0].where.filename.in.length,
    );
    expect(chunkSizes).toEqual([1000, 1000, 500]);
  });

  it('issues no delete for an empty list', async () => {
    await service.deleteRowsForDeletedFiles('wkb_1', 'coa_1', []);

    expect(fileIndexDeleteMany).not.toHaveBeenCalled();
  });
});

describe('FileIndexService.upsertBatch', () => {
  let service: FileIndexService;
  let executeRaw: jest.Mock;

  beforeEach(() => {
    executeRaw = jest.fn().mockResolvedValue(0);
    const db = { client: { $executeRaw: executeRaw } } as unknown as DbService;
    service = new FileIndexService(db);
  });

  const entry = (recordId: string, filename: string, connectorAccountId: string | null = 'coa_1'): FileIndexEntry => ({
    workbookId: 'wkb_1',
    folderPath: 'Contacts',
    recordId,
    filename,
    connectorAccountId,
  });

  /** The bound values of the multi-row VALUES list passed to one `$executeRaw` call. */
  const boundValuesOfStatement = (callIndex: number): unknown[] =>
    (executeRaw.mock.calls[callIndex] as [TemplateStringsArray, Prisma.Sql, ...unknown[]])[1].values;
  const BOUND_VALUES_PER_ROW = 5;

  it('writes one multi-row statement per 1000 entries instead of one statement per row', async () => {
    await service.upsertBatch(Array.from({ length: 2500 }, (_, i) => entry(`rec_${i}`, `f-${i}.json`)));

    expect(executeRaw).toHaveBeenCalledTimes(3);
    expect(boundValuesOfStatement(0)).toHaveLength(1000 * BOUND_VALUES_PER_ROW);
    expect(boundValuesOfStatement(2)).toHaveLength(500 * BOUND_VALUES_PER_ROW);
  });

  it('collapses a key repeated within the batch to its LAST entry (ON CONFLICT cannot touch a row twice)', async () => {
    await service.upsertBatch([entry('rec_a', 'first.json'), entry('rec_b', 'b.json'), entry('rec_a', 'second.json')]);

    expect(executeRaw).toHaveBeenCalledTimes(1);
    const boundValues = boundValuesOfStatement(0);
    expect(boundValues).toHaveLength(2 * BOUND_VALUES_PER_ROW);
    expect(boundValues).toContain('second.json');
    expect(boundValues).not.toContain('first.json');
  });

  it('issues no statement for an empty batch', async () => {
    await service.upsertBatch([]);

    expect(executeRaw).not.toHaveBeenCalled();
  });
});
