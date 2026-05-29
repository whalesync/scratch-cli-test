import type {
  ColumnMappingV1,
  ColumnMappingV2,
  DataFolderId,
  SyncMappingV1,
  SyncMappingV2,
} from '@spinner/shared-types';
import { transformV1ToV2 } from '@spinner/shared-types';
import { Service } from 'src/remote-service/connectors/service-constants';
import {
  applyColumnMappings,
  classifyDestinationRecord,
  findTransformerConfigsV2,
  getColumnMappingPhaseV2,
  getTransformerConfigsV2,
  transformRecordAsync,
  v2ColumnAsV1,
} from 'src/sync/sync-execution';
import { FkMappingResult, LookupTools } from 'src/sync/transformers/transformer.types';

// Register transformers used in the tests
import 'src/sync/transformers/implementations/auto-convert.transformer';
import 'src/sync/transformers/implementations/source-fk-to-dest-fk.transformer';

const SOURCE_FOLDER = 'dfd_src1' as DataFolderId;
const DEST_FOLDER = 'dfd_dest1' as DataFolderId;
const REFERENCED_FOLDER = 'dfd_dest_authors' as DataFolderId;

const SYNC_CONTEXT = {
  sourceService: Service.AIRTABLE,
  destinationService: Service.WEBFLOW,
};

const NOOP_LOOKUP_TOOLS: LookupTools = {
  getDestinationMappingForSourceFk: jest.fn(() => Promise.resolve(null)),
  lookupFieldFromFkRecord: jest.fn(() => Promise.resolve(null)),
  getOrCreateDestinationAssetMapping: jest.fn(() => Promise.reject(new Error('not available'))),
  matchDestinationAssetByHash: jest.fn(() => Promise.resolve([])),
};

const FK_LOOKUP_TOOLS: LookupTools = {
  getDestinationMappingForSourceFk: jest.fn((fk: string): Promise<FkMappingResult | null> => {
    const map: Record<string, FkMappingResult> = {
      src_author_1: { destinationFilePath: 'authors/alice.json', destinationRemoteId: 'wf-author-1' },
    };
    return Promise.resolve(map[fk] ?? null);
  }),
  lookupFieldFromFkRecord: jest.fn(() => Promise.resolve(null)),
  getOrCreateDestinationAssetMapping: jest.fn(() => Promise.reject(new Error('not available'))),
  matchDestinationAssetByHash: jest.fn(() => Promise.resolve([])),
};

