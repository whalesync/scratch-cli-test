import { Type } from '@sinclair/typebox';
import { Service } from 'src/remote-service/connectors/service-constants';
import { BaseJsonTableSpec } from 'src/remote-service/connectors/types';
import { webflowOptionIdToValueTransformer } from '../implementations/webflow-option-id-to-value.transformer';
import { createNullLookupTools } from '../lookup-tools';
import { SyncRecord, TransformContext } from '../transformer.types';

/** Build a mock BaseJsonTableSpec whose `region` field is a bare (required) Webflow Option union */
function buildSourceSchema(options: { title: string; id: string }[]): BaseJsonTableSpec {
  const regionSchema =
    options.length > 0 ? Type.Union(options.map((o) => Type.Literal(o.id, { title: o.title }))) : Type.String();

  return {
    schema: Type.Object({ region: regionSchema }),
  } as unknown as BaseJsonTableSpec;
}

/**
 * Build a mock BaseJsonTableSpec whose `region` field is a *nullable* Webflow Option field —
 * the option union wrapped in `Type.Union([optionUnion, Type.Null()])`, exactly as an optional
 * Webflow Option column is emitted by `makeWebflowFieldSchemaOptionalNullable`.
 */
function buildNullableSourceSchema(options: { title: string; id: string }[]): BaseJsonTableSpec {
  const optionUnion = Type.Union(options.map((o) => Type.Literal(o.id, { title: o.title })));
  const nullableRegionSchema = Type.Union([optionUnion, Type.Null()]);

  return {
    schema: Type.Object({ region: nullableRegionSchema }),
  } as unknown as BaseJsonTableSpec;
}

const DEFAULT_OPTIONS = [
  { title: 'USA', id: '5af437870a42563741f1d6281dfb22ca' },
  { title: 'Canada', id: 'c3ba02b173ad48ebae258078e3636fca' },
  { title: 'Mexico', id: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6' },
];

function createContext(sourceValue: unknown, sourceTableSpec: BaseJsonTableSpec | null): TransformContext {
  const sourceRecord: SyncRecord = { id: 'test', filePath: '/test', fields: { region: sourceValue } };
  return {
    sourceRecord,
    sourceFieldPath: 'region',
    sourceValue,
    sourceTableSpec,
    sourceService: Service.WEBFLOW,
    lookupTools: createNullLookupTools(),
    destinationFieldPath: 'region',
    destinationTableSpec: null,
    destinationService: Service.AIRTABLE,
    options: {},
    phase: 'DATA',
  };
}

describe('webflowOptionIdToValueTransformer', () => {
  it('should have correct type', () => {
    expect(webflowOptionIdToValueTransformer.type).toBe('webflow_option_id_to_value');
  });

  it('should return null for null input', async () => {
    const result = await webflowOptionIdToValueTransformer.transform(
      createContext(null, buildSourceSchema(DEFAULT_OPTIONS)),
    );
    expect(result).toEqual({ success: true, value: null });
  });

  it('should return null for empty string input', async () => {
    const result = await webflowOptionIdToValueTransformer.transform(
      createContext('', buildSourceSchema(DEFAULT_OPTIONS)),
    );
    expect(result).toEqual({ success: true, value: null });
  });

  it('should map a matching option ID to its title', async () => {
    const result = await webflowOptionIdToValueTransformer.transform(
      createContext('5af437870a42563741f1d6281dfb22ca', buildSourceSchema(DEFAULT_OPTIONS)),
    );
    expect(result).toEqual({ success: true, value: 'USA' });
  });

  it('should map a matching option ID when the source Option field is nullable-wrapped', async () => {
    // Regression: an optional Webflow Option field is wrapped in a nullable union, which previously
    // failed the "is a Webflow Option schema" check and broke Webflow → Airtable syncs.
    const result = await webflowOptionIdToValueTransformer.transform(
      createContext('c3ba02b173ad48ebae258078e3636fca', buildNullableSourceSchema(DEFAULT_OPTIONS)),
    );
    expect(result).toEqual({ success: true, value: 'Canada' });
  });

  it('should fail for non-string input', async () => {
    const result = await webflowOptionIdToValueTransformer.transform(
      createContext(42, buildSourceSchema(DEFAULT_OPTIONS)),
    );
    expect(result).toEqual({
      success: false,
      error: 'Expected a string value, got number',
      useOriginal: true,
    });
  });

  it('should fail for an unrecognized option ID', async () => {
    const result = await webflowOptionIdToValueTransformer.transform(
      createContext('deadbeefdeadbeefdeadbeef', buildSourceSchema(DEFAULT_OPTIONS)),
    );
    expect(result).toEqual({
      success: false,
      error:
        'No matching Webflow option found for ID "deadbeefdeadbeefdeadbeef". Available IDs: 5af437870a42563741f1d6281dfb22ca, c3ba02b173ad48ebae258078e3636fca, a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
      useOriginal: true,
    });
  });

  it('should fail when source schema has no anyOf', async () => {
    const result = await webflowOptionIdToValueTransformer.transform(createContext('USA', buildSourceSchema([])));
    expect(result).toEqual({
      success: false,
      error: 'Source field is not a Webflow Option schema',
      useOriginal: true,
    });
  });

  it('should fail when source schema is missing', async () => {
    const result = await webflowOptionIdToValueTransformer.transform(createContext('USA', null));
    expect(result).toEqual({
      success: false,
      error: 'Schema not found for source folder',
      useOriginal: true,
    });
  });
});
