import { DataFolderId, MatchAssetByHashOptions } from '@spinner/shared-types';
import { Service } from 'src/remote-service/connectors/service-constants';
import { matchAssetByHashTransformer } from '../implementations/match-asset-by-hash.transformer';
import { AssetMappingResult, LookupTools, SyncRecord, TransformContext } from '../transformer.types';

const SOURCE_FOLDER = 'dfd_source' as DataFolderId;
const DEST_FOLDER = 'dfd_dest' as DataFolderId;

function makeContext(
  sourceValue: unknown,
  overrides?: {
    matchFn?: LookupTools['matchDestinationAssetByHash'];
    createFn?: LookupTools['getOrCreateDestinationAssetMapping'];
    destinationValue?: unknown;
    onUnresolved?: 'fail' | 'ignore';
    outputType?: 'array' | 'single';
    sourceIdPath?: string;
    destinationIdPath?: string;
  },
): TransformContext {
  const options: MatchAssetByHashOptions = {
    sourceDataFolderId: SOURCE_FOLDER,
    destinationDataFolderId: DEST_FOLDER,
    onUnresolved: overrides?.onUnresolved ?? 'fail',
    outputType: overrides?.outputType ?? 'single',
    sourceIdPath: overrides?.sourceIdPath,
    destinationIdPath: overrides?.destinationIdPath,
  };
  return {
    sourceRecord: { id: 'rec1', filePath: '/file.json', fields: {} } as SyncRecord,
    sourceFieldPath: 'fields.Logo',
    sourceValue,
    sourceTableSpec: null,
    sourceService: Service.AIRTABLE,
    destinationFieldPath: 'fieldData.logo',
    destinationValue: overrides?.destinationValue,
    destinationTableSpec: null,
    destinationService: Service.WEBFLOW,
    lookupTools: {
      getDestinationMappingForSourceFk: () => Promise.resolve(null),
      lookupFieldFromFkRecord: () => Promise.resolve(undefined),
      getOrCreateDestinationAssetMapping:
        overrides?.createFn ?? (() => Promise.reject(new Error('create not configured'))),
      matchDestinationAssetByHash: overrides?.matchFn ?? (() => Promise.resolve([])),
    } satisfies LookupTools,
    options,
    phase: 'FOREIGN_KEY_MAPPING',
  };
}

const mockCreateFn = (prefix: string) =>
  ((id: string) =>
    Promise.resolve({
      destinationAssetId: `${prefix}_${id}`,
      destinationAssetRemoteId: `PENDING_PUBLISH_${id}`,
      isNew: true,
    } satisfies AssetMappingResult)) as LookupTools['getOrCreateDestinationAssetMapping'];

