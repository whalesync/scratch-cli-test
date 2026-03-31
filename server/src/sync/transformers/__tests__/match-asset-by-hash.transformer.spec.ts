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
  },
): TransformContext {
  const options: MatchAssetByHashOptions = {
    sourceDataFolderId: SOURCE_FOLDER,
    destinationDataFolderId: DEST_FOLDER,
    onUnresolved: overrides?.onUnresolved ?? 'fail',
    outputType: overrides?.outputType ?? 'single',
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
      matchDestinationAssetByHash: overrides?.matchFn ?? (() => Promise.resolve(null)),
    } satisfies LookupTools,
    options,
    phase: 'FOREIGN_KEY_MAPPING',
  };
}

describe('matchAssetByHashTransformer', () => {
  describe('hash matching (strategy 1)', () => {
    it('returns destination asset ID when hash matches', async () => {
      const ctx = makeContext('attSource', { matchFn: () => Promise.resolve('wf_dest_id') });

      const result = await matchAssetByHashTransformer.transform(ctx);

      expect(result.success).toBe(true);
      expect(result).toHaveProperty('value', 'wf_dest_id');
    });

    it('skips when hash match equals existing destination value', async () => {
      const ctx = makeContext('attSource', {
        matchFn: () => Promise.resolve('wf_dest_id'),
        destinationValue: 'wf_dest_id',
      });

      const result = await matchAssetByHashTransformer.transform(ctx);

      expect(result.success).toBe(true);
      expect(result).toHaveProperty('skip', true);
    });

    it('handles array of asset IDs', async () => {
      const ctx = makeContext(['att1', 'att2'], {
        matchFn: (id) => {
          if (id === 'att1') return Promise.resolve('wf_1');
          if (id === 'att2') return Promise.resolve('wf_2');
          return Promise.resolve(null);
        },
        outputType: 'array',
      });

      const result = await matchAssetByHashTransformer.transform(ctx);

      expect(result.success).toBe(true);
      expect(result).toHaveProperty('value', ['wf_1', 'wf_2']);
    });
  });

  describe('fallback to create + upload (strategy 2)', () => {
    it('creates destination asset when no hash match', async () => {
      const mockMapping: AssetMappingResult = {
        destinationAssetId: 'asset_new',
        destinationAssetRemoteId: 'PENDING_PUBLISH_abc',
        isNew: true,
      };
      const ctx = makeContext('attSource', {
        matchFn: () => Promise.resolve(null),
        createFn: () => Promise.resolve(mockMapping),
      });

      const result = await matchAssetByHashTransformer.transform(ctx);

      expect(result.success).toBe(true);
      expect(result).toHaveProperty('value', '@asset/asset_new');
    });

    it('returns existing destination remote ID for previously published asset', async () => {
      const mockMapping: AssetMappingResult = {
        destinationAssetId: 'asset_existing',
        destinationAssetRemoteId: '69c19db1abc123',
        isNew: false,
      };
      const ctx = makeContext('attSource', {
        matchFn: () => Promise.resolve(null),
        createFn: () => Promise.resolve(mockMapping),
      });

      const result = await matchAssetByHashTransformer.transform(ctx);

      expect(result.success).toBe(true);
      expect(result).toHaveProperty('value', '69c19db1abc123');
    });

    it('fails with ASSET_NOT_FOUND when source asset missing', async () => {
      const ctx = makeContext('attMissing', {
        matchFn: () => Promise.resolve(null),
        createFn: () => Promise.reject(new Error('ASSET_NOT_FOUND')),
      });

      const result = await matchAssetByHashTransformer.transform(ctx);

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('not found');
    });

    it('warns and continues for ASSET_NOT_FOUND when onUnresolved=ignore', async () => {
      const ctx = makeContext('attMissing', {
        matchFn: () => Promise.resolve(null),
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
        matchFn: () => Promise.resolve(null),
        createFn: () => Promise.reject(new Error('ASSET_NOT_REHOSTED')),
      });

      const result = await matchAssetByHashTransformer.transform(ctx);

      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('Pull Assets');
    });
  });

  describe('edge cases', () => {
    it('returns null for null source value', async () => {
      const ctx = makeContext(null);

      const result = await matchAssetByHashTransformer.transform(ctx);

      expect(result.success).toBe(true);
      expect(result).toHaveProperty('value', null);
    });

    it('returns error for non-string source value', async () => {
      const ctx = makeContext(42);

      const result = await matchAssetByHashTransformer.transform(ctx);

      expect(result.success).toBe(false);
    });

    it('does not skip when resolved differs from existing destination', async () => {
      const ctx = makeContext('attSource', {
        matchFn: () => Promise.resolve('new_wf_id'),
        destinationValue: 'old_wf_id',
      });

      const result = await matchAssetByHashTransformer.transform(ctx);

      expect(result.success).toBe(true);
      expect(result).toHaveProperty('value', 'new_wf_id');
      expect(result).not.toHaveProperty('skip');
    });
  });
});
