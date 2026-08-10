import { createScratchPendingPublishId, DataFolderId, SourceFkToDestFkOptions } from '@spinner/shared-types';
import { Service } from 'src/remote-service/connectors/service-constants';
import { sourceFkToDestFkTransformer } from '../implementations/source-fk-to-dest-fk.transformer';
import { DestinationMappingResolution, LookupTools, SyncRecord, TransformContext } from '../transformer.types';

const REFERENCED_FOLDER = 'dfd_dest_authors' as DataFolderId;

// The destination connection folder the producer prepends to make a pseudo-ref
// workspace-absolute (DEV-10880). All `@/…` expectations below carry it.
const DEST_CONN = 'DestConn';

function createLookupTools(
  mapping: Record<
    string,
    { destinationFilePath: string; destinationRemoteId: string | null; destinationConnectionFolder?: string }
  > = {},
): LookupTools {
  return {
    // Identity: these fixtures reference targets by remote id, the default contract.
    resolveForeignKeyValueToTargetRemoteId: jest.fn((value: string) =>
      Promise.resolve({ kind: 'resolved', targetSourceRemoteId: value } as const),
    ),
    getDestinationMappingForSourceFk: jest.fn((fk: string): Promise<DestinationMappingResolution> => {
      const entry = mapping[fk];
      if (!entry) return Promise.resolve({ kind: 'no_destination_record' });
      return Promise.resolve({
        kind: 'mapped',
        mapping: {
          destinationFilePath: entry.destinationFilePath,
          destinationRemoteId: entry.destinationRemoteId,
          destinationConnectionFolder: entry.destinationConnectionFolder ?? DEST_CONN,
        },
      });
    }),
    lookupFieldFromFkRecord: jest.fn(),
    getOrCreateDestinationAssetMapping: jest.fn(),
    matchDestinationAssetByHash: jest.fn().mockResolvedValue([]),
  };
}

/**
 * Lookup tools whose referenced folder resolves to a destination record whose CONNECTION is
 * unknown — the state in which this producer has no connection folder to prepend.
 */
function createConnectionUnresolvedLookupTools(reason: string): LookupTools {
  return {
    ...createLookupTools(),
    getDestinationMappingForSourceFk: jest.fn(() =>
      Promise.resolve({ kind: 'destination_connection_unresolved' as const, reason }),
    ),
  };
}

/** Shorthand: creates lookup tools from a simple fk→filePath mapping (destinationRemoteId defaults to null) */
function createSimpleLookupTools(mapping: Record<string, string> = {}): LookupTools {
  const full: Record<string, { destinationFilePath: string; destinationRemoteId: string | null }> = {};
  for (const [key, value] of Object.entries(mapping)) {
    full[key] = { destinationFilePath: value, destinationRemoteId: null };
  }
  return createLookupTools(full);
}

function createContext(
  sourceValue: unknown,
  lookupTools: LookupTools,
  options: SourceFkToDestFkOptions = { referencedDataFolderId: REFERENCED_FOLDER },
  phase: 'DATA' | 'FOREIGN_KEY_MAPPING' = 'FOREIGN_KEY_MAPPING',
  destinationValue?: unknown,
): TransformContext {
  const sourceRecord: SyncRecord = { id: 'test', filePath: '/test.json', fields: { fk: sourceValue } };
  return {
    sourceRecord,
    sourceFieldPath: 'fk',
    sourceValue,
    sourceTableSpec: null,
    sourceService: Service.AIRTABLE,
    destinationFieldPath: 'fk',
    destinationTableSpec: null,
    destinationService: Service.WEBFLOW,
    lookupTools,
    destinationValue,
    options,
    phase,
  };
}

