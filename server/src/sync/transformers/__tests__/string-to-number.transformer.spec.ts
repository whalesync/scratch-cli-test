import { StringToNumberOptions } from '@spinner/shared-types';
import { Service } from 'src/remote-service/connectors/service-constants';
import { stringToNumberTransformer } from '../implementations/string-to-number.transformer';
import { createNullLookupTools } from '../lookup-tools';
import { SyncRecord, TransformContext } from '../transformer.types';

function createContext(sourceValue: unknown, options: StringToNumberOptions = {}): TransformContext {
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

describe('stringToNumberTransformer', () => {
  it('should have correct type', () => {
    expect(stringToNumberTransformer.type).toBe('string_to_number');
  });

  describe('basic parsing', () => {
    it('should parse integer strings', async () => {
      const result = await stringToNumberTransformer.transform(createContext('42'));
      expect(result).toEqual({ success: true, value: 42 });
    });

    it('should parse float strings', async () => {
      const result = await stringToNumberTransformer.transform(createContext('3.14'));
      expect(result).toEqual({ success: true, value: 3.14 });
    });

    it('should parse negative numbers', async () => {
      const result = await stringToNumberTransformer.transform(createContext('-100.5'));
      expect(result).toEqual({ success: true, value: -100.5 });
    });

    it('should handle numbers with leading/trailing spaces', async () => {
      const result = await stringToNumberTransformer.transform(createContext('  42  '));
      expect(result).toEqual({ success: true, value: 42 });
    });
  });

  describe('null/undefined handling', () => {
    it('should return null for null input', async () => {
      const result = await stringToNumberTransformer.transform(createContext(null));
      expect(result).toEqual({ success: true, value: null });
    });

    it('should return null for undefined input', async () => {
      const result = await stringToNumberTransformer.transform(createContext(undefined));
      expect(result).toEqual({ success: true, value: null });
    });

    it('should return null for empty string', async () => {
      const result = await stringToNumberTransformer.transform(createContext(''));
      expect(result).toEqual({ success: true, value: null });
    });

    it('should return null for whitespace-only string', async () => {
      const result = await stringToNumberTransformer.transform(createContext('   '));
      expect(result).toEqual({ success: true, value: null });
    });
  });

  describe('number passthrough', () => {
    it('should pass through numbers unchanged', async () => {
      const result = await stringToNumberTransformer.transform(createContext(42));
      expect(result).toEqual({ success: true, value: 42 });
    });

    it('should pass through floats unchanged', async () => {
      const result = await stringToNumberTransformer.transform(createContext(3.14));
      expect(result).toEqual({ success: true, value: 3.14 });
    });
  });

  describe('stripCurrency option', () => {
    it('should strip dollar sign', async () => {
      const result = await stringToNumberTransformer.transform(createContext('$100', { stripCurrency: true }));
      expect(result).toEqual({ success: true, value: 100 });
    });

    it('should strip euro sign', async () => {
      const result = await stringToNumberTransformer.transform(createContext('€50.00', { stripCurrency: true }));
      expect(result).toEqual({ success: true, value: 50 });
    });

    it('should strip pound sign', async () => {
      const result = await stringToNumberTransformer.transform(createContext('£1,234.56', { stripCurrency: true }));
      expect(result).toEqual({ success: true, value: 1234.56 });
    });

    it('should handle currency with commas as thousands separators', async () => {
      const result = await stringToNumberTransformer.transform(createContext('$1,234,567.89', { stripCurrency: true }));
      expect(result).toEqual({ success: true, value: 1234567.89 });
    });
  });

  describe('parseInteger option', () => {
    it('should parse as integer (floor)', async () => {
      const result = await stringToNumberTransformer.transform(createContext('42.9', { parseInteger: true }));
      expect(result).toEqual({ success: true, value: 42 });
    });

    it('should truncate negative floats towards zero', async () => {
      const result = await stringToNumberTransformer.transform(createContext('-42.1', { parseInteger: true }));
      expect(result).toEqual({ success: true, value: -42 });
    });

    it('should floor number inputs too', async () => {
      const result = await stringToNumberTransformer.transform(createContext(42.9, { parseInteger: true }));
      expect(result).toEqual({ success: true, value: 42 });
    });
  });

  describe('error cases', () => {
    it('should fail for non-parseable strings', async () => {
      const result = await stringToNumberTransformer.transform(createContext('not a number'));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Could not parse');
        expect(result.useOriginal).toBe(true);
      }
    });

    it('should fail for objects', async () => {
      const result = await stringToNumberTransformer.transform(createContext({ value: 42 }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Expected string or number');
        expect(result.useOriginal).toBe(true);
      }
    });

    it('should fail for arrays', async () => {
      const result = await stringToNumberTransformer.transform(createContext([42]));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Expected string or number');
      }
    });
  });
});