describe('matchAssetByHashTransformer', () => {
  describe('skip when all hash match', () => {
    it('skips when hash match equals existing destination value', async () => {
      const ctx = makeContext('attSource', {
        matchFn: () => Promise.resolve(['wf_dest_id']),
        destinationValue: 'wf_dest_id',
      });

      const result = await matchAssetByHashTransformer.transform(ctx);

      expect(result.success).toBe(true);
      expect(result).toHaveProperty('skip', true);
    });

    it('skips when destination ID is among multiple hash matches (duplicates)', async () => {
      const ctx = makeContext('attSource', {
        matchFn: () => Promise.resolve(['wf_dup_1', 'wf_dup_2']),
        destinationValue: 'wf_dup_2',
      });

      const result = await matchAssetByHashTransformer.transform(ctx);

      expect(result.success).toBe(true);
      expect(result).toHaveProperty('skip', true);
    });

    it('skips array when all elements match using destinationIdPath', async () => {
      const ctx = makeContext([{ id: 'att1' }, { id: 'att2' }], {
        matchFn: (id) => {
          if (id === 'att1') return Promise.resolve(['wf_1']);
          if (id === 'att2') return Promise.resolve(['wf_2']);
          return Promise.resolve([]);
        },
        destinationValue: [
          { fileId: 'wf_1', url: 'https://...', alt: null },
          { fileId: 'wf_2', url: 'https://...', alt: null },
        ],
        sourceIdPath: 'id',
        destinationIdPath: 'fileId',
        outputType: 'array',
      });

      const result = await matchAssetByHashTransformer.transform(ctx);

      expect(result.success).toBe(true);
      expect(result).toHaveProperty('skip', true);
    });
  });

  describe('fallback to @asset/ refs', () => {
    it('creates @asset/ ref when no hash match', async () => {
      const ctx = makeContext('attSource', {
        createFn: mockCreateFn('asset'),
      });

      const result = await matchAssetByHashTransformer.transform(ctx);

      expect(result.success).toBe(true);
      expect(result).toHaveProperty('value', '@asset/asset_attSource');
    });

    it('creates @asset/ refs for entire array when one element does not match', async () => {
      const ctx = makeContext([{ id: 'att1' }, { id: 'att2' }], {
        matchFn: (id) => {
          if (id === 'att1') return Promise.resolve(['wf_1']);
          return Promise.resolve([]); // att2 has no match
        },
        createFn: mockCreateFn('asset'),
        destinationValue: [
          { fileId: 'wf_1', url: 'https://...', alt: null },
          { fileId: 'wf_2', url: 'https://...', alt: null },
        ],
        sourceIdPath: 'id',
        destinationIdPath: 'fileId',
        outputType: 'array',
      });

      const result = await matchAssetByHashTransformer.transform(ctx);

      expect(result.success).toBe(true);
      // Both elements get @asset/ refs, not just the unmatched one
      expect(result).toHaveProperty('value', ['@asset/asset_att1', '@asset/asset_att2']);
    });

    it('fails with ASSET_NOT_FOUND when source asset missing', async () => {
      const ctx = makeContext('attMissing', {
        createFn: () => Promise.reject(new Error('ASSET_NOT_FOUND')),
      });

      const result = await matchAssetByHashTransformer.transform(ctx);

      expect(result.success).toBe(false);
      expect((result as { error: string }).error).toContain('not found');
    });

    it('warns and continues for ASSET_NOT_FOUND when onUnresolved=ignore', async () => {
      const ctx = makeContext('attMissing', {
        createFn: () => Promise.reject(new Error('ASSET_NOT_FOUND')),
        onUnresolved: 'ignore',
      });

      const result = await matchAssetByHashTransformer.transform(ctx);

      expect(result.success).toBe(true);
      expect(result).toHaveProperty('value', null);
      expect(result).toHaveProperty('warnings');
    });

    it('fails with ASSET_NOT_REHOSTED when not rehosted', async () => {
      const ctx = makeContext('attNoRehost', {
        createFn: () => Promise.reject(new Error('ASSET_NOT_REHOSTED')),
      });

      const result = await matchAssetByHashTransformer.transform(ctx);

      expect(result.success).toBe(false);
      expect((result as { error: string }).error).toContain('Pull Assets');
    });
  });

  describe('edge cases', () => {
    it('returns null for null source value', async () => {
      const result = await matchAssetByHashTransformer.transform(makeContext(null));

      expect(result.success).toBe(true);
      expect(result).toHaveProperty('value', null);
    });

    it('returns error for non-string source value', async () => {
      const result = await matchAssetByHashTransformer.transform(makeContext(42));

      expect(result.success).toBe(false);
    });

    it('does not skip when hash match differs from existing destination', async () => {
      const ctx = makeContext('attSource', {
        matchFn: () => Promise.resolve(['new_wf_id']),
        createFn: mockCreateFn('asset'),
        destinationValue: 'old_wf_id',
      });

      const result = await matchAssetByHashTransformer.transform(ctx);

      expect(result.success).toBe(true);
      expect(result).not.toHaveProperty('skip');
      // Falls back to @asset/ ref
      expect(result).toHaveProperty('value', '@asset/asset_attSource');
    });
  });
});
