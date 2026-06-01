import type { DataFolderId, SyncMappingV1, SyncMappingV2 } from '@spinner/shared-types';
import {
  coerceUnknownToV2,
  constantDefaultForType,
  createFieldMapping,
  createFolderPair,
  findConflictingMappingIds,
  folderPairsToV2,
  groupByDestColumn,
  isSimpleGroup,
  resolveStoredMapping,
  storedMappingToV2,
  v2ToFolderPairs,
  validateV2Semantics,
} from '../sync-editor-model';

const SRC = 'fld_src' as DataFolderId;
const DST = 'fld_dst' as DataFolderId;

describe('folderPairsToV2', () => {
  it('serializes a plain matched column copy without a when field', () => {
    const pair = createFolderPair({
      sourceId: SRC,
      destId: DST,
      fieldMappings: [createFieldMapping({ destField: 'name', kind: 'column', sourceField: 'Title' })],
    });

    const v2 = folderPairsToV2([pair]);

    expect(v2).toEqual<SyncMappingV2>({
      version: 2,
      tableMappings: [
        {
          sourceDataFolderId: SRC,
          destinationDataFolderId: DST,
          columnMappings: [{ destinationColumnId: 'name', source: { kind: 'column', columnId: 'Title' } }],
        },
      ],
    });
  });

  it('emits the DEV-10008 archive shape: matched constant false + unmatched constant true + policy', () => {
    const pair = createFolderPair({
      sourceId: SRC,
      destId: DST,
      fieldMappings: [
        createFieldMapping({ destField: 'name', kind: 'column', sourceField: 'Title' }),
        createFieldMapping({ destField: 'archived', when: 'matched', kind: 'constant', constantValue: false }),
        createFieldMapping({ destField: 'archived', when: 'unmatched', kind: 'constant', constantValue: true }),
      ],
      matchingSourceField: 'Title',
      matchingDestinationField: 'name',
      unmatchedWithMatchKey: 'apply',
      unmatchedWithoutMatchKey: 'ignore',
    });

    const v2 = folderPairsToV2([pair]);

    expect(v2.tableMappings[0].columnMappings).toEqual([
      { destinationColumnId: 'name', source: { kind: 'column', columnId: 'Title' } },
      { destinationColumnId: 'archived', source: { kind: 'constant', value: false } },
      { destinationColumnId: 'archived', when: 'unmatched', source: { kind: 'constant', value: true } },
    ]);
    expect(v2.tableMappings[0].unmatchedDestinationPolicy).toEqual({
      withMatchKey: 'apply',
      withoutMatchKey: 'ignore',
    });
    expect(v2.tableMappings[0].recordMatching).toEqual({ sourceColumnId: 'Title', destinationColumnId: 'name' });
  });

  it('omits default policies and incomplete pairs/rules', () => {
    const incomplete = createFolderPair({ sourceId: SRC, destId: '', fieldMappings: [createFieldMapping()] });
    const valid = createFolderPair({
      sourceId: SRC,
      destId: DST,
      fieldMappings: [
        createFieldMapping({ destField: 'name', kind: 'column', sourceField: 'Title' }),
        createFieldMapping({ destField: '', kind: 'column', sourceField: 'Body' }), // incomplete -> dropped
      ],
      unmatchedSourcePolicy: 'create',
    });

    const v2 = folderPairsToV2([incomplete, valid]);

    expect(v2.tableMappings).toHaveLength(1);
    expect(v2.tableMappings[0].columnMappings).toHaveLength(1);
    expect(v2.tableMappings[0].unmatchedSourcePolicy).toBeUndefined();
    expect(v2.tableMappings[0].unmatchedDestinationPolicy).toBeUndefined();
  });

  it('serializes unmatchedSourcePolicy: ignore when chosen', () => {
    const pair = createFolderPair({
      sourceId: SRC,
      destId: DST,
      fieldMappings: [createFieldMapping({ destField: 'name', kind: 'column', sourceField: 'Title' })],
      unmatchedSourcePolicy: 'ignore',
    });
    expect(folderPairsToV2([pair]).tableMappings[0].unmatchedSourcePolicy).toEqual({ type: 'ignore' });
  });

  it('preserves a transformers pipeline on column sources', () => {
    const pair = createFolderPair({
      sourceId: SRC,
      destId: DST,
      fieldMappings: [
        createFieldMapping({
          destField: 'slug',
          kind: 'column',
          sourceField: 'Title',
          transformers: [{ type: 'slugify' }],
        }),
      ],
    });
    expect(folderPairsToV2([pair]).tableMappings[0].columnMappings[0]).toEqual({
      destinationColumnId: 'slug',
      source: { kind: 'column', columnId: 'Title', transformers: [{ type: 'slugify' }] },
    });
  });
});

