import {
  createScratchPendingPublishId,
  DataFolderId,
  Service,
  SourceAssetToDestAssetOptions,
} from '@spinner/shared-types';
import { sourceAssetToDestAssetTransformer } from '../implementations/source-asset-to-dest-asset.transformer';
import { AssetMappingResult, LookupTools, SyncRecord, TransformContext } from '../transformer.types';

const SOURCE_FOLDER = 'dfd_source_assets' as DataFolderId;
const DEST_FOLDER = 'dfd_dest_products' as DataFolderId;

type AssetMappingSpec = Record<
  string,
  { result: AssetMappingResult } | { error: 'ASSET_NOT_FOUND' } | { error: 'ASSET_NOT_REHOSTED' }
>;

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
    it('should resolve a new asset with @asset/ prefix', async () => {
      const tempId = createScratchPendingPublishId();
      const lookup = createLookupTools({
        att_1: { result: { destinationAssetRemoteId: tempId, isNew: true } },
      });
      const result = await sourceAssetToDestAssetTransformer.transform(createContext('att_1', lookup));
      expect(result).toEqual({ success: true, value: `@asset/${tempId}` });
    });

    it('should resolve an existing published asset with raw ID', async () => {
      const lookup = createLookupTools({
        att_1: { result: { destinationAssetRemoteId: 'webflow_img_456', isNew: false } },
      });
      const result = await sourceAssetToDestAssetTransformer.transform(createContext('att_1', lookup));
      expect(result).toEqual({ success: true, value: 'webflow_img_456' });
    });

    it('should use @asset/ prefix for existing but unpublished asset (pending publish ID)', async () => {
      const pendingId = createScratchPendingPublishId();
      const lookup = createLookupTools({
        att_1: { result: { destinationAssetRemoteId: pendingId, isNew: false } },
      });
      const result = await sourceAssetToDestAssetTransformer.transform(createContext('att_1', lookup));
      expect(result).toEqual({ success: true, value: `@asset/${pendingId}` });
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
      const lookup = createLookupTools({
        att_1: { result: { destinationAssetRemoteId: tempId1, isNew: true } },
        att_2: { result: { destinationAssetRemoteId: tempId2, isNew: true } },
      });
      const result = await sourceAssetToDestAssetTransformer.transform(createContext(['att_1', 'att_2'], lookup));
      expect(result).toEqual({ success: true, value: [`@asset/${tempId1}`, `@asset/${tempId2}`] });
    });

    it('should skip null/undefined elements in arrays', async () => {
      const tempId = createScratchPendingPublishId();
      const lookup = createLookupTools({
        att_1: { result: { destinationAssetRemoteId: tempId, isNew: true } },
      });
      const result = await sourceAssetToDestAssetTransformer.transform(
        createContext(['att_1', null, undefined], lookup),
      );
      expect(result).toEqual({ success: true, value: [`@asset/${tempId}`] });
    });

    it('should mix new and existing assets in arrays', async () => {
      const tempId = createScratchPendingPublishId();
      const lookup = createLookupTools({
        att_1: { result: { destinationAssetRemoteId: 'webflow_img_123', isNew: false } },
        att_2: { result: { destinationAssetRemoteId: tempId, isNew: true } },
      });
      const result = await sourceAssetToDestAssetTransformer.transform(createContext(['att_1', 'att_2'], lookup));
      expect(result).toEqual({ success: true, value: ['webflow_img_123', `@asset/${tempId}`] });
    });

    it('should fail if any array element cannot be resolved', async () => {
      const tempId = createScratchPendingPublishId();
      const lookup = createLookupTools({
        att_1: { result: { destinationAssetRemoteId: tempId, isNew: true } },
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
        expect(result.warnings![0]).toContain('is not rehosted');
      }
    });

    it('should resolve valid assets and skip invalid ones in arrays', async () => {
      const tempId = createScratchPendingPublishId();
      const lookup = createLookupTools({
        att_1: { result: { destinationAssetRemoteId: tempId, isNew: true } },
      });
      const result = await sourceAssetToDestAssetTransformer.transform(
        createContext(['att_1', 'missing'], lookup, ignoreOpts),
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toEqual([`@asset/${tempId}`]);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings![0]).toContain('Source asset "missing" not found');
      }
    });
  });

  describe('skip when destination value is unchanged', () => {
    it('should skip when destination already has the @asset/ reference (scalar)', async () => {
      const tempId = createScratchPendingPublishId();
      const lookup = createLookupTools({
        att_1: { result: { destinationAssetRemoteId: tempId, isNew: true } },
      });
      const result = await sourceAssetToDestAssetTransformer.transform(
        createContext('att_1', lookup, undefined, 'FOREIGN_KEY_MAPPING', `@asset/${tempId}`),
      );
      expect(result).toEqual({ success: true, skip: true });
    });

    it('should skip when destination has raw destination asset ID (scalar)', async () => {
      const lookup = createLookupTools({
        att_1: { result: { destinationAssetRemoteId: 'webflow_img_456', isNew: false } },
      });
      const result = await sourceAssetToDestAssetTransformer.transform(
        createContext('att_1', lookup, undefined, 'FOREIGN_KEY_MAPPING', 'webflow_img_456'),
      );
      expect(result).toEqual({ success: true, skip: true });
    });

    it('should NOT skip when destinationValue is undefined (new record)', async () => {
      const tempId = createScratchPendingPublishId();
      const lookup = createLookupTools({
        att_1: { result: { destinationAssetRemoteId: tempId, isNew: true } },
      });
      const result = await sourceAssetToDestAssetTransformer.transform(
        createContext('att_1', lookup, undefined, 'FOREIGN_KEY_MAPPING', undefined),
      );
      expect(result).toEqual({ success: true, value: `@asset/${tempId}` });
    });

    it('should NOT skip when value differs', async () => {
      const tempId = createScratchPendingPublishId();
      const lookup = createLookupTools({
        att_1: { result: { destinationAssetRemoteId: tempId, isNew: true } },
      });
      const result = await sourceAssetToDestAssetTransformer.transform(
        createContext('att_1', lookup, undefined, 'FOREIGN_KEY_MAPPING', 'stale-id'),
      );
      expect(result).toEqual({ success: true, value: `@asset/${tempId}` });
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
      const lookup = createLookupTools({
        att_1: { result: { destinationAssetRemoteId: tempId1, isNew: true } },
        att_2: { result: { destinationAssetRemoteId: tempId2, isNew: true } },
      });
      const result = await sourceAssetToDestAssetTransformer.transform(
        createContext(['att_1', 'att_2'], lookup, singleOpts),
      );
      expect(result).toEqual({ success: true, value: `@asset/${tempId1}` });
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
      const lookup = createLookupTools({
        att_1: { result: { destinationAssetRemoteId: tempId, isNew: true } },
      });
      const result = await sourceAssetToDestAssetTransformer.transform(createContext('att_1', lookup, singleOpts));
      expect(result).toEqual({ success: true, value: `@asset/${tempId}` });
    });
  });

  describe('idempotency', () => {
    it('should call getOrCreateDestinationAssetMapping for each element', async () => {
      const tempId = createScratchPendingPublishId();
      const lookup = createLookupTools({
        att_1: { result: { destinationAssetRemoteId: tempId, isNew: true } },
      });
      // Same asset referenced twice in an array
      await sourceAssetToDestAssetTransformer.transform(createContext(['att_1', 'att_1'], lookup));
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(lookup.getOrCreateDestinationAssetMapping).toHaveBeenCalledTimes(2);
    });
  });
});
