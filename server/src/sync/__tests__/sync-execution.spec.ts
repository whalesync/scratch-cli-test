import { Type } from '@sinclair/typebox';
import type {
  AutoConvertOptions,
  ColumnMappingV1,
  ColumnMappingV2,
  DataFolderId,
  SyncMappingV1,
  SyncMappingV2,
} from '@spinner/shared-types';
import { transformV1ToV2 } from '@spinner/shared-types';
import { Service } from 'src/remote-service/connectors/service-constants';
import type { BaseJsonTableSpec } from 'src/remote-service/connectors/types';
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
import 'src/sync/transformers/implementations/jsonpath.transformer';
import 'src/sync/transformers/implementations/source-fk-to-dest-fk.transformer';
import 'src/sync/transformers/implementations/wrap-object.transformer';

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
      src_author_1: {
        destinationFilePath: 'authors/alice.json',
        destinationRemoteId: 'wf-author-1',
        destinationConnectionFolder: null,
      },
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
// transformRecordAsync — clearing a source field propagates to the destination
//
// Regression coverage for DEV-10797: a source field cleared to `undefined`
// (connectors that drop the key on clear, e.g. Notion's drilled
// `properties.X.select.name`) must clear the destination on the update path,
// rather than leaving the stale destination value in place.
// ===========================================================================
describe('transformRecordAsync — clearing a source field', () => {
  const mappings: ColumnMappingV1[] = [
    { sourceColumnId: 'title', destinationColumnId: 'name' },
    { sourceColumnId: 'status', destinationColumnId: 'status' },
  ];

  it('clears the destination (writes null) when the source field is undefined on the update path', async () => {
    // `status` is absent from the source record (cleared → key dropped).
    const sourceRecord = { id: 'r1', filePath: 'p', fields: { title: 'Hello' } };
    const baseFields = { name: 'Old Name', status: 'Published' };

    const { fields } = await transformRecordAsync(
      sourceRecord,
      mappings,
      null,
      null,
      NOOP_LOOKUP_TOOLS,
      'DATA',
      baseFields,
      SYNC_CONTEXT,
    );

    expect(fields).toEqual({ name: 'Hello', status: null });
  });

  it('clears a drilled destination whose source subpath resolves to undefined (parent nulled)', async () => {
    // Notion-style: Status was cleared, so `properties.Status.select` is null and
    // the drilled `properties.Status.select.name` resolves to undefined.
    const drilledMappings: ColumnMappingV1[] = [
      { sourceColumnId: 'properties.Status.select.name', destinationColumnId: 'status' },
    ];
    const sourceRecord = {
      id: 'r1',
      filePath: 'p',
      fields: { properties: { Status: { select: null } } },
    };
    const baseFields = { status: 'In Progress' };

    const { fields } = await transformRecordAsync(
      sourceRecord,
      drilledMappings,
      null,
      null,
      NOOP_LOOKUP_TOOLS,
      'DATA',
      baseFields,
      SYNC_CONTEXT,
    );

    expect(fields).toEqual({ status: null });
  });

  it('does not add a null key on the create path (no baseFields, nothing to clear)', async () => {
    const sourceRecord = { id: 'r1', filePath: 'p', fields: { title: 'Hello' } };

    const { fields } = await transformRecordAsync(
      sourceRecord,
      mappings,
      null,
      null,
      NOOP_LOOKUP_TOOLS,
      'DATA',
      undefined,
      SYNC_CONTEXT,
    );

    // `status` is simply omitted — a create has no stale value to clear.
    expect(fields).toEqual({ name: 'Hello' });
  });

  it('does not write when the destination has no existing value to clear', async () => {
    const sourceRecord = { id: 'r1', filePath: 'p', fields: { title: 'Hello' } };
    const baseFields = { name: 'Old Name' };

    const { fields } = await transformRecordAsync(
      sourceRecord,
      mappings,
      null,
      null,
      NOOP_LOOKUP_TOOLS,
      'DATA',
      baseFields,
      SYNC_CONTEXT,
    );

    // `status` was never present on the destination; no spurious null is added.
    expect(fields).toEqual({ name: 'Hello' });
    expect('status' in fields).toBe(false);
  });

  it('routes the clear through the transformer pipeline so a wrap_object clear takes the emptyTemplate shape', async () => {
    // Notion-style destination: the connector's suggested wrap_object transformer
    // declares `emptyTemplate` — the cleared envelope Notion accepts. A cleared
    // (absent) source must produce that shape, not a raw `null` at the
    // destination column.
    const wrappedMappings: ColumnMappingV1[] = [
      {
        sourceColumnId: 'status',
        destinationColumnId: 'properties.Status',
        transformer: {
          type: 'wrap_object',
          options: {
            template: { type: 'select', select: { name: '$value' } },
            emptyTemplate: { type: 'select', select: null },
          },
        },
      },
    ];
    const sourceRecord = { id: 'r1', filePath: 'p', fields: {} };
    const baseFields = { properties: { Status: { type: 'select', select: { name: 'In Progress' } } } };

    const { fields } = await transformRecordAsync(
      sourceRecord,
      wrappedMappings,
      null,
      null,
      NOOP_LOOKUP_TOOLS,
      'DATA',
      baseFields,
      SYNC_CONTEXT,
    );

    expect(fields).toEqual({ properties: { Status: { type: 'select', select: null } } });
  });

  it('is a no-op when the destination already holds the cleared envelope (no churn)', async () => {
    // An empty-on-both-sides field must not change bytes: the destination's
    // `{ type: 'select', select: null }` envelope is defined (so the clear path
    // fires), but the pipeline re-produces the identical emptyTemplate shape.
    const wrappedMappings: ColumnMappingV1[] = [
      {
        sourceColumnId: 'status',
        destinationColumnId: 'properties.Status',
        transformer: {
          type: 'wrap_object',
          options: {
            template: { type: 'select', select: { name: '$value' } },
            emptyTemplate: { type: 'select', select: null },
          },
        },
      },
    ];
    const sourceRecord = { id: 'r1', filePath: 'p', fields: {} };
    const baseFields = { properties: { Status: { type: 'select', select: null } } };

    const { fields } = await transformRecordAsync(
      sourceRecord,
      wrappedMappings,
      null,
      null,
      NOOP_LOOKUP_TOOLS,
      'DATA',
      baseFields,
      SYNC_CONTEXT,
    );

    expect(fields).toEqual(baseFields);
  });

  it('still writes an explicit null source value (unchanged behavior)', async () => {
    // A source that returns explicit null (e.g. Webflow) already passed the guard
    // before this fix; confirm that path is untouched.
    const sourceRecord = { id: 'r1', filePath: 'p', fields: { title: 'Hello', status: null } };
    const baseFields = { name: 'Old Name', status: 'Published' };

    const { fields } = await transformRecordAsync(
      sourceRecord,
      mappings,
      null,
      null,
      NOOP_LOOKUP_TOOLS,
      'DATA',
      baseFields,
      SYNC_CONTEXT,
    );

    expect(fields).toEqual({ name: 'Hello', status: null });
  });
});

