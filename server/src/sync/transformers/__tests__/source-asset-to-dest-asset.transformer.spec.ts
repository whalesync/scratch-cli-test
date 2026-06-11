import { createScratchPendingPublishId, DataFolderId, SourceAssetToDestAssetOptions } from '@spinner/shared-types';
import { Service } from 'src/remote-service/connectors/service-constants';
import { sourceAssetToDestAssetTransformer } from '../implementations/source-asset-to-dest-asset.transformer';
import { AssetMappingResult, LookupTools, SyncRecord, TransformContext } from '../transformer.types';

const SOURCE_FOLDER = 'dfd_source_assets' as DataFolderId;
const DEST_FOLDER = 'dfd_dest_products' as DataFolderId;

type AssetMappingSpec = Record<
  string,
  { result: AssetMappingResult } | { error: 'ASSET_NOT_FOUND' } | { error: 'ASSET_NOT_REHOSTED' }
>;

let assetDbIdCounter = 0;
function nextAssetDbId(): string {
  return `asset_db_${++assetDbIdCounter}`;
}

function createLookupTools(assetMapping: AssetMappingSpec = {}): LookupTools {
  return {
    getDestinationMappingForSourceFk: jest.fn(),
    lookupFieldFromFkRecord: jest.fn(),
    getOrCreateDestinationAssetMapping: jest.fn((sourceAssetRemoteId: string): Promise<AssetMappingResult> => {
      const spec = assetMapping[sourceAssetRemoteId];
      if (!spec) {
        return Promise.reject(new Error('ASSET_NOT_FOUND'));
      }
      if ('error' in spec) {
        return Promise.reject(new Error(spec.error));
      }
      return Promise.resolve(spec.result);
    }),
    matchDestinationAssetByHash: jest.fn().mockResolvedValue([]),
  };
}

function createContext(
  sourceValue: unknown,
  lookupTools: LookupTools,
  options: SourceAssetToDestAssetOptions = {
    sourceDataFolderId: SOURCE_FOLDER,
    destinationDataFolderId: DEST_FOLDER,
  },
  phase: 'DATA' | 'FOREIGN_KEY_MAPPING' = 'FOREIGN_KEY_MAPPING',
  destinationValue?: unknown,
): TransformContext {
  const sourceRecord: SyncRecord = { id: 'test', filePath: '/test.json', fields: { images: sourceValue } };
  return {
    sourceRecord,
    sourceFieldPath: 'images',
    sourceValue,
    sourceTableSpec: null,
    sourceService: Service.AIRTABLE,
    destinationFieldPath: 'images',
    destinationTableSpec: null,
    destinationService: Service.WEBFLOW,
    lookupTools,
    destinationValue,
    options,
    phase,
  };
}

