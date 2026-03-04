import { createScratchPendingPublishId, SourceFkToDestFkOptions } from '@spinner/shared-types';
import { sourceFkToDestFkTransformer } from '../implementations/source-fk-to-dest-fk.transformer';
import { FkMappingResult, LookupTools, SyncRecord, TransformContext } from '../transformer.types';

const REFERENCED_FOLDER = 'dfd_dest_authors' as const;

function createLookupTools(
  mapping: Record<string, { destinationFilePath: string; destinationRemoteId: string | null }> = {},
): LookupTools {
  return {
    getDestinationMappingForSourceFk: jest.fn((fk: string): Promise<FkMappingResult | null> => {
      return Promise.resolve(mapping[fk] ?? null);
    }),
    lookupFieldFromFkRecord: jest.fn(),
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
  return { sourceRecord, sourceFieldPath: 'fk', sourceValue, lookupTools, destinationValue, options, phase };
}

describe('sourceFkToDestFkTransformer', () => {
  it('should have correct type', () => {
    expect(sourceFkToDestFkTransformer.type).toBe('source_fk_to_dest_fk');
  });

  it('should skip during DATA phase', async () => {
    const result = await sourceFkToDestFkTransformer.transform(
      createContext('src_1', createSimpleLookupTools(), undefined, 'DATA'),
    );
    expect(result).toEqual({ success: true, skip: true });
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
    it('should resolve a string FK', async () => {
      const lookup = createSimpleLookupTools({ src_1: 'dest-authors/alice.json' });
      const result = await sourceFkToDestFkTransformer.transform(createContext('src_1', lookup));
      expect(result).toEqual({ success: true, value: '@/dest-authors/alice.json' });
    });

    it('should resolve a numeric FK', async () => {
      const lookup = createSimpleLookupTools({ '42': 'dest-authors/bob.json' });
      const result = await sourceFkToDestFkTransformer.transform(createContext(42, lookup));
      expect(result).toEqual({ success: true, value: '@/dest-authors/bob.json' });
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
      expect(result).toEqual({ success: true, value: ['@/authors/alice.json', '@/authors/bob.json'] });
    });

    it('should skip null/undefined elements in arrays', async () => {
      const lookup = createSimpleLookupTools({ src_1: 'authors/alice.json' });
      const result = await sourceFkToDestFkTransformer.transform(createContext(['src_1', null, undefined], lookup));
      expect(result).toEqual({ success: true, value: ['@/authors/alice.json'] });
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

  describe('skip when destination value is unchanged', () => {
    it('should skip when destination already has the @/path reference (scalar)', async () => {
      const lookup = createSimpleLookupTools({ src_1: 'dest-authors/alice.json' });
      const result = await sourceFkToDestFkTransformer.transform(
        createContext('src_1', lookup, undefined, 'FOREIGN_KEY_MAPPING', '@/dest-authors/alice.json'),
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
          '@/authors/alice.json',
          '@/authors/bob.json',
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

    it('should NOT skip when value differs', async () => {
      const lookup = createSimpleLookupTools({ src_1: 'dest-authors/alice.json' });
      const result = await sourceFkToDestFkTransformer.transform(
        createContext('src_1', lookup, undefined, 'FOREIGN_KEY_MAPPING', '@/dest-authors/bob.json'),
      );
      expect(result).toEqual({ success: true, value: '@/dest-authors/alice.json' });
    });

    it('should NOT skip when destinationValue is undefined (new record)', async () => {
      const lookup = createSimpleLookupTools({ src_1: 'dest-authors/alice.json' });
      const result = await sourceFkToDestFkTransformer.transform(
        createContext('src_1', lookup, undefined, 'FOREIGN_KEY_MAPPING', undefined),
      );
      expect(result).toEqual({ success: true, value: '@/dest-authors/alice.json' });
    });

    it('should NOT skip when array lengths differ', async () => {
      const lookup = createSimpleLookupTools({ src_1: 'authors/alice.json', src_2: 'authors/bob.json' });
      const result = await sourceFkToDestFkTransformer.transform(
        createContext(['src_1', 'src_2'], lookup, undefined, 'FOREIGN_KEY_MAPPING', ['@/authors/alice.json']),
      );
      expect(result).toEqual({
        success: true,
        value: ['@/authors/alice.json', '@/authors/bob.json'],
      });
    });

    it('should NOT skip when only some array elements match', async () => {
      const lookup = createSimpleLookupTools({ src_1: 'authors/alice.json', src_2: 'authors/bob.json' });
      const result = await sourceFkToDestFkTransformer.transform(
        createContext(['src_1', 'src_2'], lookup, undefined, 'FOREIGN_KEY_MAPPING', [
          '@/authors/alice.json',
          '@/authors/WRONG.json',
        ]),
      );
      expect(result).toEqual({
        success: true,
        value: ['@/authors/alice.json', '@/authors/bob.json'],
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
      expect(result).toEqual({ success: true, value: '@/authors/alice.json' });
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
      expect(result).toEqual({ success: true, value: '@/authors/alice.json' });
    });

    it('should preserve default array behavior when outputType is not set', async () => {
      const lookup = createSimpleLookupTools({ src_1: 'authors/alice.json', src_2: 'authors/bob.json' });
      const result = await sourceFkToDestFkTransformer.transform(createContext(['src_1', 'src_2'], lookup));
      expect(result).toEqual({ success: true, value: ['@/authors/alice.json', '@/authors/bob.json'] });
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
      expect(result).toEqual({ success: true, value: '@/dest-authors/alice.json' });
    });

    it('should use file ref when destinationRemoteId is null', async () => {
      const lookup = createLookupTools({
        src_1: { destinationFilePath: 'dest-authors/alice.json', destinationRemoteId: null },
      });
      const result = await sourceFkToDestFkTransformer.transform(createContext('src_1', lookup));
      expect(result).toEqual({ success: true, value: '@/dest-authors/alice.json' });
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
        value: ['real-id-10', '@/authors/bob.json', '@/authors/carol.json'],
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
      expect(result).toEqual({ success: true, value: '@/dest-authors/alice.json' });
    });
  });
});
