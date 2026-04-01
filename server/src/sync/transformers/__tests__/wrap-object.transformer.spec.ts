import { WrapObjectOptions } from '@spinner/shared-types';
import { Service } from 'src/remote-service/connectors/service-constants';
import { wrapObjectTransformer } from '../implementations/wrap-object.transformer';
import { createNullLookupTools } from '../lookup-tools';
import { SyncRecord, TransformContext } from '../transformer.types';

function createContext(sourceValue: unknown, options?: WrapObjectOptions): TransformContext {
  const sourceRecord: SyncRecord = { id: 'test', filePath: '/test', fields: { value: sourceValue } };
  return {
    sourceRecord,
    sourceFieldPath: 'value',
    sourceValue,
    sourceTableSpec: null,
    sourceService: Service.AIRTABLE,
    destinationFieldPath: 'value',
    destinationTableSpec: null,
    destinationService: Service.WEBFLOW,
    lookupTools: createNullLookupTools(),
    options: options ?? {},
    phase: 'DATA',
  };
}

describe('wrapObjectTransformer', () => {
  it('should have correct type', () => {
    expect(wrapObjectTransformer.type).toBe('wrap_object');
  });

  it('should wrap a string value into an object', async () => {
    const result = await wrapObjectTransformer.transform(createContext('Tag 1', { template: { name: '$value' } }));
    expect(result).toEqual({ success: true, value: { name: 'Tag 1' } });
  });

  it('should wrap a number value into an object', async () => {
    const result = await wrapObjectTransformer.transform(createContext(42, { template: { id: '$value' } }));
    expect(result).toEqual({ success: true, value: { id: 42 } });
  });

  it('should preserve static template values', async () => {
    const result = await wrapObjectTransformer.transform(
      createContext('Tag 1', { template: { name: '$value', type: 'tag' } }),
    );
    expect(result).toEqual({ success: true, value: { name: 'Tag 1', type: 'tag' } });
  });

  it('should support multiple $value replacements', async () => {
    const result = await wrapObjectTransformer.transform(
      createContext('hello', { template: { a: '$value', b: '$value' } }),
    );
    expect(result).toEqual({ success: true, value: { a: 'hello', b: 'hello' } });
  });

  it('should return null for null input', async () => {
    const result = await wrapObjectTransformer.transform(createContext(null, { template: { name: '$value' } }));
    expect(result).toEqual({ success: true, value: null });
  });

  it('should return null for undefined input', async () => {
    const result = await wrapObjectTransformer.transform(createContext(undefined, { template: { name: '$value' } }));
    expect(result).toEqual({ success: true, value: null });
  });

  it('should error when template is missing', async () => {
    const result = await wrapObjectTransformer.transform(createContext('hello'));
    expect(result).toEqual({ success: false, error: 'wrap_object requires a "template" option (object)' });
  });
});
