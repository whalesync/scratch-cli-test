import {
  createSyncDraftSchema,
  draftTableMappingSchema,
  patchSyncDraftSchema,
  type DraftTableMapping,
} from '@spinner/shared-types';
import { z } from 'zod';

type ParseResult = { success: boolean; error?: z.ZodError };

/**
 * Direct validation tests for the SyncDraft request schemas exported from
 * `@spinner/shared-types`. These ARE the wire contract the cross-repo RPC client
 * must satisfy, and the global ZodValidationPipe rejects anything that fails them
 * — so the discriminated unions and the `fieldAdditions`-on-placeholder refinement
 * get pinned here rather than only indirectly through the HTTP layer.
 */

const issuePaths = (result: ParseResult): string[] =>
  (result.error?.issues ?? []).map((issue) => issue.path.map(String).join('.'));

const issueCodes = (result: ParseResult): (string | undefined)[] =>
  (result.error?.issues ?? []).map((issue) => (issue as { params?: { code?: string } }).params?.code);

/** A valid table mapping into an existing destination table. */
function existingMapping(overrides: Partial<DraftTableMapping> = {}): unknown {
  return {
    ref: 'tm1',
    source: { dataFolderId: 'dfd_src' },
    destination: { kind: 'existing', dataFolderId: 'dfd_dst' },
    columnMappings: [{ source: { columnId: 'title' }, destination: { kind: 'existing', columnId: 'name' } }],
    ...overrides,
  };
}

/** A valid table mapping that creates a new destination table. */
function placeholderMapping(overrides: Record<string, unknown> = {}): unknown {
  return {
    ref: 'tm1',
    source: { dataFolderId: 'dfd_src' },
    destination: {
      kind: 'placeholderTable',
      ref: 'ph_contacts',
      connectorAccountId: 'coa_1',
      remoteParentId: ['base1'],
      createSpec: { ref: 's1', name: 'Contacts', fields: [{ name: 'Name', fieldType: { kind: 'text' } }] },
    },
    columnMappings: [{ source: { columnId: 'title' }, destination: { kind: 'placeholderField', ref: 'Name' } }],
    ...overrides,
  };
}

describe('createSyncDraftSchema', () => {
  it('accepts an empty body (blank draft)', () => {
    expect(createSyncDraftSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a string fromSyncId', () => {
    expect(createSyncDraftSchema.safeParse({ fromSyncId: 'syn_abc' }).success).toBe(true);
  });

  it('rejects a non-string fromSyncId', () => {
    expect(createSyncDraftSchema.safeParse({ fromSyncId: 123 }).success).toBe(false);
  });
});

describe('patchSyncDraftSchema', () => {
  it('requires version', () => {
    const result = patchSyncDraftSchema.safeParse({ displayName: 'x' });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('version');
  });

  it('accepts a version-only patch', () => {
    expect(patchSyncDraftSchema.safeParse({ version: 3 }).success).toBe(true);
  });

  it('rejects a negative version', () => {
    expect(patchSyncDraftSchema.safeParse({ version: -1 }).success).toBe(false);
  });

  it('allows schedule to be cleared with null', () => {
    expect(patchSyncDraftSchema.safeParse({ version: 1, schedule: null }).success).toBe(true);
  });

  it('rejects a non-string, non-null schedule', () => {
    expect(patchSyncDraftSchema.safeParse({ version: 1, schedule: 5 }).success).toBe(false);
  });

  it('accepts a full valid tableMappings payload', () => {
    const result = patchSyncDraftSchema.safeParse({
      version: 1,
      tableMappings: [existingMapping(), placeholderMapping()],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a malformed tableMappings entry', () => {
    const result = patchSyncDraftSchema.safeParse({
      version: 1,
      tableMappings: [existingMapping({ destination: { kind: 'bogus', dataFolderId: 'x' } as never })],
    });
    expect(result.success).toBe(false);
  });
});

describe('draftTableMappingSchema', () => {
  it('accepts an existing-destination mapping', () => {
    expect(draftTableMappingSchema.safeParse(existingMapping()).success).toBe(true);
  });

  it('accepts a placeholder-table mapping with a placeholderField column', () => {
    expect(draftTableMappingSchema.safeParse(placeholderMapping()).success).toBe(true);
  });

  it('rejects an unknown destination kind', () => {
    const result = draftTableMappingSchema.safeParse(
      existingMapping({ destination: { kind: 'nope', dataFolderId: 'x' } as never }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an unknown column-destination kind', () => {
    const result = draftTableMappingSchema.safeParse(
      existingMapping({
        columnMappings: [{ source: { columnId: 'a' }, destination: { kind: 'mystery', columnId: 'b' } } as never],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects fieldAdditions on a placeholderTable destination (superRefine)', () => {
    const result = draftTableMappingSchema.safeParse(
      placeholderMapping({
        fieldAdditions: [{ ref: 'fa1', createFieldSpec: { name: 'Phone', fieldType: { kind: 'phone' } } }],
      }),
    );
    expect(result.success).toBe(false);
    expect(issueCodes(result)).toContain('FIELD_ADDITIONS_ON_PLACEHOLDER_TABLE');
  });

  it('validates the embedded createSpec (rejects a table with zero fields)', () => {
    const result = draftTableMappingSchema.safeParse(
      placeholderMapping({
        destination: {
          kind: 'placeholderTable',
          ref: 'ph1',
          connectorAccountId: 'coa_1',
          createSpec: { ref: 's1', name: 'Contacts', fields: [] },
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts fieldAdditions on an existing destination', () => {
    const result = draftTableMappingSchema.safeParse(
      existingMapping({
        fieldAdditions: [{ ref: 'fa1', createFieldSpec: { name: 'Phone', fieldType: { kind: 'phone' } } }],
      }),
    );
    expect(result.success).toBe(true);
  });
});