describe('v2ToFolderPairs round-trip', () => {
  it('round-trips the archive shape back to editor model', () => {
    const v2: SyncMappingV2 = {
      version: 2,
      tableMappings: [
        {
          sourceDataFolderId: SRC,
          destinationDataFolderId: DST,
          columnMappings: [
            { destinationColumnId: 'name', source: { kind: 'column', columnId: 'Title' } },
            { destinationColumnId: 'archived', source: { kind: 'constant', value: false } },
            { destinationColumnId: 'archived', when: 'unmatched', source: { kind: 'constant', value: true } },
          ],
          recordMatching: { sourceColumnId: 'Title', destinationColumnId: 'name' },
          unmatchedDestinationPolicy: { withMatchKey: 'apply', withoutMatchKey: 'ignore' },
        },
      ],
    };

    const pairs = v2ToFolderPairs(v2, []);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].unmatchedWithMatchKey).toBe('apply');
    expect(pairs[0].unmatchedWithoutMatchKey).toBe('ignore');
    expect(pairs[0].matchingSourceField).toBe('Title');

    // model -> v2 is byte-identical to the input
    expect(folderPairsToV2(pairs)).toEqual(v2);
  });

  it('defaults policies to create/ignore when absent', () => {
    const v2: SyncMappingV2 = {
      version: 2,
      tableMappings: [
        {
          sourceDataFolderId: SRC,
          destinationDataFolderId: DST,
          columnMappings: [{ destinationColumnId: 'name', source: { kind: 'column', columnId: 'Title' } }],
        },
      ],
    };
    const pair = v2ToFolderPairs(v2, [])[0];
    expect(pair.unmatchedSourcePolicy).toBe('create');
    expect(pair.unmatchedWithMatchKey).toBe('ignore');
    expect(pair.unmatchedWithoutMatchKey).toBe('ignore');
  });
});

describe('storedMappingToV2', () => {
  it('passes a v2 mapping through unchanged', () => {
    const v2: SyncMappingV2 = { version: 2, tableMappings: [] };
    expect(storedMappingToV2(v2)).toBe(v2);
  });

  it('upgrades a v1 mapping in memory', () => {
    const v1: SyncMappingV1 = {
      version: 1,
      tableMappings: [
        {
          sourceDataFolderId: SRC,
          destinationDataFolderId: DST,
          columnMappings: [{ sourceColumnId: 'Title', destinationColumnId: 'name' }],
        },
      ],
    };
    const v2 = storedMappingToV2(v1);
    expect(v2.version).toBe(2);
    expect(v2.tableMappings[0].columnMappings[0]).toEqual({
      destinationColumnId: 'name',
      source: { kind: 'column', columnId: 'Title' },
    });
  });
});

describe('resolveStoredMapping', () => {
  const v1: SyncMappingV1 = { version: 1, tableMappings: [] };
  const v2: SyncMappingV2 = { version: 2, tableMappings: [] };

  it('prefers mappingsV2 when present', () => {
    expect(resolveStoredMapping({ mappings: v1, mappingsV2: v2 })).toBe(v2);
  });
  it('falls back to v1 mappings when mappingsV2 is null', () => {
    expect(resolveStoredMapping({ mappings: v1, mappingsV2: null })).toBe(v1);
  });
  it('returns null when nothing is present', () => {
    expect(resolveStoredMapping({ mappings: null, mappingsV2: null })).toBeNull();
  });
});

describe('coerceUnknownToV2', () => {
  it('accepts a v2 object as-is', () => {
    const v2 = { version: 2, tableMappings: [] };
    const res = coerceUnknownToV2(v2);
    expect(res).toEqual({ ok: true, mapping: v2, upgradedFromV1: false });
  });

  it('upgrades a v1 object and flags upgradedFromV1', () => {
    const v1 = {
      version: 1,
      tableMappings: [
        {
          sourceDataFolderId: SRC,
          destinationDataFolderId: DST,
          columnMappings: [{ sourceColumnId: 'a', destinationColumnId: 'b' }],
        },
      ],
    };
    const res = coerceUnknownToV2(v1);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.upgradedFromV1).toBe(true);
      expect(res.mapping.version).toBe(2);
    }
  });

  it('rejects non-objects and unknown versions', () => {
    expect(coerceUnknownToV2('nope').ok).toBe(false);
    expect(coerceUnknownToV2({ version: 3, tableMappings: [] }).ok).toBe(false);
    expect(coerceUnknownToV2({ version: 2, tableMappings: [{ destinationDataFolderId: DST }] }).ok).toBe(false);
  });

  it('rejects a structurally-valid but semantically-illegal v2 (column source on the unmatched bucket)', () => {
    const illegal = {
      version: 2,
      tableMappings: [
        {
          sourceDataFolderId: SRC,
          destinationDataFolderId: DST,
          columnMappings: [
            { destinationColumnId: 'name', when: 'unmatched', source: { kind: 'column', columnId: 'Title' } },
          ],
        },
      ],
    };
    expect(coerceUnknownToV2(illegal).ok).toBe(false);
  });
});

