/**
 * Transformer integration tests.
 *
 * These tests exercise the full transformation pipeline from source value + schema
 * through transformer configs into the destination field value.
 */
import { TSchema, Type } from '@sinclair/typebox';
import { ColumnMapping, TransformerConfig, TransformerTypes } from '@spinner/shared-types';
import { Service } from 'src/remote-service/connectors/service-constants';
import { BaseJsonTableSpec, dotPath } from 'src/remote-service/connectors/types';
import { applyTransformerPipeline, getTransformerConfigs } from '../../transformer-pipeline';
import { LookupTools, SyncRecord } from '../../transformer.types';

// Import implementations to register transformers
import '../../implementations/array-auto-convert.transformer';
import '../../implementations/auto-convert.transformer';
import '../../implementations/jsonpath.transformer';

const mockLookupTools: LookupTools = {
  getDestinationMappingForSourceFk: jest.fn(),
  lookupFieldFromFkRecord: jest.fn(),
  getOrCreateDestinationAssetMapping: jest
    .fn()
    .mockResolvedValue({ destinationFilePath: '/test', destinationRemoteId: 'dest_id' }),
  matchDestinationAssetByHash: jest.fn().mockResolvedValue([]),
};

function makeTableSpec(schema: TSchema): BaseJsonTableSpec {
  return {
    id: { wsId: 'table', remoteId: ['table'] },
    slug: 'table',
    name: 'Table',
    idPath: dotPath('id'),
    schema: Type.Object({ a: schema }),
  };
}

async function runTransform(
  sourceSchema: TSchema,
  sourceValue: unknown,
  destSchema: TSchema,
  transformer: TransformerConfig | TransformerConfig[],
  expectedValue: unknown,
): Promise<void> {
  const mapping: ColumnMapping = Array.isArray(transformer)
    ? { sourceColumnId: 'a', destinationColumnId: 'a', transformers: transformer }
    : { sourceColumnId: 'a', destinationColumnId: 'a', transformer };
  const sourceRecord: SyncRecord = { id: 'rec-1', filePath: '/folder/rec-1.json', fields: {} };
  const ctx = {
    sourceRecord,
    sourceFieldPath: 'a',
    sourceValue,
    sourceTableSpec: makeTableSpec(sourceSchema),
    sourceService: Service.AIRTABLE,
    destinationFieldPath: 'a',
    destinationTableSpec: makeTableSpec(destSchema),
    destinationService: Service.WEBFLOW,
    lookupTools: mockLookupTools,
    options: {},
    phase: 'DATA' as const,
  };

  const result = await applyTransformerPipeline(getTransformerConfigs(mapping), sourceValue, ctx);

  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.value).toStrictEqual(expectedValue);
  }
}

describe('transformer field integration', () => {
  it('auto-converts string "1" to number 1', async () => {
    await runTransform(
      Type.String(),
      '1',
      Type.Number(),
      { type: TransformerTypes.AutoConvert, options: { targetType: 'number' } },
      1,
    );
  });

  it('array-auto-converts string array ["1", "2"] to number array [1, 2]', async () => {
    await runTransform(
      Type.Array(Type.String()),
      ['1', '2'],
      Type.Array(Type.Number()),
      { type: TransformerTypes.ArrayAutoConvert, options: { targetType: 'number' } },
      [1, 2],
    );
  });

  it('extracts id field from object array then converts to number array', async () => {
    await runTransform(
      Type.Array(Type.Object({ id: Type.String() })),
      [{ id: '1' }, { id: '2' }],
      Type.Array(Type.Number()),
      [
        { type: TransformerTypes.JSONPath, options: { expression: '$[*].id', arrayHandling: 'array' } },
        { type: TransformerTypes.ArrayAutoConvert, options: { targetType: 'number' } },
      ],
      [1, 2],
    );
  });

  /**
   * AutoConvert with targetType 'string' on an array joins items with ', '
   * rather than converting each element to a string individually, so the result
   * is '1, 2' (a single string), not ['1', '2'] (a string array).
   */
  it('auto-converts number array to string by joining with ", "', async () => {
    await runTransform(
      Type.Array(Type.Number()),
      [1, 2],
      Type.Array(Type.String()),
      { type: TransformerTypes.AutoConvert, options: { targetType: 'string' } },
      '1, 2',
    );
  });
});
