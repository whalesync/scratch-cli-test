import { Type } from '@sinclair/typebox';
import { Service } from 'src/remote-service/connectors/service-constants';
import { BaseJsonTableSpec } from 'src/remote-service/connectors/types';
import { webflowOptionTransformer } from '../implementations/webflow-option.transformer';
import { createNullLookupTools } from '../lookup-tools';
import { SyncRecord, TransformContext } from '../transformer.types';

/** Build a mock BaseJsonTableSpec whose schema has a single `region` field with the given anyOf options */
function buildDestinationSchema(options: { title: string; id: string }[]): BaseJsonTableSpec {
  const regionSchema =
    options.length > 0 ? Type.Union(options.map((o) => Type.Literal(o.id, { title: o.title }))) : Type.String();

  return {
    schema: Type.Object({ region: regionSchema }),
  } as BaseJsonTableSpec;
}

const DEFAULT_OPTIONS = [
  { title: 'USA', id: '5af437870a42563741f1d6281dfb22ca' },
  { title: 'Canada', id: 'c3ba02b173ad48ebae258078e3636fca' },
  { title: 'Mexico', id: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6' },
];

function createContext(sourceValue: unknown, options = DEFAULT_OPTIONS): TransformContext {
  const sourceRecord: SyncRecord = { id: 'test', filePath: '/test', fields: { region: sourceValue } };
  return {
    sourceRecord,
    sourceFieldPath: 'region',
    sourceValue,
    sourceTableSpec: null,
    sourceService: Service.AIRTABLE,
    lookupTools: createNullLookupTools(),
    destinationFieldPath: 'region',
    destinationTableSpec: buildDestinationSchema(options),
    destinationService: Service.WEBFLOW,
    options: {},
    phase: 'DATA',
  };
}

describe('webflowOptionTransformer', () => {
  it('should have correct type', () => {
    expect(webflowOptionTransformer.type).toBe('webflow_option');
  });

  it('should return null for null input', async () => {
    const result = await webflowOptionTransformer.transform(createContext(null));
    expect(result).toEqual({ success: true, value: null });
  });

  it('should return null for undefined input', async () => {
    const result = await webflowOptionTransformer.transform(createContext(undefined));
    expect(result).toEqual({ success: true, value: null });
  });

  it('should return null for empty string input', async () => {
    const result = await webflowOptionTransformer.transform(createContext(''));
    expect(result).toEqual({ success: true, value: null });
  });

  it('should map a matching title to its option ID', async () => {
    const result = await webflowOptionTransformer.transform(createContext('USA'));
    expect(result).toEqual({ success: true, value: '5af437870a42563741f1d6281dfb22ca' });
  });

  it('should map another matching title', async () => {
    const result = await webflowOptionTransformer.transform(createContext('Canada'));
    expect(result).toEqual({ success: true, value: 'c3ba02b173ad48ebae258078e3636fca' });
  });

  it('should match case-insensitively', async () => {
    const result = await webflowOptionTransformer.transform(createContext('usa'));
    expect(result).toEqual({ success: true, value: '5af437870a42563741f1d6281dfb22ca' });
  });

  it('should match case-insensitively with mixed case', async () => {
    const result = await webflowOptionTransformer.transform(createContext('cAnAdA'));
    expect(result).toEqual({ success: true, value: 'c3ba02b173ad48ebae258078e3636fca' });
  });

  it('should fail for non-string input', async () => {
    const result = await webflowOptionTransformer.transform(createContext(42));
    expect(result).toEqual({
      success: false,
      error: 'Expected a string value, got number',
      useOriginal: true,
    });
  });

  it('should fail for unrecognized option', async () => {
    const result = await webflowOptionTransformer.transform(createContext('Brazil'));
    expect(result).toEqual({
      success: false,
      error: 'No matching Webflow option found for "Brazil". Available options: USA, Canada, Mexico',
      useOriginal: true,
    });
  });

  it('should fail when destination schema has no anyOf', async () => {
    const result = await webflowOptionTransformer.transform(createContext('USA', []));
    expect(result).toEqual({
      success: false,
      error: 'Destination field is not a Webflow Option schema',
      useOriginal: true,
    });
  });

  it('should fail when destination schema is missing', async () => {
    const ctx = createContext('USA');
    ctx.destinationTableSpec = null;
    const result = await webflowOptionTransformer.transform(ctx);
    expect(result).toEqual({
      success: false,
      error: 'Schema not found for destination folder',
      useOriginal: true,
    });
  });
});