// ===========================================================================
// transformV1ToV2
// ===========================================================================
describe('transformV1ToV2', () => {
  it('shape-transforms a v1 mapping with a plain column copy', () => {
    const v1: SyncMappingV1 = {
      version: 1,
      tableMappings: [
        {
          sourceDataFolderId: SOURCE_FOLDER,
          destinationDataFolderId: DEST_FOLDER,
          columnMappings: [{ sourceColumnId: 'Title', destinationColumnId: 'name' }],
        },
      ],
    };

    const v2 = transformV1ToV2(v1);

    expect(v2).toEqual<SyncMappingV2>({
      version: 2,
      tableMappings: [
        {
          sourceDataFolderId: SOURCE_FOLDER,
          destinationDataFolderId: DEST_FOLDER,
          columnMappings: [
            {
              destinationColumnId: 'name',
              source: { kind: 'column', columnId: 'Title' },
            },
          ],
        },
      ],
    });
  });

  it('preserves a single transformer config', () => {
    const v1: SyncMappingV1 = {
      version: 1,
      tableMappings: [
        {
          sourceDataFolderId: SOURCE_FOLDER,
          destinationDataFolderId: DEST_FOLDER,
          columnMappings: [
            {
              sourceColumnId: 'price',
              destinationColumnId: 'amount',
              transformer: { type: 'auto_convert', options: { targetType: 'number' } },
            },
          ],
        },
      ],
    };

    const v2 = transformV1ToV2(v1);
    expect(v2.tableMappings[0].columnMappings[0].source).toEqual({
      kind: 'column',
      columnId: 'price',
      transformer: { type: 'auto_convert', options: { targetType: 'number' } },
    });
  });

  it('preserves a transformers pipeline', () => {
    const v1: SyncMappingV1 = {
      version: 1,
      tableMappings: [
        {
          sourceDataFolderId: SOURCE_FOLDER,
          destinationDataFolderId: DEST_FOLDER,
          columnMappings: [
            {
              sourceColumnId: 'authorIds',
              destinationColumnId: 'author',
              transformers: [
                { type: 'source_fk_to_dest_fk', options: { referencedDataFolderId: REFERENCED_FOLDER } },
                { type: 'auto_convert', options: { targetType: 'string' } },
              ],
            },
          ],
        },
      ],
    };

    const v2 = transformV1ToV2(v1);
    expect(v2.tableMappings[0].columnMappings[0].source).toEqual({
      kind: 'column',
      columnId: 'authorIds',
      transformers: [
        { type: 'source_fk_to_dest_fk', options: { referencedDataFolderId: REFERENCED_FOLDER } },
        { type: 'auto_convert', options: { targetType: 'string' } },
      ],
    });
  });

  it('preserves recordMatching unchanged', () => {
    const v1: SyncMappingV1 = {
      version: 1,
      tableMappings: [
        {
          sourceDataFolderId: SOURCE_FOLDER,
          destinationDataFolderId: DEST_FOLDER,
          columnMappings: [],
          recordMatching: { sourceColumnId: 'externalId', destinationColumnId: 'external-id' },
        },
      ],
    };

    const v2 = transformV1ToV2(v1);
    expect(v2.tableMappings[0].recordMatching).toEqual({
      sourceColumnId: 'externalId',
      destinationColumnId: 'external-id',
    });
  });

  it('does not add when, unmatchedSourcePolicy, or unmatchedDestinationPolicy', () => {
    const v1: SyncMappingV1 = {
      version: 1,
      tableMappings: [
        {
          sourceDataFolderId: SOURCE_FOLDER,
          destinationDataFolderId: DEST_FOLDER,
          columnMappings: [{ sourceColumnId: 'a', destinationColumnId: 'b' }],
        },
      ],
    };

    const v2 = transformV1ToV2(v1);
    const table = v2.tableMappings[0];
    expect(table.unmatchedSourcePolicy).toBeUndefined();
    expect(table.unmatchedDestinationPolicy).toBeUndefined();
    expect(table.columnMappings[0].when).toBeUndefined();
  });
});

// ===========================================================================
// v2ColumnAsV1 — round-trip identity through transformV1ToV2
// ===========================================================================
describe('v2ColumnAsV1', () => {
  it('returns null for constant sources', () => {
    const m: ColumnMappingV2 = {
      destinationColumnId: 'archived',
      when: 'unmatched',
      source: { kind: 'constant', value: true },
    };
    expect(v2ColumnAsV1(m)).toBeNull();
  });

  it('round-trips v1 → v2 → v1 with identity for column sources', () => {
    const cases: ColumnMappingV1[] = [
      { sourceColumnId: 'Title', destinationColumnId: 'name' },
      {
        sourceColumnId: 'price',
        destinationColumnId: 'amount',
        transformer: { type: 'auto_convert', options: { targetType: 'number' } },
      },
      {
        sourceColumnId: 'authorIds',
        destinationColumnId: 'author',
        transformers: [
          { type: 'source_fk_to_dest_fk', options: { referencedDataFolderId: REFERENCED_FOLDER } },
          { type: 'auto_convert', options: { targetType: 'string' } },
        ],
      },
    ];

    for (const v1 of cases) {
      const v1Sync: SyncMappingV1 = {
        version: 1,
        tableMappings: [
          {
            sourceDataFolderId: SOURCE_FOLDER,
            destinationDataFolderId: DEST_FOLDER,
            columnMappings: [v1],
          },
        ],
      };
      const v2Sync = transformV1ToV2(v1Sync);
      const roundTripped = v2ColumnAsV1(v2Sync.tableMappings[0].columnMappings[0]);
      expect(roundTripped).toEqual(v1);
    }
  });
});

