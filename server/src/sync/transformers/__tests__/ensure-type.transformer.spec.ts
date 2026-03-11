import { EnsureTypeOptions } from '@spinner/shared-types';
import { ensureTypeTransformer } from '../implementations/ensure-type.transformer';
import { TransformContext } from '../transformer.types';

describe('ensureTypeTransformer', () => {
  const createContext = (sourceValue: unknown, options: EnsureTypeOptions): TransformContext =>
    ({
      sourceValue,
      options,
    }) as TransformContext;

  async function runTest(
    input: unknown,
    options: EnsureTypeOptions,
    expected: {
      success: boolean;
      value?: unknown;
      skip?: boolean;
      errorContains?: string;
    },
  ) {
    const result = await ensureTypeTransformer.transform(createContext(input, options));
    expect(result.success).toBe(expected.success);

    if (expected.success) {
      if (result.success) {
        if (expected.skip !== undefined) {
          expect(result.skip).toBe(expected.skip);
        } else {
          expect(result.value).toEqual(expected.value);
        }
      }
    } else {
      if (!result.success && expected.errorContains) {
        expect(result.error).toContain(expected.errorContains);
      }
    }
  }

  describe('type validation', () => {
    it('should validate string correctly', async () => {
      await runTest('hello', { expectedType: 'string', onFailure: 'error' }, { success: true, value: 'hello' });
      await runTest(123, { expectedType: 'string', onFailure: 'error' }, { success: false });
    });

    it('should validate number correctly', async () => {
      await runTest(123, { expectedType: 'number', onFailure: 'error' }, { success: true, value: 123 });
      await runTest('123', { expectedType: 'number', onFailure: 'error' }, { success: false });
      await runTest(NaN, { expectedType: 'number', onFailure: 'error' }, { success: false });
    });

    it('should validate boolean correctly', async () => {
      await runTest(true, { expectedType: 'boolean', onFailure: 'error' }, { success: true, value: true });
      await runTest(1, { expectedType: 'boolean', onFailure: 'error' }, { success: false });
    });

    it('should validate object correctly', async () => {
      await runTest({ a: 1 }, { expectedType: 'object', onFailure: 'error' }, { success: true, value: { a: 1 } });
      await runTest([1, 2], { expectedType: 'object', onFailure: 'error' }, { success: false }); // Array is not valid object
      await runTest(null, { expectedType: 'object', onFailure: 'error' }, { success: false }); // Null is not valid object
    });

    it('should validate array correctly', async () => {
      await runTest([1, 2], { expectedType: 'array', onFailure: 'error' }, { success: true, value: [1, 2] });
      await runTest({ a: 1 }, { expectedType: 'array', onFailure: 'error' }, { success: false });
    });
  });

  describe('onFailure handling', () => {
    it('should return null when onFailure is "null"', async () => {
      await runTest(123, { expectedType: 'string', onFailure: 'null' }, { success: true, value: null });
    });

    it('should set skip flag when onFailure is "omit"', async () => {
      await runTest(123, { expectedType: 'string', onFailure: 'omit' }, { success: true, skip: true });
    });

    it('should return parsed fallback value when onFailure is "other"', async () => {
      // String
      await runTest(
        123,
        { expectedType: 'string', onFailure: 'other', fallbackValue: 'hello' },
        { success: true, value: 'hello' },
      );

      // Number
      await runTest(
        'abc',
        { expectedType: 'number', onFailure: 'other', fallbackValue: '42' },
        { success: true, value: 42 },
      );

      // Boolean
      await runTest(
        'abc',
        { expectedType: 'boolean', onFailure: 'other', fallbackValue: 'true' },
        { success: true, value: true },
      );

      // Object
      await runTest(
        'abc',
        { expectedType: 'object', onFailure: 'other', fallbackValue: '{"foo":"bar"}' },
        { success: true, value: { foo: 'bar' } },
      );

      // Array
      await runTest(
        'abc',
        { expectedType: 'array', onFailure: 'other', fallbackValue: '[1, 2, 3]' },
        { success: true, value: [1, 2, 3] },
      );
    });

    it('should return an error when onFailure is "error"', async () => {
      await runTest(
        123,
        { expectedType: 'string', onFailure: 'error' },
        { success: false, errorContains: 'Value did not match expected type' },
      );
    });

    it('should return errors for invalid fallback values', async () => {
      await runTest(
        'abc',
        { expectedType: 'number', onFailure: 'other', fallbackValue: 'not a number' },
        { success: false, errorContains: 'could not be parsed as a number' },
      );

      await runTest(
        'abc',
        { expectedType: 'object', onFailure: 'other', fallbackValue: '[]' },
        { success: false, errorContains: 'not a valid JSON object' },
      );

      await runTest(
        'abc',
        { expectedType: 'array', onFailure: 'other', fallbackValue: '{}' },
        { success: false, errorContains: 'not a valid JSON array' },
      );
    });
  });
});