describe('sourceAssetToDestAssetTransformer', () => {
  beforeEach(() => {
    assetDbIdCounter = 0;
  });

  it('should have correct type', () => {
    expect(sourceAssetToDestAssetTransformer.type).toBe('source_asset_to_dest_asset');
  });

  describe('null/undefined handling', () => {
    it('should return null for null input', async () => {
      const result = await sourceAssetToDestAssetTransformer.transform(createContext(null, createLookupTools()));
      expect(result).toEqual({ success: true, value: null });
    });

    it('should return null for undefined input', async () => {
      const result = await sourceAssetToDestAssetTransformer.transform(createContext(undefined, createLookupTools()));
      expect(result).toEqual({ success: true, value: null });
    });
  });

  describe('scalar resolution', () => {
    it('should resolve a new asset with @asset/ prefix using DB id', async () => {
      const tempId = createScratchPendingPublishId();
      const dbId = nextAssetDbId();
      const lookup = createLookupTools({
        att_1: { result: { destinationAssetId: dbId, destinationAssetRemoteId: tempId, isNew: true } },
      });
      const result = await sourceAssetToDestAssetTransformer.transform(createContext('att_1', lookup));
      expect(result).toEqual({ success: true, value: `@asset/${dbId}` });
    });

    it('should resolve an existing published asset with an @asset/ ref', async () => {
      // Even an already-published destination asset emits an @asset/ pseudo-ref now, so
      // publish-time resolveAssetReference builds the connector-specific write shape.
      const dbId = nextAssetDbId();
      const lookup = createLookupTools({
        att_1: {
          result: { destinationAssetId: dbId, destinationAssetRemoteId: 'webflow_img_456', isNew: false },
        },
      });
      const result = await sourceAssetToDestAssetTransformer.transform(createContext('att_1', lookup));
      expect(result).toEqual({ success: true, value: `@asset/${dbId}` });
    });

    it('should use @asset/ prefix for existing but unpublished asset (pending publish ID)', async () => {
      const pendingId = createScratchPendingPublishId();
      const dbId = nextAssetDbId();
      const lookup = createLookupTools({
        att_1: { result: { destinationAssetId: dbId, destinationAssetRemoteId: pendingId, isNew: false } },
      });
      const result = await sourceAssetToDestAssetTransformer.transform(createContext('att_1', lookup));
      expect(result).toEqual({ success: true, value: `@asset/${dbId}` });
    });

    it('should fail when source asset is not found', async () => {
      const lookup = createLookupTools({});
      const result = await sourceAssetToDestAssetTransformer.transform(createContext('missing', lookup));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Source asset "missing" not found');
        expect(result.error).toContain('Pull the source table again');
      }
    });

    it('should fail when source asset is not rehosted', async () => {
      const lookup = createLookupTools({
        att_1: { error: 'ASSET_NOT_REHOSTED' },
      });
      const result = await sourceAssetToDestAssetTransformer.transform(createContext('att_1', lookup));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Source asset "att_1" is not rehosted');
        expect(result.error).toContain('Run pull assets');
      }
    });
  });

  describe('array resolution', () => {
    it('should resolve an array of asset IDs', async () => {
      const tempId1 = createScratchPendingPublishId();
      const tempId2 = createScratchPendingPublishId();
      const dbId1 = nextAssetDbId();
      const dbId2 = nextAssetDbId();
      const lookup = createLookupTools({
        att_1: { result: { destinationAssetId: dbId1, destinationAssetRemoteId: tempId1, isNew: true } },
        att_2: { result: { destinationAssetId: dbId2, destinationAssetRemoteId: tempId2, isNew: true } },
      });
      const result = await sourceAssetToDestAssetTransformer.transform(createContext(['att_1', 'att_2'], lookup));
      expect(result).toEqual({ success: true, value: [`@asset/${dbId1}`, `@asset/${dbId2}`] });
    });

    it('should skip null/undefined elements in arrays', async () => {
      const tempId = createScratchPendingPublishId();
      const dbId = nextAssetDbId();
      const lookup = createLookupTools({
        att_1: { result: { destinationAssetId: dbId, destinationAssetRemoteId: tempId, isNew: true } },
      });
      const result = await sourceAssetToDestAssetTransformer.transform(
        createContext(['att_1', null, undefined], lookup),
      );
      expect(result).toEqual({ success: true, value: [`@asset/${dbId}`] });
    });

    it('should mix new and existing assets in arrays', async () => {
      const tempId = createScratchPendingPublishId();
      const dbId1 = nextAssetDbId();
      const dbId2 = nextAssetDbId();
      const lookup = createLookupTools({
        att_1: {
          result: { destinationAssetId: dbId1, destinationAssetRemoteId: 'webflow_img_123', isNew: false },
        },
        att_2: { result: { destinationAssetId: dbId2, destinationAssetRemoteId: tempId, isNew: true } },
      });
      const result = await sourceAssetToDestAssetTransformer.transform(createContext(['att_1', 'att_2'], lookup));
      // Both published and new assets emit @asset/ refs (resolved per-connector at publish).
      expect(result).toEqual({ success: true, value: [`@asset/${dbId1}`, `@asset/${dbId2}`] });
    });

    it('should fail if any array element cannot be resolved', async () => {
      const tempId = createScratchPendingPublishId();
      const dbId = nextAssetDbId();
      const lookup = createLookupTools({
        att_1: { result: { destinationAssetId: dbId, destinationAssetRemoteId: tempId, isNew: true } },
      });
      const result = await sourceAssetToDestAssetTransformer.transform(createContext(['att_1', 'missing'], lookup));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Source asset "missing" not found');
      }
    });

    it('should fail for non-string array elements', async () => {
      const result = await sourceAssetToDestAssetTransformer.transform(createContext([123], createLookupTools()));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Expected string for asset ID array element');
      }
    });
  });

  describe('error cases', () => {
    it('should fail for object input', async () => {
      const result = await sourceAssetToDestAssetTransformer.transform(createContext({ id: 1 }, createLookupTools()));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Expected string or array for asset ID value');
      }
    });

    it('should fail for number input', async () => {
      const result = await sourceAssetToDestAssetTransformer.transform(createContext(42, createLookupTools()));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Expected string or array for asset ID value');
      }
    });
  });

  describe('onUnresolved: ignore', () => {
    const ignoreOpts: SourceAssetToDestAssetOptions = {
      sourceDataFolderId: SOURCE_FOLDER,
      destinationDataFolderId: DEST_FOLDER,
      onUnresolved: 'ignore',
    };

    it('should warn instead of fail for asset not found', async () => {
      const lookup = createLookupTools({});
      const result = await sourceAssetToDestAssetTransformer.transform(createContext('missing', lookup, ignoreOpts));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toBeNull();
        expect(result.warnings).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(result.warnings![0]).toContain('Source asset "missing" not found');
      }
    });

    it('should warn instead of fail for asset not rehosted', async () => {
      const lookup = createLookupTools({
        att_1: { error: 'ASSET_NOT_REHOSTED' },
      });
      const result = await sourceAssetToDestAssetTransformer.transform(createContext('att_1', lookup, ignoreOpts));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toBeNull();
        expect(result.warnings).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(result.warnings![0]).toContain('is not rehosted');
      }
    });

    it('should resolve valid assets and skip invalid ones in arrays', async () => {
      const tempId = createScratchPendingPublishId();
      const dbId = nextAssetDbId();
      const lookup = createLookupTools({
        att_1: { result: { destinationAssetId: dbId, destinationAssetRemoteId: tempId, isNew: true } },
      });
      const result = await sourceAssetToDestAssetTransformer.transform(
        createContext(['att_1', 'missing'], lookup, ignoreOpts),
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toEqual([`@asset/${dbId}`]);
        expect(result.warnings).toHaveLength(1);
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(result.warnings![0]).toContain('Source asset "missing" not found');
      }
    });
  });

  describe('skip when destination value is unchanged', () => {
    it('should skip when destination already has the @asset/ reference (scalar)', async () => {
      const tempId = createScratchPendingPublishId();
      const dbId = nextAssetDbId();
      const lookup = createLookupTools({
        att_1: { result: { destinationAssetId: dbId, destinationAssetRemoteId: tempId, isNew: true } },
      });
      const result = await sourceAssetToDestAssetTransformer.transform(
        createContext('att_1', lookup, undefined, 'FOREIGN_KEY_MAPPING', `@asset/${dbId}`),
      );
      expect(result).toEqual({ success: true, skip: true });
    });

    it('should skip when destination has raw destination asset ID (scalar)', async () => {
      const dbId = nextAssetDbId();
      const lookup = createLookupTools({
        att_1: {
          result: { destinationAssetId: dbId, destinationAssetRemoteId: 'webflow_img_456', isNew: false },
        },
      });
      const result = await sourceAssetToDestAssetTransformer.transform(
        createContext('att_1', lookup, undefined, 'FOREIGN_KEY_MAPPING', 'webflow_img_456'),
      );
      expect(result).toEqual({ success: true, skip: true });
    });

    it('should NOT skip when destinationValue is undefined (new record)', async () => {
      const tempId = createScratchPendingPublishId();
      const dbId = nextAssetDbId();
      const lookup = createLookupTools({
        att_1: { result: { destinationAssetId: dbId, destinationAssetRemoteId: tempId, isNew: true } },
      });
      const result = await sourceAssetToDestAssetTransformer.transform(
        createContext('att_1', lookup, undefined, 'FOREIGN_KEY_MAPPING', undefined),
      );
      expect(result).toEqual({ success: true, value: `@asset/${dbId}` });
    });

    it('should NOT skip when value differs', async () => {
      const tempId = createScratchPendingPublishId();
      const dbId = nextAssetDbId();
      const lookup = createLookupTools({
        att_1: { result: { destinationAssetId: dbId, destinationAssetRemoteId: tempId, isNew: true } },
      });
      const result = await sourceAssetToDestAssetTransformer.transform(
        createContext('att_1', lookup, undefined, 'FOREIGN_KEY_MAPPING', 'stale-id'),
      );
      expect(result).toEqual({ success: true, value: `@asset/${dbId}` });
    });
  });

  describe('outputType: single', () => {
    const singleOpts: SourceAssetToDestAssetOptions = {
      sourceDataFolderId: SOURCE_FOLDER,
      destinationDataFolderId: DEST_FOLDER,
      outputType: 'single',
    };

    it('should unwrap array input to first resolved value', async () => {
      const tempId1 = createScratchPendingPublishId();
      const tempId2 = createScratchPendingPublishId();
      const dbId1 = nextAssetDbId();
      const dbId2 = nextAssetDbId();
      const lookup = createLookupTools({
        att_1: { result: { destinationAssetId: dbId1, destinationAssetRemoteId: tempId1, isNew: true } },
        att_2: { result: { destinationAssetId: dbId2, destinationAssetRemoteId: tempId2, isNew: true } },
      });
      const result = await sourceAssetToDestAssetTransformer.transform(
        createContext(['att_1', 'att_2'], lookup, singleOpts),
      );
      expect(result).toEqual({ success: true, value: `@asset/${dbId1}` });
    });

    it('should return null for empty array after ignoring unresolved', async () => {
      const lookup = createLookupTools({});
      const result = await sourceAssetToDestAssetTransformer.transform(
        createContext(['missing'], lookup, { ...singleOpts, onUnresolved: 'ignore' }),
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toBeNull();
        expect(result.warnings).toHaveLength(1);
      }
    });

    it('should behave the same as default for scalar input', async () => {
      const tempId = createScratchPendingPublishId();
      const dbId = nextAssetDbId();
      const lookup = createLookupTools({
        att_1: { result: { destinationAssetId: dbId, destinationAssetRemoteId: tempId, isNew: true } },
      });
      const result = await sourceAssetToDestAssetTransformer.transform(createContext('att_1', lookup, singleOpts));
      expect(result).toEqual({ success: true, value: `@asset/${dbId}` });
    });
  });

  describe('idempotency', () => {
    it('should call getOrCreateDestinationAssetMapping for each element', async () => {
      const tempId = createScratchPendingPublishId();
      const dbId = nextAssetDbId();
      const lookup = createLookupTools({
        att_1: { result: { destinationAssetId: dbId, destinationAssetRemoteId: tempId, isNew: true } },
      });
      // Same asset referenced twice in an array
      await sourceAssetToDestAssetTransformer.transform(createContext(['att_1', 'att_1'], lookup));
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(lookup.getOrCreateDestinationAssetMapping).toHaveBeenCalledTimes(2);
    });
  });
});