// ===========================================================================
// getTransformerConfigsV2 / findTransformerConfigsV2 / getColumnMappingPhaseV2
// ===========================================================================
describe('v2 transformer-config helpers', () => {
  it('returns empty configs for constant sources', () => {
    const m: ColumnMappingV2 = { destinationColumnId: 'x', source: { kind: 'constant', value: 1 } };
    expect(getTransformerConfigsV2(m)).toEqual([]);
    expect(findTransformerConfigsV2(m, 'auto_convert')).toEqual([]);
    expect(getColumnMappingPhaseV2(m)).toBe('DATA');
  });

  it('normalizes single transformer to array', () => {
    const m: ColumnMappingV2 = {
      destinationColumnId: 'amount',
      source: {
        kind: 'column',
        columnId: 'price',
        transformer: { type: 'auto_convert', options: { targetType: 'number' } },
      },
    };
    expect(getTransformerConfigsV2(m)).toHaveLength(1);
    expect(getTransformerConfigsV2(m)[0].type).toBe('auto_convert');
  });

  it('returns transformers array as-is', () => {
    const m: ColumnMappingV2 = {
      destinationColumnId: 'author',
      source: {
        kind: 'column',
        columnId: 'authorIds',
        transformers: [
          { type: 'source_fk_to_dest_fk', options: { referencedDataFolderId: REFERENCED_FOLDER } },
          { type: 'auto_convert', options: { targetType: 'string' } },
        ],
      },
    };
    expect(getTransformerConfigsV2(m)).toHaveLength(2);
    expect(findTransformerConfigsV2(m, 'auto_convert')).toHaveLength(1);
    expect(findTransformerConfigsV2(m, 'source_fk_to_dest_fk')).toHaveLength(1);
  });

  it('classifies FK transformers as FOREIGN_KEY_MAPPING phase', () => {
    const m: ColumnMappingV2 = {
      destinationColumnId: 'author',
      source: {
        kind: 'column',
        columnId: 'authorIds',
        transformers: [{ type: 'source_fk_to_dest_fk', options: { referencedDataFolderId: REFERENCED_FOLDER } }],
      },
    };
    expect(getColumnMappingPhaseV2(m)).toBe('FOREIGN_KEY_MAPPING');
  });

  it('classifies plain column copies as DATA phase', () => {
    const m: ColumnMappingV2 = {
      destinationColumnId: 'name',
      source: { kind: 'column', columnId: 'Title' },
    };
    expect(getColumnMappingPhaseV2(m)).toBe('DATA');
  });
});

