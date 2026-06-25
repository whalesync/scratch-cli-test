/**
 * Save-time validation tests for the v2 sync-mapping zod schema (DEV-10008).
 *
 * The v2 shape lifts `when` to the column mapping and makes `source` a
 * discriminated union, which introduces structural invariants the schema must
 * enforce at save time:
 *   (a) a column source is only legal with when="matched" (or omitted) — there
 *       is no source value to copy for an unmatched destination record;
 *   (b) a constant source may not target the recordMatching destination column;
 *   (c) constant values are JSON primitives only (arrays/objects deferred);
 *   (d) one mapping per (destinationColumnId, when) pair.
 *
 * These refinements are pure (no DB), so they live as a fast unit spec. The
 * executor- and DB-level behavior is covered by the integration specs.
 */

import { syncMappingV1Schema, syncMappingV2Schema } from '../sync-mapping.schema';

// Build a full v2 sync mapping around a set of column mappings, so refinements
// that live on the table/sync level (b, d) are exercised, not just the
// per-column ones (a, c).
const v2Sync = (columnMappings: unknown[], tableExtra: Record<string, unknown> = {}): unknown => ({
  version: 2,
  tableMappings: [
    {
      sourceDataFolderId: 'src-folder',
      destinationDataFolderId: 'dest-folder',
      columnMappings,
      recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email' },
      ...tableExtra,
    },
  ],
});

const issuePaths = (result: ReturnType<typeof syncMappingV2Schema.safeParse>): string[] =>
  result.success ? [] : result.error.issues.map((i) => i.path.join('.'));

const issueMessages = (result: ReturnType<typeof syncMappingV2Schema.safeParse>): string =>
  result.success ? '' : result.error.issues.map((i) => i.message).join(' | ');