describe('validateV2Semantics', () => {
  const tableMapping = (
    columnMappings: unknown[],
    recordMatching?: { sourceColumnId: string; destinationColumnId: string },
  ) =>
    ({
      version: 2,
      tableMappings: [
        {
          sourceDataFolderId: SRC,
          destinationDataFolderId: DST,
          columnMappings,
          ...(recordMatching ? { recordMatching } : {}),
        },
      ],
    }) as SyncMappingV2;

  it('passes the legal archive shape', () => {
    expect(
      validateV2Semantics(
        tableMapping(
          [
            { destinationColumnId: 'name', source: { kind: 'column', columnId: 'Title' } },
            { destinationColumnId: 'archived', source: { kind: 'constant', value: false } },
            { destinationColumnId: 'archived', when: 'unmatched', source: { kind: 'constant', value: true } },
          ],
          { sourceColumnId: 'Title', destinationColumnId: 'name' },
        ),
      ),
    ).toBeNull();
  });

  it('(a) rejects a column source on the unmatched/always bucket', () => {
    expect(
      validateV2Semantics(
        tableMapping([{ destinationColumnId: 'x', when: 'unmatched', source: { kind: 'column', columnId: 'y' } }]),
      ),
    ).toMatch(/source-column copy can only run for matched/i);
  });

  it('(b) rejects a constant targeting the record-matching destination column', () => {
    expect(
      validateV2Semantics(
        tableMapping([{ destinationColumnId: 'name', source: { kind: 'constant', value: 'x' } }], {
          sourceColumnId: 'Title',
          destinationColumnId: 'name',
        }),
      ),
    ).toMatch(/record-matching key/i);
  });

  it('(d) rejects two rules on the same (destinationColumnId, when)', () => {
    expect(
      validateV2Semantics(
        tableMapping([
          { destinationColumnId: 'name', source: { kind: 'column', columnId: 'A' } },
          { destinationColumnId: 'name', source: { kind: 'column', columnId: 'B' } },
        ]),
      ),
    ).toMatch(/more than one rule/i);
  });
});

describe('groupByDestColumn / isSimpleGroup', () => {
  it('keeps incomplete rows as standalone groups and groups same-dest rules with matched first', () => {
    const a = createFieldMapping({ destField: 'name', kind: 'column', sourceField: 'Title' });
    const unmatched = createFieldMapping({
      destField: 'archived',
      when: 'unmatched',
      kind: 'constant',
      constantValue: true,
    });
    const matched = createFieldMapping({
      destField: 'archived',
      when: 'matched',
      kind: 'constant',
      constantValue: false,
    });
    const blank = createFieldMapping();

    const groups = groupByDestColumn([a, unmatched, matched, blank]);
    expect(groups.map((g) => g.destField)).toEqual(['name', 'archived', '']);

    const archived = groups[1];
    expect(archived.rules.map((r) => r.mapping.when)).toEqual(['matched', 'unmatched']);
    // original indices preserved for mutation
    expect(archived.rules.map((r) => r.index).sort()).toEqual([1, 2]);

    expect(isSimpleGroup(groups[0])).toBe(true); // plain matched column copy
    expect(isSimpleGroup(groups[1])).toBe(false); // multi-rule constant group
    expect(isSimpleGroup(groups[2])).toBe(false); // incomplete row
  });
});

describe('findConflictingMappingIds', () => {
  it('flags two complete rules colliding on (destField, when)', () => {
    const a = createFieldMapping({ destField: 'name', kind: 'column', sourceField: 'Title' });
    const b = createFieldMapping({ destField: 'name', kind: 'column', sourceField: 'Other' });
    const c = createFieldMapping({ destField: 'name', when: 'unmatched', kind: 'constant', constantValue: 'x' });

    const conflicts = findConflictingMappingIds([a, b, c]);
    expect(conflicts.has(a.id)).toBe(true);
    expect(conflicts.has(b.id)).toBe(true);
    expect(conflicts.has(c.id)).toBe(false); // different when -> legal
  });
});

describe('constantDefaultForType', () => {
  it('maps schema types to sensible defaults', () => {
    expect(constantDefaultForType('boolean')).toBe(false);
    expect(constantDefaultForType('number')).toBe(0);
    expect(constantDefaultForType('integer')).toBe(0);
    expect(constantDefaultForType('string')).toBe('');
    expect(constantDefaultForType(undefined)).toBe('');
  });
});