// ===========================================================================
// applyColumnMappings
// ===========================================================================
describe('applyColumnMappings', () => {
  describe('bucket filtering', () => {
    it('matched bucket includes mappings with when undefined and when "matched"', async () => {
      const sourceRecord = { id: 'r1', filePath: 'p', fields: { a: 'A', b: 'B' } };
      const mappings: ColumnMappingV2[] = [
        { destinationColumnId: 'name', source: { kind: 'column', columnId: 'a' } },
        { destinationColumnId: 'slug', when: 'matched', source: { kind: 'column', columnId: 'b' } },
      ];

      const { fields } = await applyColumnMappings({
        bucket: 'matched',
        sourceRecord,
        baseFields: undefined,
        mappings,
        sourceTableSpec: null,
        destinationTableSpec: null,
        lookupTools: NOOP_LOOKUP_TOOLS,
        phase: 'DATA',
        syncContext: SYNC_CONTEXT,
      });

      expect(fields).toEqual({ name: 'A', slug: 'B' });
    });

    it('matched bucket excludes when "unmatched"', async () => {
      const sourceRecord = { id: 'r1', filePath: 'p', fields: { a: 'A' } };
      const mappings: ColumnMappingV2[] = [
        { destinationColumnId: 'name', source: { kind: 'column', columnId: 'a' } },
        { destinationColumnId: 'archived', when: 'unmatched', source: { kind: 'constant', value: true } },
      ];

      const { fields } = await applyColumnMappings({
        bucket: 'matched',
        sourceRecord,
        baseFields: undefined,
        mappings,
        sourceTableSpec: null,
        destinationTableSpec: null,
        lookupTools: NOOP_LOOKUP_TOOLS,
        phase: 'DATA',
        syncContext: SYNC_CONTEXT,
      });

      expect(fields).toEqual({ name: 'A' });
    });

    it('when "always" fires in both matched and unmatched buckets', async () => {
      const sourceRecord = { id: 'r1', filePath: 'p', fields: { a: 'A' } };
      const mappings: ColumnMappingV2[] = [
        { destinationColumnId: 'name', source: { kind: 'column', columnId: 'a' } },
        { destinationColumnId: 'lastRun', when: 'always', source: { kind: 'constant', value: 'run-1' } },
      ];

      const matched = await applyColumnMappings({
        bucket: 'matched',
        sourceRecord,
        baseFields: undefined,
        mappings,
        sourceTableSpec: null,
        destinationTableSpec: null,
        lookupTools: NOOP_LOOKUP_TOOLS,
        phase: 'DATA',
        syncContext: SYNC_CONTEXT,
      });
      expect(matched.fields).toEqual({ name: 'A', lastRun: 'run-1' });

      const unmatched = await applyColumnMappings({
        bucket: 'unmatched',
        sourceRecord: null,
        baseFields: { existing: 'x' },
        mappings,
        sourceTableSpec: null,
        destinationTableSpec: null,
        lookupTools: NOOP_LOOKUP_TOOLS,
        phase: 'DATA',
        syncContext: SYNC_CONTEXT,
      });
      expect(unmatched.fields).toEqual({ existing: 'x', lastRun: 'run-1' });
    });
  });

  describe('source.kind dispatch', () => {
    it('writes constant values to the destination path', async () => {
      const mappings: ColumnMappingV2[] = [
        { destinationColumnId: 'archived', when: 'unmatched', source: { kind: 'constant', value: true } },
      ];
      const { fields } = await applyColumnMappings({
        bucket: 'unmatched',
        sourceRecord: null,
        baseFields: { name: 'Existing' },
        mappings,
        sourceTableSpec: null,
        destinationTableSpec: null,
        lookupTools: NOOP_LOOKUP_TOOLS,
        phase: 'DATA',
        syncContext: SYNC_CONTEXT,
      });
      expect(fields).toEqual({ name: 'Existing', archived: true });
    });

    it('supports nested destination paths for constants via lodash set', async () => {
      const mappings: ColumnMappingV2[] = [
        {
          destinationColumnId: 'fieldData.archived',
          when: 'unmatched',
          source: { kind: 'constant', value: true },
        },
      ];
      const { fields } = await applyColumnMappings({
        bucket: 'unmatched',
        sourceRecord: null,
        baseFields: { fieldData: { name: 'A' } },
        mappings,
        sourceTableSpec: null,
        destinationTableSpec: null,
        lookupTools: NOOP_LOOKUP_TOOLS,
        phase: 'DATA',
        syncContext: SYNC_CONTEXT,
      });
      expect(fields).toEqual({ fieldData: { name: 'A', archived: true } });
    });

    it('defensively skips column sources in the unmatched bucket', async () => {
      // The save-time refinement forbids this combo; the executor is defensive
      // at runtime for manually-edited rows.
      const mappings: ColumnMappingV2[] = [
        // Illegal: column source with when:'unmatched'. Silently skipped.
        { destinationColumnId: 'name', when: 'unmatched', source: { kind: 'column', columnId: 'a' } },
      ];
      const { fields } = await applyColumnMappings({
        bucket: 'unmatched',
        sourceRecord: null,
        baseFields: { name: 'Existing' },
        mappings,
        sourceTableSpec: null,
        destinationTableSpec: null,
        lookupTools: NOOP_LOOKUP_TOOLS,
        phase: 'DATA',
        syncContext: SYNC_CONTEXT,
      });
      // baseFields preserved, illegal mapping skipped
      expect(fields).toEqual({ name: 'Existing' });
    });
  });

  describe('phase gating', () => {
    it('constants do not fire in FOREIGN_KEY_MAPPING phase', async () => {
      const sourceRecord = { id: 'r1', filePath: 'p', fields: {} };
      const mappings: ColumnMappingV2[] = [
        { destinationColumnId: 'lastRun', when: 'matched', source: { kind: 'constant', value: 'x' } },
      ];
      const { fields } = await applyColumnMappings({
        bucket: 'matched',
        sourceRecord,
        baseFields: { existing: 1 },
        mappings,
        sourceTableSpec: null,
        destinationTableSpec: null,
        lookupTools: NOOP_LOOKUP_TOOLS,
        phase: 'FOREIGN_KEY_MAPPING',
        syncContext: SYNC_CONTEXT,
      });
      expect(fields).toEqual({ existing: 1 });
    });
  });

  describe('v1 round-trip identity', () => {
    // Regression net: a v2 mapping derived from v1 via transformV1ToV2, run
    // through applyColumnMappings(matched), produces identical fields to
    // transformRecordAsync(v1) on the same record. This is the contract that
    // unlocks Lane B's executor refactor without changing v1 behavior.
    const sourceRecord = {
      id: 'rec_1',
      filePath: 'source/item.json',
      fields: {
        Name: 'Atlantic Mackerel',
        Link: 'https://en.wikipedia.org/wiki/Atlantic_mackerel',
        price: '42.5',
        authorIds: ['src_author_1'],
      },
    };

    const v1Mappings: ColumnMappingV1[] = [
      { sourceColumnId: 'Name', destinationColumnId: 'fieldData.name' },
      { sourceColumnId: 'Link', destinationColumnId: 'fieldData.link' },
      {
        sourceColumnId: 'price',
        destinationColumnId: 'amount',
        transformer: { type: 'auto_convert', options: { targetType: 'number' } },
      },
      {
        sourceColumnId: 'authorIds',
        destinationColumnId: 'author',
        transformers: [
          { type: 'source_fk_to_dest_fk', options: { referencedDataFolderId: REFERENCED_FOLDER } },
          { type: 'auto_convert', options: { targetType: 'string' } },
        ],
      },
    ];

    const v2Mappings: ColumnMappingV2[] = transformV1ToV2({
      version: 1,
      tableMappings: [
        {
          sourceDataFolderId: SOURCE_FOLDER,
          destinationDataFolderId: DEST_FOLDER,
          columnMappings: v1Mappings,
        },
      ],
    }).tableMappings[0].columnMappings;

    it('DATA phase: applyColumnMappings(matched, v2) === transformRecordAsync(v1)', async () => {
      const v1Result = await transformRecordAsync(
        sourceRecord,
        v1Mappings,
        null,
        null,
        FK_LOOKUP_TOOLS,
        'DATA',
        undefined,
        SYNC_CONTEXT,
      );
      const v2Result = await applyColumnMappings({
        bucket: 'matched',
        sourceRecord,
        baseFields: undefined,
        mappings: v2Mappings,
        sourceTableSpec: null,
        destinationTableSpec: null,
        lookupTools: FK_LOOKUP_TOOLS,
        phase: 'DATA',
        syncContext: SYNC_CONTEXT,
      });
      expect(v2Result.fields).toEqual(v1Result.fields);
      expect(v2Result.warnings).toEqual(v1Result.warnings);
    });

    it('FK phase: applyColumnMappings(matched, v2) === transformRecordAsync(v1)', async () => {
      const v1Result = await transformRecordAsync(
        sourceRecord,
        v1Mappings,
        null,
        null,
        FK_LOOKUP_TOOLS,
        'FOREIGN_KEY_MAPPING',
        undefined,
        SYNC_CONTEXT,
      );
      const v2Result = await applyColumnMappings({
        bucket: 'matched',
        sourceRecord,
        baseFields: undefined,
        mappings: v2Mappings,
        sourceTableSpec: null,
        destinationTableSpec: null,
        lookupTools: FK_LOOKUP_TOOLS,
        phase: 'FOREIGN_KEY_MAPPING',
        syncContext: SYNC_CONTEXT,
      });
      expect(v2Result.fields).toEqual(v1Result.fields);
      expect(v2Result.warnings).toEqual(v1Result.warnings);
    });

    it('preserves key ordering when updating an existing record (matches v1 behavior)', async () => {
      const existingFields = {
        id: '6994a4d364f1775dd68f1589',
        cmsLocaleId: '6930533529443b9f130b26e6',
        fieldData: { 'airtable-id': 'rechCcin6LPjgFMfY', name: 'Old Name', slug: 'old-slug' },
      };
      const v1Result = await transformRecordAsync(
        sourceRecord,
        v1Mappings,
        null,
        null,
        FK_LOOKUP_TOOLS,
        'DATA',
        existingFields,
        SYNC_CONTEXT,
      );
      const v2Result = await applyColumnMappings({
        bucket: 'matched',
        sourceRecord,
        baseFields: existingFields,
        mappings: v2Mappings,
        sourceTableSpec: null,
        destinationTableSpec: null,
        lookupTools: FK_LOOKUP_TOOLS,
        phase: 'DATA',
        syncContext: SYNC_CONTEXT,
      });
      expect(Object.keys(v2Result.fields)).toEqual(Object.keys(v1Result.fields));
      expect(v2Result.fields).toEqual(v1Result.fields);
    });
  });
});