describe('sourceFkToDestFkTransformer', () => {
  it('should have correct type', () => {
    expect(sourceFkToDestFkTransformer.type).toBe('source_fk_to_dest_fk');
  });

  describe('null/undefined handling', () => {
    it('should return null for null input', async () => {
      const result = await sourceFkToDestFkTransformer.transform(createContext(null, createSimpleLookupTools()));
      expect(result).toEqual({ success: true, value: null });
    });

    it('should return null for undefined input', async () => {
      const result = await sourceFkToDestFkTransformer.transform(createContext(undefined, createSimpleLookupTools()));
      expect(result).toEqual({ success: true, value: null });
    });
  });

  describe('scalar resolution', () => {
    it('should resolve a string FK to a workspace-absolute pseudo-ref (connection folder first)', async () => {
      const lookup = createSimpleLookupTools({ src_1: 'dest-authors/alice.json' });
      const result = await sourceFkToDestFkTransformer.transform(createContext('src_1', lookup));
      expect(result).toEqual({ success: true, value: '@/DestConn/dest-authors/alice.json' });
    });

    it('should resolve a numeric FK', async () => {
      const lookup = createSimpleLookupTools({ '42': 'dest-authors/bob.json' });
      const result = await sourceFkToDestFkTransformer.transform(createContext(42, lookup));
      expect(result).toEqual({ success: true, value: '@/DestConn/dest-authors/bob.json' });
    });

    // A ref without its connection segment does not resolve at publish, so an unknown
    // destination connection has to fail here rather than write a reference that fails later.
    it('fails instead of emitting a ref without a connection folder when the destination connection is unknown', async () => {
      const lookup = createConnectionUnresolvedLookupTools(
        'the destination folder "Authors" (dfd_x) is not attached to a connection',
      );
      const result = await sourceFkToDestFkTransformer.transform(createContext('src_1', lookup));

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Could not build a reference for foreign key "src_1"');
        expect(result.error).toContain('is not attached to a connection');
      }
    });

    it('fails on an unknown destination connection even under onUnresolved: "ignore"', async () => {
      // `ignore` forgives a target we cannot FIND, not a target we cannot ADDRESS — silently
      // dropping the link here would be the "swallow and lie" the product principles forbid.
      const lookup = createConnectionUnresolvedLookupTools('this sync has no table pair whose source folder is dfd_x');
      const result = await sourceFkToDestFkTransformer.transform(
        createContext('src_1', lookup, { referencedDataFolderId: REFERENCED_FOLDER, onUnresolved: 'ignore' }),
      );

      expect(result.success).toBe(false);
    });

    it('should fail when FK cannot be resolved', async () => {
      const result = await sourceFkToDestFkTransformer.transform(createContext('missing', createSimpleLookupTools()));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Could not resolve foreign key "missing"');
      }
    });
  });

  describe('array resolution', () => {
    it('should resolve an array of FKs', async () => {
      const lookup = createSimpleLookupTools({ src_1: 'authors/alice.json', src_2: 'authors/bob.json' });
      const result = await sourceFkToDestFkTransformer.transform(createContext(['src_1', 'src_2'], lookup));
      expect(result).toEqual({
        success: true,
        value: ['@/DestConn/authors/alice.json', '@/DestConn/authors/bob.json'],
      });
    });

    it('should skip null/undefined elements in arrays', async () => {
      const lookup = createSimpleLookupTools({ src_1: 'authors/alice.json' });
      const result = await sourceFkToDestFkTransformer.transform(createContext(['src_1', null, undefined], lookup));
      expect(result).toEqual({ success: true, value: ['@/DestConn/authors/alice.json'] });
    });

    it('should fail if any array element cannot be resolved', async () => {
      const lookup = createSimpleLookupTools({ src_1: 'authors/alice.json' });
      const result = await sourceFkToDestFkTransformer.transform(createContext(['src_1', 'missing'], lookup));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Could not resolve foreign key "missing"');
      }
    });

    it('should fail for non-string/number array elements', async () => {
      const lookup = createSimpleLookupTools();
      const result = await sourceFkToDestFkTransformer.transform(createContext([{ id: 1 }], lookup));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Expected string or number for FK array element');
      }
    });
  });

  describe('error cases', () => {
    it('should fail for object input', async () => {
      const result = await sourceFkToDestFkTransformer.transform(createContext({ id: 1 }, createSimpleLookupTools()));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Expected string, number, or array');
      }
    });

    it('should fail for boolean input', async () => {
      const result = await sourceFkToDestFkTransformer.transform(createContext(true, createSimpleLookupTools()));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Expected string, number, or array');
      }
    });
  });

  describe('valuesMeaningNoLink — a source sentinel for "not linked" (DEV-11093, DEV-11094)', () => {
    // WordPress writes `featured_media: 0` on a post with no featured image and `parent: 0`
    // on a top-level page, rather than null. Without the declaration those look like ids that
    // simply don't resolve, which fails the record — and a failed record fails its whole
    // table and skips publish-after-sync, so one unlinked post takes the export down.
    const SENTINEL_ZERO: SourceFkToDestFkOptions = {
      referencedDataFolderId: REFERENCED_FOLDER,
      valuesMeaningNoLink: ['0'],
    };

    it.each([
      ['the number WordPress actually stores', 0],
      ['the same value as a string', '0'],
    ])('treats %s as empty rather than failing the record', async (_label, sentinelValue) => {
      // A lookup that THROWS from either step: the sentinel names no target, so neither the
      // key/id resolution nor the destination-mapping lookup should ever be reached.
      const lookup: LookupTools = {
        ...createSimpleLookupTools(),
        resolveForeignKeyValueToTargetRemoteId: () => {
          throw new Error('should not resolve a declared no-link sentinel to a target');
        },
        getDestinationMappingForSourceFk: () => {
          throw new Error('should not look up a declared no-link sentinel');
        },
      };
      const result = await sourceFkToDestFkTransformer.transform(createContext(sentinelValue, lookup, SENTINEL_ZERO));
      expect(result).toEqual({ success: true, value: null });
    });

    it('drops the sentinel from an array while resolving its real siblings', async () => {
      const lookup = createSimpleLookupTools({ '7': 'dest-authors/alice.json' });
      const result = await sourceFkToDestFkTransformer.transform(createContext([0, 7], lookup, SENTINEL_ZERO));
      expect(result).toEqual({ success: true, value: [`@/${DEST_CONN}/dest-authors/alice.json`] });
    });

    it('still fails a genuinely dangling id — only the DECLARED sentinel is forgiven', async () => {
      const result = await sourceFkToDestFkTransformer.transform(
        createContext(404, createSimpleLookupTools(), SENTINEL_ZERO),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Could not resolve foreign key "404"');
      }
    });

    it('leaves the sentinel alone when the column declares none (unchanged behavior)', async () => {
      const result = await sourceFkToDestFkTransformer.transform(createContext(0, createSimpleLookupTools()));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Could not resolve foreign key "0"');
      }
    });
  });

  describe('skip when destination value is unchanged', () => {
    it('should skip when destination already has the @/path reference (scalar)', async () => {
      const lookup = createSimpleLookupTools({ src_1: 'dest-authors/alice.json' });
      const result = await sourceFkToDestFkTransformer.transform(
        createContext('src_1', lookup, undefined, 'FOREIGN_KEY_MAPPING', '@/DestConn/dest-authors/alice.json'),
      );
      expect(result).toEqual({ success: true, skip: true });
    });

    it('should skip when destination has raw destination record ID (scalar)', async () => {
      const lookup = createLookupTools({
        src_1: { destinationFilePath: 'dest-authors/alice.json', destinationRemoteId: '99' },
      });
      const result = await sourceFkToDestFkTransformer.transform(
        createContext('src_1', lookup, undefined, 'FOREIGN_KEY_MAPPING', '99'),
      );
      expect(result).toEqual({ success: true, skip: true });
    });

    it('should skip for numeric FK with numeric destination value', async () => {
      const lookup = createLookupTools({
        '42': { destinationFilePath: 'dest-authors/bob.json', destinationRemoteId: '100' },
      });
      const result = await sourceFkToDestFkTransformer.transform(
        createContext(42, lookup, undefined, 'FOREIGN_KEY_MAPPING', 100),
      );
      expect(result).toEqual({ success: true, skip: true });
    });

    it('should skip for arrays where all elements match @/path', async () => {
      const lookup = createSimpleLookupTools({ src_1: 'authors/alice.json', src_2: 'authors/bob.json' });
      const result = await sourceFkToDestFkTransformer.transform(
        createContext(['src_1', 'src_2'], lookup, undefined, 'FOREIGN_KEY_MAPPING', [
          '@/DestConn/authors/alice.json',
          '@/DestConn/authors/bob.json',
        ]),
      );
      expect(result).toEqual({ success: true, skip: true });
    });

    it('should skip for arrays where all elements match destination remote IDs', async () => {
      const lookup = createLookupTools({
        src_1: { destinationFilePath: 'authors/alice.json', destinationRemoteId: '10' },
        src_2: { destinationFilePath: 'authors/bob.json', destinationRemoteId: '20' },
      });
      const result = await sourceFkToDestFkTransformer.transform(
        createContext(['src_1', 'src_2'], lookup, undefined, 'FOREIGN_KEY_MAPPING', ['10', '20']),
      );
      expect(result).toEqual({ success: true, skip: true });
    });

    it('should re-write a stale connection-relative ref to the workspace-absolute form (does NOT skip)', async () => {
      // A destination still holding the pre-fix connection-relative ref no longer
      // matches the canonical form, so the transformer updates it. This is the
      // one-time migration of pending refs on the first sync after the change.
      const lookup = createSimpleLookupTools({ src_1: 'dest-authors/alice.json' });
      const result = await sourceFkToDestFkTransformer.transform(
        createContext('src_1', lookup, undefined, 'FOREIGN_KEY_MAPPING', '@/dest-authors/alice.json'),
      );
      expect(result).toEqual({ success: true, value: '@/DestConn/dest-authors/alice.json' });
    });

    it('should NOT skip when value differs', async () => {
      const lookup = createSimpleLookupTools({ src_1: 'dest-authors/alice.json' });
      const result = await sourceFkToDestFkTransformer.transform(
        createContext('src_1', lookup, undefined, 'FOREIGN_KEY_MAPPING', '@/DestConn/dest-authors/bob.json'),
      );
      expect(result).toEqual({ success: true, value: '@/DestConn/dest-authors/alice.json' });
    });

    it('should NOT skip when destinationValue is undefined (new record)', async () => {
      const lookup = createSimpleLookupTools({ src_1: 'dest-authors/alice.json' });
      const result = await sourceFkToDestFkTransformer.transform(
        createContext('src_1', lookup, undefined, 'FOREIGN_KEY_MAPPING', undefined),
      );
      expect(result).toEqual({ success: true, value: '@/DestConn/dest-authors/alice.json' });
    });

    it('should NOT skip when array lengths differ', async () => {
      const lookup = createSimpleLookupTools({ src_1: 'authors/alice.json', src_2: 'authors/bob.json' });
      const result = await sourceFkToDestFkTransformer.transform(
        createContext(['src_1', 'src_2'], lookup, undefined, 'FOREIGN_KEY_MAPPING', ['@/DestConn/authors/alice.json']),
      );
      expect(result).toEqual({
        success: true,
        value: ['@/DestConn/authors/alice.json', '@/DestConn/authors/bob.json'],
      });
    });

    it('should NOT skip when only some array elements match', async () => {
      const lookup = createSimpleLookupTools({ src_1: 'authors/alice.json', src_2: 'authors/bob.json' });
      const result = await sourceFkToDestFkTransformer.transform(
        createContext(['src_1', 'src_2'], lookup, undefined, 'FOREIGN_KEY_MAPPING', [
          '@/DestConn/authors/alice.json',
          '@/DestConn/authors/WRONG.json',
        ]),
      );
      expect(result).toEqual({
        success: true,
        value: ['@/DestConn/authors/alice.json', '@/DestConn/authors/bob.json'],
      });
    });
  });

  describe('outputType: single', () => {
    const singleOpts: SourceFkToDestFkOptions = {
      referencedDataFolderId: REFERENCED_FOLDER,
      outputType: 'single',
    };

    it('should unwrap array input to first resolved value', async () => {
      const lookup = createSimpleLookupTools({ src_1: 'authors/alice.json', src_2: 'authors/bob.json' });
      const result = await sourceFkToDestFkTransformer.transform(createContext(['src_1', 'src_2'], lookup, singleOpts));
      expect(result).toEqual({ success: true, value: '@/DestConn/authors/alice.json' });
    });

    it('should return null for empty array after ignoring unresolved', async () => {
      const lookup = createSimpleLookupTools();
      const result = await sourceFkToDestFkTransformer.transform(
        createContext(['missing'], lookup, { ...singleOpts, onUnresolved: 'ignore' }),
      );
      expect(result).toEqual({
        success: true,
        value: null,
        warnings: [expect.stringContaining('Skipped unresolved foreign key "missing"')],
      });
    });

    it('should behave the same as default for scalar input', async () => {
      const lookup = createSimpleLookupTools({ src_1: 'authors/alice.json' });
      const result = await sourceFkToDestFkTransformer.transform(createContext('src_1', lookup, singleOpts));
      expect(result).toEqual({ success: true, value: '@/DestConn/authors/alice.json' });
    });

    it('should preserve default array behavior when outputType is not set', async () => {
      const lookup = createSimpleLookupTools({ src_1: 'authors/alice.json', src_2: 'authors/bob.json' });
      const result = await sourceFkToDestFkTransformer.transform(createContext(['src_1', 'src_2'], lookup));
      expect(result).toEqual({
        success: true,
        value: ['@/DestConn/authors/alice.json', '@/DestConn/authors/bob.json'],
      });
    });
  });

  describe('outputType: array', () => {
    const arrayOpts: SourceFkToDestFkOptions = {
      referencedDataFolderId: REFERENCED_FOLDER,
      outputType: 'array',
    };

    it('wraps a SCALAR source into a one-element array (destination link field holds a list)', async () => {
      // A Webflow single-Reference field is one id string, but the destination the sync
      // builder chose (Notion relation / Airtable link) holds a LIST — the chain's
      // downstream pack consumes an array, and a leaked scalar fails the sync with
      // "map_array expects an array as input" (DEV-10942).
      const lookup = createSimpleLookupTools({ src_1: 'authors/alice.json' });
      const result = await sourceFkToDestFkTransformer.transform(createContext('src_1', lookup, arrayOpts));
      expect(result).toEqual({ success: true, value: ['@/DestConn/authors/alice.json'] });
    });

    it('keeps an array source as an array', async () => {
      const lookup = createSimpleLookupTools({ src_1: 'authors/alice.json', src_2: 'authors/bob.json' });
      const result = await sourceFkToDestFkTransformer.transform(createContext(['src_1', 'src_2'], lookup, arrayOpts));
      expect(result).toEqual({
        success: true,
        value: ['@/DestConn/authors/alice.json', '@/DestConn/authors/bob.json'],
      });
    });

    it('resolves an unresolved-and-ignored scalar to an EMPTY array (clears the list downstream)', async () => {
      const lookup = createSimpleLookupTools();
      const result = await sourceFkToDestFkTransformer.transform(
        createContext('missing', lookup, { ...arrayOpts, onUnresolved: 'ignore' }),
      );
      expect(result).toEqual({
        success: true,
        value: [],
        warnings: [expect.stringContaining('Skipped unresolved foreign key "missing"')],
      });
    });

    it('still passes null through for a null source (field untouched / cleared by the pack)', async () => {
      const result = await sourceFkToDestFkTransformer.transform(
        createContext(null, createSimpleLookupTools(), arrayOpts),
      );
      expect(result).toEqual({ success: true, value: null });
    });
  });

  describe('destinationRemoteId vs file ref selection', () => {
    it('should use real destinationRemoteId when it exists', async () => {
      const lookup = createLookupTools({
        src_1: { destinationFilePath: 'dest-authors/alice.json', destinationRemoteId: 'real-id-99' },
      });
      const result = await sourceFkToDestFkTransformer.transform(createContext('src_1', lookup));
      expect(result).toEqual({ success: true, value: 'real-id-99' });
    });

    it('should use file ref when destinationRemoteId is a pending publish placeholder', async () => {
      const pendingId = createScratchPendingPublishId();
      const lookup = createLookupTools({
        src_1: { destinationFilePath: 'dest-authors/alice.json', destinationRemoteId: pendingId },
      });
      const result = await sourceFkToDestFkTransformer.transform(createContext('src_1', lookup));
      expect(result).toEqual({ success: true, value: '@/DestConn/dest-authors/alice.json' });
    });

    it('should use file ref when destinationRemoteId is null', async () => {
      const lookup = createLookupTools({
        src_1: { destinationFilePath: 'dest-authors/alice.json', destinationRemoteId: null },
      });
      const result = await sourceFkToDestFkTransformer.transform(createContext('src_1', lookup));
      expect(result).toEqual({ success: true, value: '@/DestConn/dest-authors/alice.json' });
    });

    it('should mix real IDs and file refs in arrays', async () => {
      const pendingId = createScratchPendingPublishId();
      const lookup = createLookupTools({
        src_1: { destinationFilePath: 'authors/alice.json', destinationRemoteId: 'real-id-10' },
        src_2: { destinationFilePath: 'authors/bob.json', destinationRemoteId: pendingId },
        src_3: { destinationFilePath: 'authors/carol.json', destinationRemoteId: null },
      });
      const result = await sourceFkToDestFkTransformer.transform(createContext(['src_1', 'src_2', 'src_3'], lookup));
      expect(result).toEqual({
        success: true,
        value: ['real-id-10', '@/DestConn/authors/bob.json', '@/DestConn/authors/carol.json'],
      });
    });

    it('should skip when destination matches real destinationRemoteId', async () => {
      const lookup = createLookupTools({
        src_1: { destinationFilePath: 'dest-authors/alice.json', destinationRemoteId: 'real-id-99' },
      });
      const result = await sourceFkToDestFkTransformer.transform(
        createContext('src_1', lookup, undefined, 'FOREIGN_KEY_MAPPING', 'real-id-99'),
      );
      expect(result).toEqual({ success: true, skip: true });
    });

    it('should skip when destination has pending publish ID matching mapping', async () => {
      const pendingId = createScratchPendingPublishId();
      const lookup = createLookupTools({
        src_1: { destinationFilePath: 'dest-authors/alice.json', destinationRemoteId: pendingId },
      });
      const result = await sourceFkToDestFkTransformer.transform(
        createContext('src_1', lookup, undefined, 'FOREIGN_KEY_MAPPING', pendingId),
      );
      // doesElementMatch considers the pending ID a match via mapping.destinationRemoteId
      expect(result).toEqual({ success: true, skip: true });
    });

    it('should NOT skip when destination has stale value and mapping has pending publish ID', async () => {
      const pendingId = createScratchPendingPublishId();
      const lookup = createLookupTools({
        src_1: { destinationFilePath: 'dest-authors/alice.json', destinationRemoteId: pendingId },
      });
      const result = await sourceFkToDestFkTransformer.transform(
        createContext('src_1', lookup, undefined, 'FOREIGN_KEY_MAPPING', 'stale-id-123'),
      );
      expect(result).toEqual({ success: true, value: '@/DestConn/dest-authors/alice.json' });
    });
  });
  /**
   * Non-id foreign keys (DEV-11085): a reference whose value names its target by a declared field
   * rather than the target's remote id — Framer's references carry the target item's slug.
   */
  describe('targetKeyPath — a value that names its target by a non-id field', () => {
    /** Lookup tools whose key index maps slugs to remote ids, then remote ids to destinations. */
    function createSlugKeyedLookupTools(
      slugToRemoteId: Record<string, string | { ambiguousMatchCount: number }>,
      remoteIdToDestinationPath: Record<string, string>,
    ): LookupTools {
      const base = createSimpleLookupTools(remoteIdToDestinationPath);
      return {
        ...base,
        resolveForeignKeyValueToTargetRemoteId: jest.fn((value: string) => {
          const entry = slugToRemoteId[value];
          if (entry === undefined) return Promise.resolve({ kind: 'no_match' } as const);
          if (typeof entry === 'object') {
            return Promise.resolve({ kind: 'ambiguous', matchCount: entry.ambiguousMatchCount } as const);
          }
          return Promise.resolve({ kind: 'resolved', targetSourceRemoteId: entry } as const);
        }),
      };
    }

    const OPTIONS_WITH_SLUG_KEY: SourceFkToDestFkOptions = {
      referencedDataFolderId: REFERENCED_FOLDER,
      targetKeyPath: 'slug',
    };

    it('resolves a slug through to the destination record', async () => {
      const lookup = createSlugKeyedLookupTools(
        { engineering: 'item_aaa' },
        { item_aaa: 'dest-tags/engineering.json' },
      );
      const result = await sourceFkToDestFkTransformer.transform(
        createContext('engineering', lookup, OPTIONS_WITH_SLUG_KEY),
      );
      expect(result).toEqual({ success: true, value: '@/DestConn/dest-tags/engineering.json' });
    });

    it('passes the declared key path to the resolver', async () => {
      const resolveSpy = jest.fn(() =>
        Promise.resolve({ kind: 'resolved', targetSourceRemoteId: 'item_aaa' } as const),
      );
      const lookup: LookupTools = {
        ...createSimpleLookupTools({ item_aaa: 'dest-tags/e.json' }),
        resolveForeignKeyValueToTargetRemoteId: resolveSpy,
      };
      await sourceFkToDestFkTransformer.transform(createContext('engineering', lookup, OPTIONS_WITH_SLUG_KEY));
      expect(resolveSpy).toHaveBeenCalledWith('engineering', REFERENCED_FOLDER, 'slug');
    });

    it('resolves every element of a multi-reference array', async () => {
      const lookup = createSlugKeyedLookupTools(
        { engineering: 'item_aaa', design: 'item_bbb' },
        { item_aaa: 'dest-tags/engineering.json', item_bbb: 'dest-tags/design.json' },
      );
      const result = await sourceFkToDestFkTransformer.transform(
        createContext(['engineering', 'design'], lookup, OPTIONS_WITH_SLUG_KEY),
      );
      expect(result).toEqual({
        success: true,
        value: ['@/DestConn/dest-tags/engineering.json', '@/DestConn/dest-tags/design.json'],
      });
    });

    it('names the key path and the value when nothing claims it', async () => {
      const lookup = createSlugKeyedLookupTools({}, {});
      const result = await sourceFkToDestFkTransformer.transform(
        createContext('marketing', lookup, OPTIONS_WITH_SLUG_KEY),
      );
      expect(result.success).toBe(false);
      expect((result as { error: string }).error).toContain('no record in DataFolder');
      expect((result as { error: string }).error).toContain('"slug"');
      expect((result as { error: string }).error).toContain('"marketing"');
    });

    it('distinguishes "found the target but it has no destination row" from "no such key"', async () => {
      const lookup = createSlugKeyedLookupTools({ engineering: 'item_aaa' }, {});
      const result = await sourceFkToDestFkTransformer.transform(
        createContext('engineering', lookup, OPTIONS_WITH_SLUG_KEY),
      );
      expect(result.success).toBe(false);
      expect((result as { error: string }).error).toContain('no destination record');
    });

    it('fails on an ambiguous key rather than linking one of the claimants', async () => {
      const lookup = createSlugKeyedLookupTools({ engineering: { ambiguousMatchCount: 2 } }, {});
      const result = await sourceFkToDestFkTransformer.transform(
        createContext('engineering', lookup, OPTIONS_WITH_SLUG_KEY),
      );
      expect(result.success).toBe(false);
      expect((result as { error: string }).error).toContain('ambiguous');
      expect((result as { error: string }).error).toContain('2 records');
    });

    it('fails on an ambiguous key EVEN under onUnresolved: ignore', async () => {
      // Tolerating a record you could not find is a choice; silently linking the wrong record
      // of two that claim the same key is not the same thing, and is worse than no link.
      const lookup = createSlugKeyedLookupTools({ engineering: { ambiguousMatchCount: 3 } }, {});
      const result = await sourceFkToDestFkTransformer.transform(
        createContext('engineering', lookup, { ...OPTIONS_WITH_SLUG_KEY, onUnresolved: 'ignore' }),
      );
      expect(result.success).toBe(false);
      expect((result as { error: string }).error).toContain('ambiguous');
    });

    it('still honours onUnresolved: ignore for a key nothing claims', async () => {
      const lookup = createSlugKeyedLookupTools({}, {});
      const result = await sourceFkToDestFkTransformer.transform(
        createContext(['marketing'], lookup, { ...OPTIONS_WITH_SLUG_KEY, onUnresolved: 'ignore' }),
      );
      expect(result.success).toBe(true);
      expect((result as { value: unknown }).value).toEqual([]);
    });

    it('leaves the id path untouched when no key path is declared', async () => {
      const resolveSpy = jest.fn((value: string) =>
        Promise.resolve({ kind: 'resolved', targetSourceRemoteId: value } as const),
      );
      const lookup: LookupTools = {
        ...createSimpleLookupTools({ src_1: 'dest-authors/alice.json' }),
        resolveForeignKeyValueToTargetRemoteId: resolveSpy,
      };
      const result = await sourceFkToDestFkTransformer.transform(createContext('src_1', lookup));
      // The declared-key argument is `undefined`, so the resolver stays on its identity path.
      expect(resolveSpy).toHaveBeenCalledWith('src_1', REFERENCED_FOLDER, undefined);
      expect(result).toEqual({ success: true, value: '@/DestConn/dest-authors/alice.json' });
    });
  });
});