describe('syncMappingV2Schema — save-time validation', () => {
  it('accepts the DEV-10008 archive worked example', () => {
    const result = syncMappingV2Schema.safeParse(
      v2Sync(
        [
          { destinationColumnId: 'name', source: { kind: 'column', columnId: 'name' } },
          { destinationColumnId: 'archived', when: 'matched', source: { kind: 'constant', value: false } },
          { destinationColumnId: 'archived', when: 'unmatched', source: { kind: 'constant', value: true } },
        ],
        { unmatchedDestinationPolicy: { withMatchKey: 'apply', withoutMatchKey: 'ignore' } },
      ),
    );
    expect(result.success).toBe(true);
  });

  it('accepts two rules for the same destination column with different `when` values', () => {
    const result = syncMappingV2Schema.safeParse(
      v2Sync([
        { destinationColumnId: 'archived', when: 'matched', source: { kind: 'constant', value: false } },
        { destinationColumnId: 'archived', when: 'unmatched', source: { kind: 'constant', value: true } },
      ]),
    );
    expect(result.success).toBe(true);
  });

  it('(a) rejects a column source with when="unmatched"', () => {
    const result = syncMappingV2Schema.safeParse(
      v2Sync([{ destinationColumnId: 'name', when: 'unmatched', source: { kind: 'column', columnId: 'name' } }]),
    );
    expect(result.success).toBe(false);
    expect(issuePaths(result).some((p) => p.endsWith('when'))).toBe(true);
  });

  it('(a) rejects a column source with when="always"', () => {
    const result = syncMappingV2Schema.safeParse(
      v2Sync([{ destinationColumnId: 'name', when: 'always', source: { kind: 'column', columnId: 'name' } }]),
    );
    expect(result.success).toBe(false);
    expect(issuePaths(result).some((p) => p.endsWith('when'))).toBe(true);
  });

  it('accepts a column source with when="matched" (and with `when` omitted)', () => {
    expect(
      syncMappingV2Schema.safeParse(
        v2Sync([{ destinationColumnId: 'name', when: 'matched', source: { kind: 'column', columnId: 'name' } }]),
      ).success,
    ).toBe(true);
    expect(
      syncMappingV2Schema.safeParse(
        v2Sync([{ destinationColumnId: 'name', source: { kind: 'column', columnId: 'name' } }]),
      ).success,
    ).toBe(true);
  });

  it('(b) rejects a constant mapping that targets the recordMatching destination column', () => {
    const result = syncMappingV2Schema.safeParse(
      v2Sync([
        { destinationColumnId: 'name', source: { kind: 'column', columnId: 'name' } },
        // `email` is the recordMatching.destinationColumnId.
        { destinationColumnId: 'email', when: 'matched', source: { kind: 'constant', value: 'spoofed@example.com' } },
      ]),
    );
    expect(result.success).toBe(false);
    expect(issueMessages(result)).toMatch(/recordMatching destination column/i);
  });

  it('(d) rejects a duplicate (destinationColumnId, when) pair', () => {
    const result = syncMappingV2Schema.safeParse(
      v2Sync([
        { destinationColumnId: 'archived', when: 'matched', source: { kind: 'constant', value: false } },
        { destinationColumnId: 'archived', when: 'matched', source: { kind: 'constant', value: true } },
      ]),
    );
    expect(result.success).toBe(false);
    expect(issueMessages(result)).toMatch(/Duplicate mapping/i);
  });

  it('(c) rejects a constant value that is not a JSON primitive', () => {
    const objectValue = syncMappingV2Schema.safeParse(
      v2Sync([{ destinationColumnId: 'meta', source: { kind: 'constant', value: { nested: true } } }]),
    );
    const arrayValue = syncMappingV2Schema.safeParse(
      v2Sync([{ destinationColumnId: 'meta', source: { kind: 'constant', value: [1, 2, 3] } }]),
    );
    expect(objectValue.success).toBe(false);
    expect(arrayValue.success).toBe(false);
  });

  it('accepts all JSON primitive constant values (string, number, boolean, null)', () => {
    for (const value of ['a string', 42, true, false, null]) {
      const result = syncMappingV2Schema.safeParse(
        v2Sync([{ destinationColumnId: 'col', when: 'unmatched', source: { kind: 'constant', value } }]),
      );
      expect(result.success).toBe(true);
    }
  });

  it('accepts a wrap_object source transformer that carries an emptyTemplate (clear-on-empty)', () => {
    const result = syncMappingV2Schema.safeParse(
      v2Sync([
        {
          destinationColumnId: 'due',
          source: {
            kind: 'column',
            columnId: 'due',
            transformers: [
              {
                type: 'wrap_object',
                options: {
                  template: { type: 'date', date: { start: '$value' } },
                  emptyTemplate: { type: 'date', date: null },
                },
              },
            ],
          },
        },
      ]),
    );
    expect(result.success).toBe(true);
  });

  it('rejects a column source that sets both `transformer` and `transformers`', () => {
    const result = syncMappingV2Schema.safeParse(
      v2Sync([
        {
          destinationColumnId: 'name',
          source: { kind: 'column', columnId: 'name', transformer: { type: 'trim' }, transformers: [{ type: 'trim' }] },
        },
      ]),
    );
    expect(result.success).toBe(false);
    expect(issueMessages(result)).toMatch(/Cannot set both/i);
  });

  it('rejects an unknown source.kind (discriminated union)', () => {
    const result = syncMappingV2Schema.safeParse(
      v2Sync([{ destinationColumnId: 'name', source: { kind: 'lookup', columnId: 'name' } }]),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an invalid unmatchedDestinationPolicy value', () => {
    const result = syncMappingV2Schema.safeParse(
      v2Sync([{ destinationColumnId: 'name', source: { kind: 'column', columnId: 'name' } }], {
        unmatchedDestinationPolicy: { withMatchKey: 'archive', withoutMatchKey: 'ignore' },
      }),
    );
    expect(result.success).toBe(false);
  });

  it('validates unmatchedSourcePolicy as a discriminated union on `type`', () => {
    const baseCol = [{ destinationColumnId: 'name', source: { kind: 'column', columnId: 'name' } }];
    expect(syncMappingV2Schema.safeParse(v2Sync(baseCol, { unmatchedSourcePolicy: { type: 'create' } })).success).toBe(
      true,
    );
    expect(syncMappingV2Schema.safeParse(v2Sync(baseCol, { unmatchedSourcePolicy: { type: 'ignore' } })).success).toBe(
      true,
    );
    expect(syncMappingV2Schema.safeParse(v2Sync(baseCol, { unmatchedSourcePolicy: { type: 'delete' } })).success).toBe(
      false,
    );
  });

  it('rejects a v2 document whose version is not literally 2', () => {
    const result = syncMappingV2Schema.safeParse(
      v2Sync([{ destinationColumnId: 'name', source: { kind: 'column', columnId: 'name' } }]),
    );
    expect(result.success).toBe(true);
    const wrongVersion = syncMappingV2Schema.safeParse({
      version: 1,
      tableMappings: [
        {
          sourceDataFolderId: 'src',
          destinationDataFolderId: 'dest',
          columnMappings: [{ destinationColumnId: 'name', source: { kind: 'column', columnId: 'name' } }],
        },
      ],
    });
    expect(wrongVersion.success).toBe(false);
  });

  it('still accepts a well-formed v1 mapping (v1 schema unchanged)', () => {
    const result = syncMappingV1Schema.safeParse({
      version: 1,
      tableMappings: [
        {
          sourceDataFolderId: 'src',
          destinationDataFolderId: 'dest',
          columnMappings: [{ sourceColumnId: 'email', destinationColumnId: 'email' }],
          recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email' },
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});