// ===========================================================================
// transformRecordAsync — clearing a coerced (auto_convert) field
//
// Regression coverage for DEV-10817: the DEV-10797 clear path rewrites an absent
// source to `null` and runs the mapping's transformer pipeline. The `auto_convert`
// coercion floor (`pickMappingTransformers`/`coercionFloorForDestination`) rides
// nearly every cross-type mapping and, by default, coerced that `null` into a type
// zero-value (`0`/`false`/`''`/`[]`) — writing a literal zero into the cleared cell
// instead of emptying it. On the clear path `auto_convert` must preserve the clear.
// ===========================================================================
describe('transformRecordAsync — clearing a coerced (auto_convert) field', () => {
  function autoConvertMapping(targetType: AutoConvertOptions['targetType']): ColumnMappingV1[] {
    return [
      {
        sourceColumnId: 'value',
        destinationColumnId: 'value',
        transformer: { type: 'auto_convert', options: { targetType } },
      },
    ];
  }

  // `value` is absent from the source (cleared → key dropped), the shape the
  // DEV-10797 clear path handles.
  const clearedSourceRecord = { id: 'r1', filePath: 'p', fields: {} };

  async function clearWithAutoConvert(
    targetType: AutoConvertOptions['targetType'],
    baseFields: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { fields } = await transformRecordAsync(
      clearedSourceRecord,
      autoConvertMapping(targetType),
      null,
      null,
      NOOP_LOOKUP_TOOLS,
      'DATA',
      baseFields,
      SYNC_CONTEXT,
    );
    return fields;
  }

  it('clears a number destination (writes null) instead of coercing to 0', async () => {
    expect(await clearWithAutoConvert('number', { value: 4200 })).toEqual({ value: null });
  });

  it('clears an integer destination instead of coercing to 0', async () => {
    expect(await clearWithAutoConvert('integer', { value: 7 })).toEqual({ value: null });
  });

  it('clears a boolean destination instead of coercing to false', async () => {
    expect(await clearWithAutoConvert('boolean', { value: true })).toEqual({ value: null });
  });

  it('clears a string destination instead of coercing to ""', async () => {
    expect(await clearWithAutoConvert('string', { value: 'hello' })).toEqual({ value: null });
  });

  it('clears an array destination instead of coercing to []', async () => {
    expect(await clearWithAutoConvert('array', { value: ['a'] })).toEqual({ value: null });
  });

  it('preserves the clear through auto_convert when it is a later stage of a pipeline', async () => {
    // A realistic coercion-floor pipeline: an extract step (jsonpath) followed by
    // the `auto_convert` floor. The extract short-circuits the null, and the floor
    // must not resurrect it into a zero-value.
    const mappings: ColumnMappingV1[] = [
      {
        sourceColumnId: 'value',
        destinationColumnId: 'value',
        transformers: [
          { type: 'jsonpath', options: { expression: '$' } },
          { type: 'auto_convert', options: { targetType: 'number' } },
        ],
      },
    ];
    const { fields } = await transformRecordAsync(
      clearedSourceRecord,
      mappings,
      null,
      null,
      NOOP_LOOKUP_TOOLS,
      'DATA',
      { value: 4200 },
      SYNC_CONTEXT,
    );
    expect(fields).toEqual({ value: null });
  });

  it('still coerces an explicit null source to the zero-value (normal path unchanged)', async () => {
    // Only an *absent* source is the clear path. A source that carries an explicit
    // `null` keeps the deliberate zero-value coercion (added in 1bde29064 to stop
    // empty sources flipping a destination to null) — the fix must not regress it.
    const explicitNullSource = { id: 'r1', filePath: 'p', fields: { value: null } };
    const { fields } = await transformRecordAsync(
      explicitNullSource,
      autoConvertMapping('number'),
      null,
      null,
      NOOP_LOOKUP_TOOLS,
      'DATA',
      { value: 4200 },
      SYNC_CONTEXT,
    );
    expect(fields).toEqual({ value: 0 });
  });
});