// ===========================================================================
// classifyDestinationRecord
// ===========================================================================
describe('classifyDestinationRecord', () => {
  const MATCH_COL = 'external-id';

  const recordWith = (fieldValue: unknown) => ({
    id: 'dest-1',
    filePath: 'dest/x.json',
    fields: { [MATCH_COL]: fieldValue, name: 'X' },
  });

  it('returns "matched" when the match-key value is present in the source set', () => {
    const set = new Set(['rec_123']);
    expect(classifyDestinationRecord(recordWith('rec_123'), set, MATCH_COL)).toBe('matched');
  });

  it('returns "matched" with a numeric match-key value present in the source set', () => {
    // Source set stores `String(matchValue)` per insertMatchKeys, so the
    // classifier must coerce numbers the same way.
    const set = new Set(['42']);
    expect(classifyDestinationRecord(recordWith(42), set, MATCH_COL)).toBe('matched');
  });

  it('trims surrounding whitespace before lookup (mirrors insertMatchKeys normalization)', () => {
    const set = new Set(['rec_123']);
    expect(classifyDestinationRecord(recordWith('  rec_123  '), set, MATCH_COL)).toBe('matched');
  });

  it('returns "unmatchedWithMatchKey" when match-key value is populated but missing from source set', () => {
    const set = new Set(['rec_999']);
    expect(classifyDestinationRecord(recordWith('rec_123'), set, MATCH_COL)).toBe('unmatchedWithMatchKey');
  });

  it('returns "unmatchedWithoutMatchKey" for null', () => {
    expect(classifyDestinationRecord(recordWith(null), new Set(), MATCH_COL)).toBe('unmatchedWithoutMatchKey');
  });

  it('returns "unmatchedWithoutMatchKey" for undefined', () => {
    expect(classifyDestinationRecord(recordWith(undefined), new Set(), MATCH_COL)).toBe('unmatchedWithoutMatchKey');
  });

  it('returns "unmatchedWithoutMatchKey" for an empty string', () => {
    expect(classifyDestinationRecord(recordWith(''), new Set(), MATCH_COL)).toBe('unmatchedWithoutMatchKey');
  });

  it('returns "unmatchedWithoutMatchKey" for a whitespace-only string', () => {
    expect(classifyDestinationRecord(recordWith('   '), new Set(), MATCH_COL)).toBe('unmatchedWithoutMatchKey');
  });

  it('returns "unmatchedWithoutMatchKey" for non-string/non-number values', () => {
    // Booleans, arrays, objects — never legitimately a match key.
    expect(classifyDestinationRecord(recordWith(true), new Set(['true']), MATCH_COL)).toBe('unmatchedWithoutMatchKey');
    expect(classifyDestinationRecord(recordWith([1, 2]), new Set(), MATCH_COL)).toBe('unmatchedWithoutMatchKey');
    expect(classifyDestinationRecord(recordWith({ x: 1 }), new Set(['[object Object]']), MATCH_COL)).toBe(
      'unmatchedWithoutMatchKey',
    );
  });

  it('supports nested match-key paths via lodash get', () => {
    const record = { id: 'd1', filePath: 'p', fields: { fieldData: { externalId: 'rec_55' } } };
    const set = new Set(['rec_55']);
    expect(classifyDestinationRecord(record, set, 'fieldData.externalId')).toBe('matched');
  });
});
