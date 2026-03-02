import { JSONPathOptions } from '@spinner/shared-types';
import { jsonpathTransformer } from '../implementations/jsonpath.transformer';
import { SyncRecord, TransformContext } from '../transformer.types';

function createContext(sourceValue: unknown, options: JSONPathOptions): TransformContext {
  const sourceRecord: SyncRecord = { id: 'test', filePath: '/test', fields: { value: sourceValue } };
  return {
    sourceRecord,
    sourceFieldPath: 'value',
    sourceValue,
    lookupTools: {
      getDestinationMappingForSourceFk: jest.fn(),
      lookupFieldFromFkRecord: jest.fn(),
    },
    options,
    phase: 'DATA',
  };
}

describe('jsonpathTransformer', () => {
  it('should have correct type', () => {
    expect(jsonpathTransformer.type).toBe('jsonpath');
  });

  describe('general behavior', () => {
    it('should skip non-DATA phases', async () => {
      const ctx = createContext({ name: 'Alice' }, { expression: '$.name' });
      ctx.phase = 'FOREIGN_KEY_MAPPING';
      const result = await jsonpathTransformer.transform(ctx);
      expect(result).toEqual({ success: true, skip: true });
    });

    it('should return null for null input', async () => {
      const result = await jsonpathTransformer.transform(createContext(null, { expression: '$.name' }));
      expect(result).toEqual({ success: true, value: null });
    });

    it('should return null for undefined input', async () => {
      const result = await jsonpathTransformer.transform(createContext(undefined, { expression: '$.name' }));
      expect(result).toEqual({ success: true, value: null });
    });
  });

  describe('object source values', () => {
    it('should extract a simple property', async () => {
      const result = await jsonpathTransformer.transform(createContext({ name: 'Alice' }, { expression: '$.name' }));
      expect(result).toEqual({ success: true, value: 'Alice' });
    });

    it('should extract a nested property', async () => {
      const result = await jsonpathTransformer.transform(
        createContext({ a: { b: { c: 42 } } }, { expression: '$.a.b.c' }),
      );
      expect(result).toEqual({ success: true, value: 42 });
    });

    it('should extract an array element by index', async () => {
      const result = await jsonpathTransformer.transform(
        createContext({ items: ['x', 'y'] }, { expression: '$.items[0]' }),
      );
      expect(result).toEqual({ success: true, value: 'x' });
    });

    it('should return first value for wildcard matches by default', async () => {
      const result = await jsonpathTransformer.transform(
        createContext({ items: ['a', 'b', 'c'] }, { expression: '$.items[*]' }),
      );
      expect(result).toEqual({ success: true, value: 'a' });
    });

    it('should return error with useOriginal=false when no match', async () => {
      const result = await jsonpathTransformer.transform(createContext({ name: 'Alice' }, { expression: '$.missing' }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('matched no values');
        expect(result.useOriginal).toBe(false);
      }
    });
  });

  describe('string source values', () => {
    it('should parse valid JSON string and query it', async () => {
      const result = await jsonpathTransformer.transform(createContext('{"name":"Alice"}', { expression: '$.name' }));
      expect(result).toEqual({ success: true, value: 'Alice' });
    });

    it('should return error for non-JSON string', async () => {
      const result = await jsonpathTransformer.transform(createContext('not json', { expression: '$.name' }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('not valid JSON');
        expect(result.useOriginal).toBe(false);
      }
    });
  });

  describe('arrayHandling option', () => {
    const data = { items: ['a', 'b', 'c'] };

    it('should return first value with arrayHandling=first', async () => {
      const result = await jsonpathTransformer.transform(
        createContext(data, { expression: '$.items[*]', arrayHandling: 'first' }),
      );
      expect(result).toEqual({ success: true, value: 'a' });
    });

    it('should return full array with arrayHandling=array', async () => {
      const result = await jsonpathTransformer.transform(
        createContext(data, { expression: '$.items[*]', arrayHandling: 'array' }),
      );
      expect(result).toEqual({ success: true, value: ['a', 'b', 'c'] });
    });

    it('should join with spaces with arrayHandling=join_space', async () => {
      const result = await jsonpathTransformer.transform(
        createContext(data, { expression: '$.items[*]', arrayHandling: 'join_space' }),
      );
      expect(result).toEqual({ success: true, value: 'a b c' });
    });

    it('should join with commas with arrayHandling=join_comma', async () => {
      const result = await jsonpathTransformer.transform(
        createContext(data, { expression: '$.items[*]', arrayHandling: 'join_comma' }),
      );
      expect(result).toEqual({ success: true, value: 'a, b, c' });
    });

    it('should still unwrap single results regardless of arrayHandling', async () => {
      const result = await jsonpathTransformer.transform(
        createContext(data, { expression: '$.items[0]', arrayHandling: 'array' }),
      );
      expect(result).toEqual({ success: true, value: 'a' });
    });
  });

  describe('expression normalization', () => {
    it('should auto-prepend $. when expression does not start with $', async () => {
      const result = await jsonpathTransformer.transform(createContext({ name: 'Alice' }, { expression: 'name' }));
      expect(result).toEqual({ success: true, value: 'Alice' });
    });

    it('should auto-prepend $. for nested paths without $', async () => {
      const result = await jsonpathTransformer.transform(createContext({ a: { b: 42 } }, { expression: 'a.b' }));
      expect(result).toEqual({ success: true, value: 42 });
    });

    it('should not modify expressions that already start with $', async () => {
      const result = await jsonpathTransformer.transform(createContext({ name: 'Alice' }, { expression: '$.name' }));
      expect(result).toEqual({ success: true, value: 'Alice' });
    });
  });

  describe('invalid expressions', () => {
    it('should return error for invalid JSONPath expression', async () => {
      const result = await jsonpathTransformer.transform(createContext({ name: 'Alice' }, { expression: '$[invalid' }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Invalid JSONPath expression');
        expect(result.useOriginal).toBe(false);
      }
    });
  });
});