// ===========================================================================
// transformRecordAsync — the never-fail coercion floor (useOriginal)
//
// Regression coverage for DEV-10794: when a transformer cannot coerce a cell and
// returns `{ success: false, useOriginal: true }` (e.g. an adopt-existing typed
// destination column forcing `auto_convert(number)` on an un-parseable "N/A"),
// `transformRecordAsync` must write the ORIGINAL source value and surface a
// warning — keeping the rest of the record — instead of throwing and dropping
// the entire row.
// ===========================================================================
describe('transformRecordAsync — coercion floor (useOriginal)', () => {
  const numberFloorMappings: ColumnMappingV1[] = [
    { sourceColumnId: 'name', destinationColumnId: 'name' },
    {
      sourceColumnId: 'count',
      destinationColumnId: 'count',
      transformer: { type: 'auto_convert', options: { targetType: 'number' } },
    },
  ];

  it('writes the original value and keeps the record when a cell cannot be coerced', async () => {
    const sourceRecord = { id: 'r1', filePath: 'p', fields: { name: 'Widget', count: 'N/A' } };

    const { fields, warnings } = await transformRecordAsync(
      sourceRecord,
      numberFloorMappings,
      null,
      null,
      NOOP_LOOKUP_TOOLS,
      'DATA',
      undefined,
      SYNC_CONTEXT,
    );

    // The whole record survives: the sibling field is written and the
    // un-coercible cell falls back to its original value.
    expect(fields).toEqual({ name: 'Widget', count: 'N/A' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('count');
    expect(warnings[0]).toContain('auto_convert');
  });

  it('preserves the original value on the update path without dropping other fields', async () => {
    const sourceRecord = { id: 'r1', filePath: 'p', fields: { name: 'Widget', count: 'TBD' } };
    const baseFields = { name: 'Old', count: 5 };

    const { fields } = await transformRecordAsync(
      sourceRecord,
      numberFloorMappings,
      null,
      null,
      NOOP_LOOKUP_TOOLS,
      'DATA',
      baseFields,
      SYNC_CONTEXT,
    );

    expect(fields).toEqual({ name: 'Widget', count: 'TBD' });
  });

  it('still coerces a parseable value (floor only fires on failure)', async () => {
    const sourceRecord = { id: 'r1', filePath: 'p', fields: { name: 'Widget', count: '42' } };

    const { fields, warnings } = await transformRecordAsync(
      sourceRecord,
      numberFloorMappings,
      null,
      null,
      NOOP_LOOKUP_TOOLS,
      'DATA',
      undefined,
      SYNC_CONTEXT,
    );

    expect(fields).toEqual({ name: 'Widget', count: 42 });
    expect(warnings).toEqual([]);
  });
});

// ===========================================================================
// classifyDestinationRecord
// ===========================================================================
describe('classifyDestinationRecord', () => {
  it('returns "matched" when the canonical key is present in the source set', () => {
    expect(classifyDestinationRecord('rec_123', new Set(['rec_123']))).toBe('matched');
  });

  it('returns "unmatchedWithMatchKey" when the key is populated but missing from the source set', () => {
    expect(classifyDestinationRecord('rec_123', new Set(['rec_999']))).toBe('unmatchedWithMatchKey');
  });

  it('returns "unmatchedWithoutMatchKey" when the record has no canonical match key', () => {
    expect(classifyDestinationRecord(null, new Set(['rec_123']))).toBe('unmatchedWithoutMatchKey');
  });
});

// ===========================================================================
// transformRecordAsync — field names that literally contain dots (DEV-10959)
//
// A Postgres column named `col.with.dots` maps to a Notion property of the same
// name. The source value must be READ from the flat `col.with.dots` key (not a
// nested `col → with → dots` miss that would be treated as a clear), and WRITTEN
// under the dotted property name at `properties.col.with.dots.rich_text`.
// ===========================================================================
describe('transformRecordAsync — dotted field names', () => {
  // Only `.schema` is read by the executor (it drives dot-safe destination-path
  // segmentation); the rest of the spec is irrelevant to this test.
  const destinationSpec = {
    schema: Type.Object({
      properties: Type.Object({
        'col.with.dots': Type.Object({ rich_text: Type.Array(Type.Object({})) }),
      }),
    }),
  } as unknown as BaseJsonTableSpec;

  it('reads a dotted source column and writes a dotted destination property on the create path', async () => {
    const mappings: ColumnMappingV1[] = [
      { sourceColumnId: 'col.with.dots', destinationColumnId: 'properties.col.with.dots.rich_text' },
    ];
    const sourceRecord = { id: 'r1', filePath: 'p', fields: { 'col.with.dots': 'hello' } };

    const { fields } = await transformRecordAsync(
      sourceRecord,
      mappings,
      null,
      destinationSpec,
      NOOP_LOOKUP_TOOLS,
      'DATA',
      undefined,
      SYNC_CONTEXT,
    );

    // Flat key preserved on both sides — NOT `{ col: { with: { dots: ... } } }`.
    expect(fields).toEqual({ properties: { 'col.with.dots': { rich_text: 'hello' } } });
  });

  it('updates a dotted destination property in place, preserving surrounding keys', async () => {
    const mappings: ColumnMappingV1[] = [
      { sourceColumnId: 'col.with.dots', destinationColumnId: 'properties.col.with.dots.rich_text' },
    ];
    const sourceRecord = { id: 'r1', filePath: 'p', fields: { 'col.with.dots': 'updated' } };
    const baseFields = {
      properties: {
        Name: { title: 'keep me' },
        'col.with.dots': { rich_text: 'old' },
      },
    };

    const { fields } = await transformRecordAsync(
      sourceRecord,
      mappings,
      null,
      destinationSpec,
      NOOP_LOOKUP_TOOLS,
      'DATA',
      baseFields,
      SYNC_CONTEXT,
    );

    expect(fields).toEqual({
      properties: {
        Name: { title: 'keep me' },
        'col.with.dots': { rich_text: 'updated' },
      },
    });
  });
});
