import { createScratchPendingPublishId, DataFolderId, SourceFkToDestFkOptions } from '@spinner/shared-types';
import { getServiceDisplayName } from 'src/remote-service/connectors/display-names';
import { Service } from 'src/remote-service/connectors/service-constants';
import { sourceFkToDestFkTransformer } from '../implementations/source-fk-to-dest-fk.transformer';
import {
  DestinationMappingResolution,
  LookupTools,
  NoDestinationRecordCause,
  SyncRecord,
  TransformContext,
} from '../transformer.types';

const REFERENCED_FOLDER = 'dfd_dest_authors' as DataFolderId;

// The destination connection folder the producer prepends to make a pseudo-ref
// workspace-absolute (DEV-10880). All `@/…` expectations below carry it.
const DEST_CONN = 'DestConn';

// The referenced table's display name and its OWN service, both of which an unresolved-FK message
// names (DEV-11223). Deliberately not the source service of the pair being synced — `createContext`
// uses Airtable for that, so a message naming Stripe proves it read the referenced folder's.
const REFERENCED_FOLDER_NAME = 'Authors';
const REFERENCED_FOLDER_SERVICE = Service.STRIPE;

function createLookupTools(
  mapping: Record<
    string,
    { destinationFilePath: string; destinationRemoteId: string | null; destinationConnectionFolder?: string }
  > = {},
  // What an id NOT in `mapping` means. The default — "the referenced record was never synced from
  // that folder" — is the ordinary dangling reference (DEV-11223); pass the others to exercise
  // their messages.
  unmappedCause: NoDestinationRecordCause = 'referenced_record_not_synced',
): LookupTools {
  return {
    // Identity: these fixtures reference targets by remote id, the default contract.
    resolveForeignKeyValueToTargetRemoteId: jest.fn((value: string) =>
      Promise.resolve({ kind: 'resolved', targetSourceRemoteId: value } as const),
    ),
    getDestinationMappingForSourceFk: jest.fn((fk: string): Promise<DestinationMappingResolution> => {
      const entry = mapping[fk];
      if (!entry) {
        return Promise.resolve({
          kind: 'no_destination_record',
          cause: unmappedCause,
          referencedFolderName: REFERENCED_FOLDER_NAME,
          referencedFolderService: REFERENCED_FOLDER_SERVICE,
        });
      }
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
function createSimpleLookupTools(
  mapping: Record<string, string> = {},
  unmappedCause?: NoDestinationRecordCause,
): LookupTools {
  const full: Record<string, { destinationFilePath: string; destinationRemoteId: string | null }> = {};
  for (const [key, value] of Object.entries(mapping)) {
    full[key] = { destinationFilePath: value, destinationRemoteId: null };
  }
  return createLookupTools(full, unmappedCause);
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

    it('leaves an unresolvable FK empty and warns rather than failing the record (DEV-11222)', async () => {
      const result = await sourceFkToDestFkTransformer.transform(createContext('missing', createSimpleLookupTools()));
      expect(result).toEqual({
        success: true,
        value: null,
        warnings: [expect.stringContaining('Skipped unresolved foreign key "missing"')],
      });
    });

    it('names the actual cause in the warning, not the list of possibilities (DEV-11223)', async () => {
      const result = await sourceFkToDestFkTransformer.transform(createContext('missing', createSimpleLookupTools()));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.warnings?.[0]).toContain('no record with that id was synced from the referenced table');
        // The hedge this replaced. Naming both possibilities left the reader to guess which.
        expect(result.warnings?.[0]).not.toContain('either');
      }
    });

    it('still fails hard when the column explicitly opts into onUnresolved: fail', async () => {
      const result = await sourceFkToDestFkTransformer.transform(
        createContext('missing', createSimpleLookupTools(), {
          referencedDataFolderId: REFERENCED_FOLDER,
          onUnresolved: 'fail',
        }),
      );
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

    it('drops only the unresolvable element and keeps its resolvable siblings (DEV-11222)', async () => {
      const lookup = createSimpleLookupTools({ src_1: 'authors/alice.json' });
      const result = await sourceFkToDestFkTransformer.transform(createContext(['src_1', 'missing'], lookup));
      expect(result).toEqual({
        success: true,
        value: ['@/DestConn/authors/alice.json'],
        warnings: [expect.stringContaining('Skipped unresolved foreign key "missing"')],
      });
    });

    it('fails the whole array when the column explicitly opts into onUnresolved: fail', async () => {
      const lookup = createSimpleLookupTools({ src_1: 'authors/alice.json' });
      const result = await sourceFkToDestFkTransformer.transform(
        createContext(['src_1', 'missing'], lookup, {
          referencedDataFolderId: REFERENCED_FOLDER,
          onUnresolved: 'fail',
        }),
      );
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

    // A dangling id is also dropped now (DEV-11222), so what still separates the two is the WARNING:
    // a declared sentinel was never a link and passes silently, while an id whose target is gone is
    // reported so the user can see the reference was lost.
    it('warns on a genuinely dangling id — only the DECLARED sentinel passes silently', async () => {
      const result = await sourceFkToDestFkTransformer.transform(
        createContext(404, createSimpleLookupTools(), SENTINEL_ZERO),
      );
      expect(result).toEqual({
        success: true,
        value: null,
        warnings: [expect.stringContaining('Skipped unresolved foreign key "404"')],
      });
    });

    it('warns on the sentinel value when the column declares none (it looks like any other id)', async () => {
      const result = await sourceFkToDestFkTransformer.transform(createContext(0, createSimpleLookupTools()));
      expect(result).toEqual({
        success: true,
        value: null,
        warnings: [expect.stringContaining('Skipped unresolved foreign key "0"')],
      });
    });
  });

  describe('an unresolvable FK never ERASES an existing destination link (DEV-11222)', () => {
    // Dropping the dangling element empties the field, and writing that emptied field to a record
    // the destination already links correctly would publish an UNLINK — destroying a good link
    // because we could not resolve the source's reference, not because the user removed it.
    it('leaves a scalar link untouched instead of nulling it', async () => {
      const result = await sourceFkToDestFkTransformer.transform(
        createContext('cus_gone', createSimpleLookupTools(), undefined, 'FOREIGN_KEY_MAPPING', 'dest_cus_1'),
      );
      expect(result).toEqual({
        success: true,
        skip: true,
        warnings: [expect.stringContaining('Left the field untouched')],
      });
    });

    it('treats a service-specific empty sentinel on the destination as at-risk, and says "value"', async () => {
      // A destination holding WordPress's `featured_media: 0` is unlinked, not linked — but `0` is
      // NOT excluded here. `0` means "no link" only where a connector declares it, and the scalar-FK
      // destinations a hardcoded rule would hit (Postgres/Supabase) use `0` as a real primary key.
      // Holding back also beats the alternative: the write would swap the service's own empty value
      // for ours. So the warning says "a value the destination still holds", never "a link".
      const result = await sourceFkToDestFkTransformer.transform(
        createContext('cus_gone', createSimpleLookupTools(), undefined, 'FOREIGN_KEY_MAPPING', 0),
      );
      expect(result).toEqual({
        success: true,
        skip: true,
        warnings: [expect.stringContaining('a value the destination still holds')],
      });
      expect((result as { warnings: string[] }).warnings[0]).not.toContain('existing link');
    });

    it('holds back the whole array rather than dropping the dangling entry from it', async () => {
      const lookup = createSimpleLookupTools({ cus_a: 'customers/a.json' });
      const result = await sourceFkToDestFkTransformer.transform(
        createContext(['cus_a', 'cus_gone'], lookup, undefined, 'FOREIGN_KEY_MAPPING', [
          '@/DestConn/customers/a.json',
          '@/DestConn/customers/gone.json',
        ]),
      );
      expect(result).toEqual({
        success: true,
        skip: true,
        warnings: [expect.stringContaining('cus_gone')],
      });
    });

    // The guard is on LOSS, not on the mere presence of a dangling sibling. Holding the field back
    // whenever anything dangles would leave a resolvable new link unwritten for as long as the
    // dangling one is missing — forever, for a hard-deleted CRM target.
    it('still writes a NEW resolvable link when the write only adds to what the destination holds', async () => {
      const lookup = createSimpleLookupTools({ cus_a: 'customers/a.json', cus_b: 'customers/b.json' });
      const result = await sourceFkToDestFkTransformer.transform(
        createContext(['cus_a', 'cus_b', 'cus_gone'], lookup, undefined, 'FOREIGN_KEY_MAPPING', [
          '@/DestConn/customers/a.json',
        ]),
      );
      expect(result).toEqual({
        success: true,
        value: ['@/DestConn/customers/a.json', '@/DestConn/customers/b.json'],
        warnings: [expect.stringContaining('Left the link empty')],
      });
    });

    it('recognizes an existing link stored as the raw destination remote id, not the pseudo-ref', async () => {
      // A destination element can legitimately carry either spelling; comparing only against the
      // emitted ref would read a real, still-present link as lost and freeze the field forever.
      const lookup = createLookupTools({
        cus_a: { destinationFilePath: 'customers/a.json', destinationRemoteId: 'dest_a_99' },
        cus_b: { destinationFilePath: 'customers/b.json', destinationRemoteId: 'dest_b_99' },
      });
      const result = await sourceFkToDestFkTransformer.transform(
        createContext(['cus_a', 'cus_b', 'cus_gone'], lookup, undefined, 'FOREIGN_KEY_MAPPING', ['dest_a_99']),
      );
      expect(result).toEqual({
        success: true,
        value: ['dest_a_99', 'dest_b_99'],
        warnings: [expect.stringContaining('Left the link empty')],
      });
    });

    it('upgrades a pseudo-ref whose target has since published, even with a dangling sibling', async () => {
      // Publish resolves an `@/…` ref for the API call but leaves the ON-DISK value alone
      // (DEV-10954), so once the target publishes the record still holds the ref while we now emit
      // the real id. Reading that as a link about to be lost would hold the field back — and since
      // the hold-back is what would have rewritten the ref to the real id, the field would stay
      // frozen on every later sync, not just this one.
      const lookup = createLookupTools({
        cus_a: { destinationFilePath: 'customers/a.json', destinationRemoteId: 'dest_a' },
      });
      const result = await sourceFkToDestFkTransformer.transform(
        createContext(['cus_a', 'cus_gone'], lookup, undefined, 'FOREIGN_KEY_MAPPING', ['@/DestConn/customers/a.json']),
      );
      expect(result).toEqual({
        success: true,
        value: ['dest_a'],
        warnings: [expect.stringContaining('Left the link empty')],
      });
    });

    it('does NOT treat a non-canonical pseudo-ref as one of the links it resolved', async () => {
      // Only the canonical workspace-absolute form counts. A ref in any other shape is malformed,
      // not a link (DEV-11238), and this must not become the one place that quietly understands it
      // — so it is treated like any other value we cannot vouch for and the field is held back.
      const lookup = createSimpleLookupTools({ cus_a: 'customers/a.json' });
      const result = await sourceFkToDestFkTransformer.transform(
        createContext(['cus_a', 'cus_gone'], lookup, undefined, 'FOREIGN_KEY_MAPPING', ['@/customers/a.json']),
      );
      expect(result).toEqual({
        success: true,
        skip: true,
        warnings: [expect.stringContaining('Left the field untouched')],
      });
    });

    it('holds back when the destination link field is an ENVELOPE we cannot compare (Notion)', async () => {
      // `destinationValue` is the field's raw stored value and Notion's relation pack runs after
      // this transformer, so the existing links arrive as `{ type: 'relation', relation: [...] }`.
      // Nothing in there is provably one of the links we resolved, so the field must be held back —
      // Notion is the destination in the run that motivated DEV-11222.
      const lookup = createSimpleLookupTools({ cus_a: 'customers/a.json' });
      const result = await sourceFkToDestFkTransformer.transform(
        createContext(['cus_a', 'cus_gone'], lookup, undefined, 'FOREIGN_KEY_MAPPING', {
          type: 'relation',
          relation: [{ id: 'dest_a' }, { id: 'dest_gone' }],
        }),
      );
      expect(result).toEqual({
        success: true,
        skip: true,
        warnings: [expect.stringContaining('Left the field untouched')],
      });
    });

    it('holds back when a new link would land but an existing one would be lost', async () => {
      // Both can't be honoured at once — writing [a, new] erases `gone`. Fail safe: nothing is
      // erased, and the warning says the field's other changes are deferred.
      const lookup = createSimpleLookupTools({ cus_a: 'customers/a.json', cus_new: 'customers/new.json' });
      const result = await sourceFkToDestFkTransformer.transform(
        createContext(['cus_a', 'cus_new', 'cus_gone'], lookup, undefined, 'FOREIGN_KEY_MAPPING', [
          '@/DestConn/customers/a.json',
          '@/DestConn/customers/gone.json',
        ]),
      );
      expect(result).toEqual({
        success: true,
        skip: true,
        warnings: [expect.stringContaining('deferred until it resolves')],
      });
    });

    it('still empties the link on a record being CREATED (nothing to preserve)', async () => {
      const result = await sourceFkToDestFkTransformer.transform(
        createContext('cus_gone', createSimpleLookupTools(), undefined, 'FOREIGN_KEY_MAPPING', undefined),
      );
      expect(result).toEqual({
        success: true,
        value: null,
        warnings: [expect.stringContaining('Left the link empty')],
      });
    });

    it('still empties the link when the destination holds no link either', async () => {
      const result = await sourceFkToDestFkTransformer.transform(
        createContext('cus_gone', createSimpleLookupTools(), undefined, 'FOREIGN_KEY_MAPPING', null),
      );
      expect(result).toEqual({
        success: true,
        value: null,
        warnings: [expect.stringContaining('Left the link empty')],
      });
    });

    it('still REMOVES a link the source itself dropped — nothing was unresolvable', async () => {
      // The guard must not freeze the field generally: a source that genuinely cleared its
      // reference arrives as a null (or shorter) value with no unresolved key, and still clears.
      const result = await sourceFkToDestFkTransformer.transform(
        createContext(null, createSimpleLookupTools(), undefined, 'FOREIGN_KEY_MAPPING', 'dest_cus_1'),
      );
      expect(result).toEqual({ success: true, value: null });
    });

    it('still removes one of two links when the source dropped it and the other resolves', async () => {
      const lookup = createSimpleLookupTools({ cus_a: 'customers/a.json' });
      const result = await sourceFkToDestFkTransformer.transform(
        createContext(['cus_a'], lookup, undefined, 'FOREIGN_KEY_MAPPING', [
          '@/DestConn/customers/a.json',
          '@/DestConn/customers/b.json',
        ]),
      );
      expect(result).toEqual({ success: true, value: ['@/DestConn/customers/a.json'] });
    });

    it('preserves the existing link under an explicit onUnresolved: ignore too', async () => {
      const result = await sourceFkToDestFkTransformer.transform(
        createContext(
          'cus_gone',
          createSimpleLookupTools(),
          { referencedDataFolderId: REFERENCED_FOLDER, onUnresolved: 'ignore' },
          'FOREIGN_KEY_MAPPING',
          'dest_cus_1',
        ),
      );
      expect(result).toEqual({
        success: true,
        skip: true,
        warnings: [expect.stringContaining('Left the field untouched')],
      });
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
      unmappedCause?: NoDestinationRecordCause,
    ): LookupTools {
      const base = createSimpleLookupTools(remoteIdToDestinationPath, unmappedCause);
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
      expect(result.success).toBe(true);
      const warning = (result as { warnings?: string[] }).warnings?.[0] ?? '';
      expect(warning).toContain('no record in DataFolder');
      expect(warning).toContain('"slug"');
      expect(warning).toContain('"marketing"');
    });

    it('distinguishes "found the target but it has no destination row" from "no such key"', async () => {
      // The default cause, which is what `createLookupTools` really returns for this scenario: the
      // slug matched a record on disk, but no `SyncRemoteIdMapping` row carries its remote id.
      const lookup = createSlugKeyedLookupTools({ engineering: 'item_aaa' }, {});
      const result = await sourceFkToDestFkTransformer.transform(
        createContext('engineering', lookup, OPTIONS_WITH_SLUG_KEY),
      );
      expect(result.success).toBe(true);
      const warning = (result as { warnings?: string[] }).warnings?.[0] ?? '';
      expect(warning).toContain('is present there but was not synced');
      expect(warning).toContain('"slug"');
      // A declared key path was MATCHED to reach this branch, so the record provably exists in the
      // referenced source folder. Claiming it might be deleted upstream — the wording the id path
      // uses for this same cause — would send a debugger the wrong way.
      expect(warning).not.toContain('deleted in');
      expect(warning).not.toContain('never pulled');
    });

    it('reports a matched target whose destination row is merely pending as awaiting, not unsynced', async () => {
      const lookup = createSlugKeyedLookupTools(
        { engineering: 'item_aaa' },
        {},
        'referenced_record_awaiting_destination',
      );
      const result = await sourceFkToDestFkTransformer.transform(
        createContext('engineering', lookup, OPTIONS_WITH_SLUG_KEY),
      );
      expect(result.success).toBe(true);
      const warning = (result as { warnings?: string[] }).warnings?.[0] ?? '';
      expect(warning).toContain('was synced but has not reached the destination yet');
      expect(warning).toContain('"slug"');
      expect(warning).not.toContain('deleted in');
    });

    it('does not ask whether a key-path folder has been pulled — step 1 just read it', async () => {
      // Reachable when a key-path FK names a folder that produced no `SyncRemoteIdMapping` rows
      // (e.g. it is not one of this sync's table pairs). Step 1 streamed that folder off disk and
      // matched a record in it, so "check that it has been pulled" is already disproved.
      const lookup = createSlugKeyedLookupTools({ engineering: 'item_aaa' }, {}, 'referenced_folder_synced_nothing');
      const result = await sourceFkToDestFkTransformer.transform(
        createContext('engineering', lookup, OPTIONS_WITH_SLUG_KEY),
      );
      expect(result.success).toBe(true);
      const warning = (result as { warnings?: string[] }).warnings?.[0] ?? '';
      expect(warning).toContain('has records, but synced none of them');
      expect(warning).not.toContain('has been pulled');
      // The folder IS named, so it is known to be one of this sync's tables too — the only thing
      // left unproved is why its records did not reach the sync.
      expect(warning).toContain("is one of this sync's tables");
      expect(warning).not.toContain("check that it is one of this sync's tables");
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

  /**
   * DEV-11223: now that an unresolved FK is a warning rather than a failed table, the warning is
   * the ONLY thing the user gets — so it has to name the cause it actually found instead of the
   * list of causes it might have found.
   */
  describe('naming the cause of an unresolved foreign key (DEV-11223)', () => {
    /** The Stripe customer of the ticket's repro: deleted upstream, so never pulled or synced. */
    // The context's own `sourceService` stays AIRTABLE (createContext's default) while the
    // referenced folder is STRIPE, so a message naming Stripe can only have come from the
    // resolution — the pair being synced is not the connection the target was deleted from.
    function warningForDanglingStripeCustomer(lookup: LookupTools): Promise<string> {
      return sourceFkToDestFkTransformer
        .transform(createContext('cus_OKBUcB0TIWPk82', lookup))
        .then((result) => (result as { warnings?: string[] }).warnings?.[0] ?? '');
    }

    it('names the referenced table, its id, and the service the record may have been deleted in', async () => {
      const warning = await warningForDanglingStripeCustomer(createSimpleLookupTools());
      expect(warning).toContain('no record with that id was synced from the referenced table');
      expect(warning).toContain(`"${REFERENCED_FOLDER_NAME}"`);
      expect(warning).toContain(REFERENCED_FOLDER);
      expect(warning).toContain(getServiceDisplayName(REFERENCED_FOLDER_SERVICE));
      // Naming the pair's source service instead would send the user to the wrong product.
      expect(warning).not.toContain(getServiceDisplayName(Service.AIRTABLE));
      // This cause also covers a record that IS on disk but was skipped by the referenced pair's
      // match-key derivation, so the remedy list has to reach that reader too.
      expect(warning).toContain('missing the match key this sync pairs on');
    });

    it('falls back to "the source service" rather than guessing when the folder has no connection', async () => {
      const warning = await warningForDanglingStripeCustomer({
        ...createSimpleLookupTools(),
        getDestinationMappingForSourceFk: () =>
          Promise.resolve({
            kind: 'no_destination_record',
            cause: 'referenced_record_not_synced',
            referencedFolderName: null,
            referencedFolderService: null,
          }),
      });
      expect(warning).toContain('deleted in the source service');
      expect(warning).not.toContain(getServiceDisplayName(Service.AIRTABLE));
    });

    it('falls back to the DataFolder id alone when the referenced folder has no name', async () => {
      const warning = await warningForDanglingStripeCustomer({
        ...createSimpleLookupTools(),
        getDestinationMappingForSourceFk: () =>
          Promise.resolve({
            kind: 'no_destination_record',
            cause: 'referenced_record_not_synced',
            referencedFolderName: null,
            referencedFolderService: null,
          }),
      });
      expect(warning).toContain(`DataFolder ${REFERENCED_FOLDER}`);
      expect(warning).not.toContain('""');
    });

    it('reports a synced-but-uncreated record as awaiting the destination, not as deleted upstream', async () => {
      const warning = await warningForDanglingStripeCustomer(
        createSimpleLookupTools({}, 'referenced_record_awaiting_destination'),
      );
      expect(warning).toContain('has not reached the destination yet');
      expect(warning).not.toContain('deleted in');
    });

    it('reports a referenced table that synced nothing as a sync-configuration problem', async () => {
      const warning = await warningForDanglingStripeCustomer(
        createSimpleLookupTools({}, 'referenced_folder_synced_nothing'),
      );
      expect(warning).toContain('synced no records at all');
      // A NAMED table was found as a SyncTablePair, so asking the user to check that it is one of
      // this sync's tables would point at something already disproved.
      expect(warning).toContain("is one of this sync's tables but synced no records");
      expect(warning).not.toContain("check that it is one of this sync's tables");
      expect(warning).toContain('has been pulled');
    });

    it('asks whether an UNNAMED referenced table is in the sync at all — that much is unproved', async () => {
      // No display name means `SyncTablePair.findFirst` found no pair for the referenced folder,
      // which is exactly the case the "is it one of this sync's tables?" hint is for.
      const warning = await warningForDanglingStripeCustomer({
        ...createSimpleLookupTools(),
        getDestinationMappingForSourceFk: () =>
          Promise.resolve({
            kind: 'no_destination_record',
            cause: 'referenced_folder_synced_nothing',
            referencedFolderName: null,
            referencedFolderService: null,
          }),
      });
      expect(warning).toContain("check that it is one of this sync's tables and has been pulled");
    });

    it('carries the same cause into the hard error under onUnresolved: fail', async () => {
      const result = await sourceFkToDestFkTransformer.transform({
        ...createContext('cus_OKBUcB0TIWPk82', createSimpleLookupTools(), {
          referencedDataFolderId: REFERENCED_FOLDER,
          onUnresolved: 'fail',
        }),
        sourceService: Service.STRIPE,
      });
      expect(result.success).toBe(false);
      expect((result as { error: string }).error).toContain('no record with that id was synced from');
    });
  });
});
