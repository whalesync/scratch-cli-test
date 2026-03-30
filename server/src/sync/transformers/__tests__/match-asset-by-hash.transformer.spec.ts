import { DataFolderId, MatchAssetByHashOptions } from '@spinner/shared-types';
import { Service } from 'src/remote-service/connectors/service-constants';
import { matchAssetByHashTransformer } from '../implementations/match-asset-by-hash.transformer';
import { LookupTools, SyncRecord, TransformContext } from '../transformer.types';

const SOURCE_FOLDER = 'dfd_source';
const DEST_FOLDER = 'dfd_dest';

function makeContext(
  sourceValue: unknown,
  matchFn: LookupTools['matchDestinationAssetByHash'],
  destinationValue?: unknown,
): TransformContext {
  const options: MatchAssetByHashOptions = {
    sourceDataFolderId: SOURCE_FOLDER as DataFolderId,
    destinationDataFolderId: DEST_FOLDER as DataFolderId,
    onUnresolved: 'fail',
    outputType: 'single',
  };
  return {
    sourceRecord: { id: 'rec1', filePath: '/file.json', fields: {} } as SyncRecord,
    sourceFieldPath: 'fields.Logo',
    sourceValue,
    sourceTableSpec: null,
    sourceService: Service.AIRTABLE,
    destinationFieldPath: 'fieldData.logo',
    destinationValue,
    destinationTableSpec: null,
    destinationService: Service.WEBFLOW,
    lookupTools: {
      getDestinationMappingForSourceFk: () => Promise.resolve(null),
      lookupFieldFromFkRecord: () => Promise.resolve(undefined),
      getOrCreateDestinationAssetMapping: () => Promise.reject(new Error('not used')),
      matchDestinationAssetByHash: matchFn,
    } satisfies LookupTools,
    options,
    phase: 'FOREIGN_KEY_MAPPING',
  };
}

describe('matchAssetByHashTransformer', () => {
  it('returns the destination asset remote ID when hash matches', async () => {
    const ctx = makeContext('attSourceId', () => Promise.resolve('webflow_dest_id'));

    const result = await matchAssetByHashTransformer.transform(ctx);

    expect(result.success).toBe(true);
    expect(result).toHaveProperty('value', 'webflow_dest_id');
  });

  it('fails when no hash match and onUnresolved=fail', async () => {
    const ctx = makeContext('attSourceId', () => Promise.resolve(null));

    const result = await matchAssetByHashTransformer.transform(ctx);

    expect(result.success).toBe(false);
    expect(result).toHaveProperty('error');
  });

  it('skips with warning when no hash match and onUnresolved=ignore', async () => {
    const ctx = makeContext('attSourceId', () => Promise.resolve(null));
    (ctx.options as MatchAssetByHashOptions).onUnresolved = 'ignore';

    const result = await matchAssetByHashTransformer.transform(ctx);

    expect(result.success).toBe(true);
    expect(result).toHaveProperty('value', null);
    expect(result).toHaveProperty('warnings');
  });

  it('returns null for null/undefined source value', async () => {
    const ctx = makeContext(null, () => Promise.reject(new Error('should not be called')));

    const result = await matchAssetByHashTransformer.transform(ctx);

    expect(result.success).toBe(true);
    expect(result).toHaveProperty('value', null);
  });

  it('handles array of asset IDs', async () => {
    const ctx = makeContext(['att1', 'att2'], (id) => {
      if (id === 'att1') return Promise.resolve('wf_1');
      if (id === 'att2') return Promise.resolve('wf_2');
      return Promise.resolve(null);
    });
    (ctx.options as MatchAssetByHashOptions).outputType = 'array';

    const result = await matchAssetByHashTransformer.transform(ctx);

    expect(result.success).toBe(true);
    expect(result).toHaveProperty('value', ['wf_1', 'wf_2']);
  });

  it('skips when resolved value matches existing destination', async () => {
    const ctx = makeContext('attSourceId', () => Promise.resolve('webflow_dest_id'), 'webflow_dest_id');

    const result = await matchAssetByHashTransformer.transform(ctx);

    expect(result.success).toBe(true);
    expect(result).toHaveProperty('skip', true);
  });

  it('does not skip when resolved value differs from existing destination', async () => {
    const ctx = makeContext('attSourceId', () => Promise.resolve('new_webflow_id'), 'old_webflow_id');

    const result = await matchAssetByHashTransformer.transform(ctx);

    expect(result.success).toBe(true);
    expect(result).toHaveProperty('value', 'new_webflow_id');
    expect(result).not.toHaveProperty('skip');
  });

  it('returns error for non-string source value', async () => {
    const ctx = makeContext(42, () => Promise.resolve(null));

    const result = await matchAssetByHashTransformer.transform(ctx);

    expect(result.success).toBe(false);
    expect(result).toHaveProperty('error');
  });
});
