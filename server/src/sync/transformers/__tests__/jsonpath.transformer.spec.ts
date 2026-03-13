import { JSONPathOptions, Service } from '@spinner/shared-types';
import { jsonpathTransformer } from '../implementations/jsonpath.transformer';
import { createNullLookupTools } from '../lookup-tools';
import { SyncRecord, TransformContext } from '../transformer.types';

function createContext(sourceValue: unknown, options: JSONPathOptions): TransformContext {
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
    options,
    phase: 'DATA',
  };
}

describe('jsonpathTransformer', () => {
  it('should have correct type', () => {
    expect(jsonpathTransformer.type).toBe('jsonpath');
  });

  describe('general behavior', () => {
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

    it('should return undefined when no match with default arrayHandling', async () => {
      const result = await jsonpathTransformer.transform(createContext({ name: 'Alice' }, { expression: '$.missing' }));
      expect(result).toEqual({ success: true, value: undefined });
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

    it('should concatenate without delimiter with arrayHandling=concat', async () => {
      const result = await jsonpathTransformer.transform(
        createContext(data, { expression: '$.items[*]', arrayHandling: 'concat' }),
      );
      expect(result).toEqual({ success: true, value: 'abc' });
    });

    it('should wrap single result in array with arrayHandling=array', async () => {
      const result = await jsonpathTransformer.transform(
        createContext(data, { expression: '$.items[0]', arrayHandling: 'array' }),
      );
      expect(result).toEqual({ success: true, value: ['a'] });
    });

    it('should return empty array for no match with arrayHandling=array', async () => {
      const result = await jsonpathTransformer.transform(
        createContext(data, { expression: '$.missing', arrayHandling: 'array' }),
      );
      expect(result).toEqual({ success: true, value: [] });
    });

    it('should return empty string for no match with arrayHandling=join_space', async () => {
      const result = await jsonpathTransformer.transform(
        createContext(data, { expression: '$.missing', arrayHandling: 'join_space' }),
      );
      expect(result).toEqual({ success: true, value: '' });
    });

    it('should return empty string for no match with arrayHandling=join_comma', async () => {
      const result = await jsonpathTransformer.transform(
        createContext(data, { expression: '$.missing', arrayHandling: 'join_comma' }),
      );
      expect(result).toEqual({ success: true, value: '' });
    });

    it('should return empty string for no match with arrayHandling=concat', async () => {
      const result = await jsonpathTransformer.transform(
        createContext(data, { expression: '$.missing', arrayHandling: 'concat' }),
      );
      expect(result).toEqual({ success: true, value: '' });
    });

    it('should return undefined for no match with arrayHandling=first', async () => {
      const result = await jsonpathTransformer.transform(
        createContext(data, { expression: '$.missing', arrayHandling: 'first' }),
      );
      expect(result).toEqual({ success: true, value: undefined });
    });

    describe('object results that cannot be meaningfully stringified', () => {
      const objectData = { items: [{ id: 1 }, { id: 2 }] };

      it('should return error when join_space encounters object results', async () => {
        const result = await jsonpathTransformer.transform(
          createContext(objectData, { expression: '$.items[*]', arrayHandling: 'join_space' }),
        );
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('cannot be joined');
          expect(result.useOriginal).toBe(false);
        }
      });

      it('should return error when join_comma encounters object results', async () => {
        const result = await jsonpathTransformer.transform(
          createContext(objectData, { expression: '$.items[*]', arrayHandling: 'join_comma' }),
        );
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('cannot be joined');
          expect(result.useOriginal).toBe(false);
        }
      });

      it('should return error when concat encounters object results', async () => {
        const result = await jsonpathTransformer.transform(
          createContext(objectData, { expression: '$.items[*]', arrayHandling: 'concat' }),
        );
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('cannot be joined');
          expect(result.useOriginal).toBe(false);
        }
      });

      it('should succeed when array encounters object results', async () => {
        const result = await jsonpathTransformer.transform(
          createContext(objectData, { expression: '$.items[*]', arrayHandling: 'array' }),
        );
        expect(result).toEqual({ success: true, value: [{ id: 1 }, { id: 2 }] });
      });

      it('should succeed when first encounters object result', async () => {
        const result = await jsonpathTransformer.transform(
          createContext(objectData, { expression: '$.items[0]', arrayHandling: 'first' }),
        );
        expect(result).toEqual({ success: true, value: { id: 1 } });
      });

      it('should return error when join_space encounters a single object result', async () => {
        const result = await jsonpathTransformer.transform(
          createContext(objectData, { expression: '$.items[0]', arrayHandling: 'join_space' }),
        );
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('cannot be joined');
        }
      });

      it('should allow joining arrays that contain only primitives', async () => {
        const mixedData = { tags: ['alpha', 'beta', 42] };
        const result = await jsonpathTransformer.transform(
          createContext(mixedData, { expression: '$.tags[*]', arrayHandling: 'join_comma' }),
        );
        expect(result).toEqual({ success: true, value: 'alpha, beta, 42' });
      });
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
