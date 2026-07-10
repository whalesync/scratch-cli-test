import { AutoConvertOptions } from '@spinner/shared-types';
import { Service } from 'src/remote-service/connectors/service-constants';
import { autoConvertTransformer } from '../implementations/auto-convert.transformer';
import { createNullLookupTools } from '../lookup-tools';
import { SyncRecord, TransformContext } from '../transformer.types';

function createContext(sourceValue: unknown, options: AutoConvertOptions): TransformContext {
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

describe('autoConvertTransformer', () => {
  it('should have correct type', () => {
    expect(autoConvertTransformer.type).toBe('auto_convert');
  });

  describe('general behavior', () => {
    it('should return empty string for null input when target is string', async () => {
      const result = await autoConvertTransformer.transform(createContext(null, { targetType: 'string' }));
      expect(result).toEqual({ success: true, value: '' });
    });

    it('should return empty string for undefined input when target is string', async () => {
      const result = await autoConvertTransformer.transform(createContext(undefined, { targetType: 'string' }));
      expect(result).toEqual({ success: true, value: '' });
    });

    it('should return 0 for null input when target is number', async () => {
      const result = await autoConvertTransformer.transform(createContext(null, { targetType: 'number' }));
      expect(result).toEqual({ success: true, value: 0 });
    });

    it('should return 0 for undefined input when target is number', async () => {
      const result = await autoConvertTransformer.transform(createContext(undefined, { targetType: 'number' }));
      expect(result).toEqual({ success: true, value: 0 });
    });

    it('should return 0 for null input when target is integer', async () => {
      const result = await autoConvertTransformer.transform(createContext(null, { targetType: 'integer' }));
      expect(result).toEqual({ success: true, value: 0 });
    });

    it('should return false for null input when target is boolean', async () => {
      const result = await autoConvertTransformer.transform(createContext(null, { targetType: 'boolean' }));
      expect(result).toEqual({ success: true, value: false });
    });

    it('should return empty array for null input when target is array', async () => {
      const result = await autoConvertTransformer.transform(createContext(null, { targetType: 'array' }));
      expect(result).toEqual({ success: true, value: [] });
    });

    it('should preserve null when preserveNull is true (string target)', async () => {
      const result = await autoConvertTransformer.transform(
        createContext(null, { targetType: 'string', preserveNull: true }),
      );
      expect(result).toEqual({ success: true, value: null });
    });

    it('should preserve null when preserveNull is true (boolean target)', async () => {
      const result = await autoConvertTransformer.transform(
        createContext(null, { targetType: 'boolean', preserveNull: true }),
      );
      expect(result).toEqual({ success: true, value: null });
    });

    it('should preserve null when preserveNull is true (number target)', async () => {
      const result = await autoConvertTransformer.transform(
        createContext(null, { targetType: 'number', preserveNull: true }),
      );
      expect(result).toEqual({ success: true, value: null });
    });
  });

  describe('target: string', () => {
    const opts: AutoConvertOptions = { targetType: 'string' };

    it('should pass through strings', async () => {
      const result = await autoConvertTransformer.transform(createContext('hello', opts));
      expect(result).toEqual({ success: true, value: 'hello' });
    });

    it('should convert number to string', async () => {
      const result = await autoConvertTransformer.transform(createContext(42, opts));
      expect(result).toEqual({ success: true, value: '42' });
    });

    it('should convert float to string', async () => {
      const result = await autoConvertTransformer.transform(createContext(3.14, opts));
      expect(result).toEqual({ success: true, value: '3.14' });
    });

    it('should convert boolean true to string', async () => {
      const result = await autoConvertTransformer.transform(createContext(true, opts));
      expect(result).toEqual({ success: true, value: 'true' });
    });

    it('should convert boolean false to string', async () => {
      const result = await autoConvertTransformer.transform(createContext(false, opts));
      expect(result).toEqual({ success: true, value: 'false' });
    });

    it('should convert single-element array to string', async () => {
      const result = await autoConvertTransformer.transform(createContext(['hi'], opts));
      expect(result).toEqual({ success: true, value: 'hi' });
    });

    it('should convert multi-element array to comma-separated string', async () => {
      const result = await autoConvertTransformer.transform(createContext(['a', 'b', 'c'], opts));
      expect(result).toEqual({ success: true, value: 'a, b, c' });
    });

    it('should convert empty array to empty string', async () => {
      const result = await autoConvertTransformer.transform(createContext([], opts));
      expect(result).toEqual({ success: true, value: '' });
    });

    it('should JSON-stringify an object instead of failing (default stringify for string target)', async () => {
      const result = await autoConvertTransformer.transform(createContext({ foo: 1 }, opts));
      expect(result).toEqual({ success: true, value: '{"foo":1}' });
    });

    it('should JSON-stringify a nested object (e.g. a Shopify featuredImage/category value)', async () => {
      const featuredImage = { url: 'https://cdn.example.com/x.jpg', altText: 'hero' };
      const result = await autoConvertTransformer.transform(createContext(featuredImage, opts));
      expect(result).toEqual({ success: true, value: JSON.stringify(featuredImage) });
    });

    it('should JSON-stringify object elements in an array rather than emitting [object Object]', async () => {
      const result = await autoConvertTransformer.transform(createContext([{ a: 1 }, { b: 2 }], opts));
      expect(result).toEqual({ success: true, value: '{"a":1}, {"b":2}' });
    });

    it('should not throw on a circular object (falls back to String)', async () => {
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;
      const result = await autoConvertTransformer.transform(createContext(circular, opts));
      expect(result.success).toBe(true);
    });
  });

  describe('target: number', () => {
    const opts: AutoConvertOptions = { targetType: 'number' };

    it('should pass through numbers', async () => {
      const result = await autoConvertTransformer.transform(createContext(42, opts));
      expect(result).toEqual({ success: true, value: 42 });
    });

    it('should convert boolean true to 1', async () => {
      const result = await autoConvertTransformer.transform(createContext(true, opts));
      expect(result).toEqual({ success: true, value: 1 });
    });

    it('should convert boolean false to 0', async () => {
      const result = await autoConvertTransformer.transform(createContext(false, opts));
      expect(result).toEqual({ success: true, value: 0 });
    });

    it('should convert numeric string to number', async () => {
      const result = await autoConvertTransformer.transform(createContext('42', opts));
      expect(result).toEqual({ success: true, value: 42 });
    });

    it('should convert float string to number', async () => {
      const result = await autoConvertTransformer.transform(createContext('3.14', opts));
      expect(result).toEqual({ success: true, value: 3.14 });
    });

    it('should trim whitespace before parsing', async () => {
      const result = await autoConvertTransformer.transform(createContext('  42  ', opts));
      expect(result).toEqual({ success: true, value: 42 });
    });

    it('should return null for empty string', async () => {
      const result = await autoConvertTransformer.transform(createContext('', opts));
      expect(result).toEqual({ success: true, value: null });
    });

    it('should return null for whitespace-only string', async () => {
      const result = await autoConvertTransformer.transform(createContext('   ', opts));
      expect(result).toEqual({ success: true, value: null });
    });

    it('should error for non-numeric string', async () => {
      const result = await autoConvertTransformer.transform(createContext('abc', opts));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Cannot convert');
        expect(result.useOriginal).toBe(true);
      }
    });

    it('should unwrap single-element array', async () => {
      const result = await autoConvertTransformer.transform(createContext(['42'], opts));
      expect(result).toEqual({ success: true, value: 42 });
    });

    it('should unwrap single-element array with number', async () => {
      const result = await autoConvertTransformer.transform(createContext([7], opts));
      expect(result).toEqual({ success: true, value: 7 });
    });

    it('should error for multi-element array', async () => {
      const result = await autoConvertTransformer.transform(createContext([1, 2], opts));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Cannot convert array');
      }
    });

    it('should error for empty array', async () => {
      const result = await autoConvertTransformer.transform(createContext([], opts));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Cannot convert array');
      }
    });

    it('should error for object', async () => {
      const result = await autoConvertTransformer.transform(createContext({ x: 1 }, opts));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Cannot convert');
        expect(result.useOriginal).toBe(true);
      }
    });
  });

  describe('target: integer', () => {
    const opts: AutoConvertOptions = { targetType: 'integer' };

    it('should truncate float to integer', async () => {
      const result = await autoConvertTransformer.transform(createContext(42.9, opts));
      expect(result).toEqual({ success: true, value: 42 });
    });

    it('should pass through integers', async () => {
      const result = await autoConvertTransformer.transform(createContext(42, opts));
      expect(result).toEqual({ success: true, value: 42 });
    });

    it('should truncate negative floats', async () => {
      const result = await autoConvertTransformer.transform(createContext(-3.7, opts));
      expect(result).toEqual({ success: true, value: -3 });
    });

    it('should parse string and truncate', async () => {
      const result = await autoConvertTransformer.transform(createContext('3.14', opts));
      expect(result).toEqual({ success: true, value: 3 });
    });

    it('should return null for empty string', async () => {
      const result = await autoConvertTransformer.transform(createContext('', opts));
      expect(result).toEqual({ success: true, value: null });
    });

    it('should convert boolean true to 1', async () => {
      const result = await autoConvertTransformer.transform(createContext(true, opts));
      expect(result).toEqual({ success: true, value: 1 });
    });

    it('should convert boolean false to 0', async () => {
      const result = await autoConvertTransformer.transform(createContext(false, opts));
      expect(result).toEqual({ success: true, value: 0 });
    });

    it('should error for non-numeric string', async () => {
      const result = await autoConvertTransformer.transform(createContext('abc', opts));
      expect(result.success).toBe(false);
    });
  });

  describe('target: boolean', () => {
    const opts: AutoConvertOptions = { targetType: 'boolean' };

    it('should pass through booleans', async () => {
      const result = await autoConvertTransformer.transform(createContext(true, opts));
      expect(result).toEqual({ success: true, value: true });
    });

    it('should pass through false', async () => {
      const result = await autoConvertTransformer.transform(createContext(false, opts));
      expect(result).toEqual({ success: true, value: false });
    });

    it('should convert 0 to false', async () => {
      const result = await autoConvertTransformer.transform(createContext(0, opts));
      expect(result).toEqual({ success: true, value: false });
    });

    it('should convert non-zero number to true', async () => {
      const result = await autoConvertTransformer.transform(createContext(42, opts));
      expect(result).toEqual({ success: true, value: true });
    });

    it('should convert negative number to true', async () => {
      const result = await autoConvertTransformer.transform(createContext(-1, opts));
      expect(result).toEqual({ success: true, value: true });
    });

    it('should convert "true" to true', async () => {
      const result = await autoConvertTransformer.transform(createContext('true', opts));
      expect(result).toEqual({ success: true, value: true });
    });

    it('should convert "TRUE" to true (case-insensitive)', async () => {
      const result = await autoConvertTransformer.transform(createContext('TRUE', opts));
      expect(result).toEqual({ success: true, value: true });
    });

    it('should convert "yes" to true', async () => {
      const result = await autoConvertTransformer.transform(createContext('yes', opts));
      expect(result).toEqual({ success: true, value: true });
    });

    it('should convert "1" to true', async () => {
      const result = await autoConvertTransformer.transform(createContext('1', opts));
      expect(result).toEqual({ success: true, value: true });
    });

    it('should convert "false" to false', async () => {
      const result = await autoConvertTransformer.transform(createContext('false', opts));
      expect(result).toEqual({ success: true, value: false });
    });

    it('should convert "no" to false', async () => {
      const result = await autoConvertTransformer.transform(createContext('no', opts));
      expect(result).toEqual({ success: true, value: false });
    });

    it('should convert "0" to false', async () => {
      const result = await autoConvertTransformer.transform(createContext('0', opts));
      expect(result).toEqual({ success: true, value: false });
    });

    it('should return null for empty string', async () => {
      const result = await autoConvertTransformer.transform(createContext('', opts));
      expect(result).toEqual({ success: true, value: null });
    });

    it('should error for unrecognized string', async () => {
      const result = await autoConvertTransformer.transform(createContext('maybe', opts));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Cannot convert');
        expect(result.useOriginal).toBe(true);
      }
    });

    it('should unwrap single-element array', async () => {
      const result = await autoConvertTransformer.transform(createContext([true], opts));
      expect(result).toEqual({ success: true, value: true });
    });

    it('should unwrap single-element array with string', async () => {
      const result = await autoConvertTransformer.transform(createContext(['yes'], opts));
      expect(result).toEqual({ success: true, value: true });
    });

    it('should error for multi-element array', async () => {
      const result = await autoConvertTransformer.transform(createContext([true, false], opts));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Cannot convert array');
      }
    });

    it('should error for empty array', async () => {
      const result = await autoConvertTransformer.transform(createContext([], opts));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Cannot convert array');
      }
    });

    it('should error for object', async () => {
      const result = await autoConvertTransformer.transform(createContext({ a: 1 }, opts));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Cannot convert');
        expect(result.useOriginal).toBe(true);
      }
    });
  });

  describe('target: array', () => {
    const opts: AutoConvertOptions = { targetType: 'array' };

    it('should pass through arrays', async () => {
      const result = await autoConvertTransformer.transform(createContext([1, 2, 3], opts));
      expect(result).toEqual({ success: true, value: [1, 2, 3] });
    });

    it('should pass through empty arrays', async () => {
      const result = await autoConvertTransformer.transform(createContext([], opts));
      expect(result).toEqual({ success: true, value: [] });
    });

    it('should wrap string in array', async () => {
      const result = await autoConvertTransformer.transform(createContext('hello', opts));
      expect(result).toEqual({ success: true, value: ['hello'] });
    });

    it('should wrap number in array', async () => {
      const result = await autoConvertTransformer.transform(createContext(42, opts));
      expect(result).toEqual({ success: true, value: [42] });
    });

    it('should wrap boolean in array', async () => {
      const result = await autoConvertTransformer.transform(createContext(true, opts));
      expect(result).toEqual({ success: true, value: [true] });
    });

    it('should wrap object in array', async () => {
      const obj = { key: 'value' };
      const result = await autoConvertTransformer.transform(createContext(obj, opts));
      expect(result).toEqual({ success: true, value: [obj] });
    });
  });
});
