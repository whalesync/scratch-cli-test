import { slugifyTransformer } from '../implementations/slugify.transformer';
import { SyncRecord, TransformContext } from '../transformer.types';

function createContext(sourceValue: unknown, phase: 'DATA' | 'FK' = 'DATA'): TransformContext {
  const sourceRecord: SyncRecord = { id: 'test', fields: { value: sourceValue } };
  return {
    sourceRecord,
    sourceFieldPath: 'value',
    sourceValue,
    lookupTools: {
      getDestinationMappingForSourceFk: jest.fn(),
      lookupFieldFromFkRecord: jest.fn(),
    },
    options: {},
    phase,
  };
}

describe('slugifyTransformer', () => {
  it('should have correct type', () => {
    expect(slugifyTransformer.type).toBe('slugify');
  });

  describe('null/undefined handling', () => {
    it('should return null for null input', async () => {
      const result = await slugifyTransformer.transform(createContext(null));
      expect(result).toEqual({ success: true, value: null });
    });

    it('should return null for undefined input', async () => {
      const result = await slugifyTransformer.transform(createContext(undefined));
      expect(result).toEqual({ success: true, value: null });
    });
  });

  describe('basic slugification', () => {
    it('should lowercase and hyphenate a simple string', async () => {
      const result = await slugifyTransformer.transform(createContext('Hello World'));
      expect(result).toEqual({ success: true, value: 'hello-world' });
    });

    it('should replace underscores with hyphens', async () => {
      const result = await slugifyTransformer.transform(createContext('hello_world'));
      expect(result).toEqual({ success: true, value: 'hello-world' });
    });

    it('should return empty string for empty input', async () => {
      const result = await slugifyTransformer.transform(createContext(''));
      expect(result).toEqual({ success: true, value: '' });
    });

    it('should return empty string for whitespace-only input', async () => {
      const result = await slugifyTransformer.transform(createContext('   '));
      expect(result).toEqual({ success: true, value: '' });
    });
  });

  describe('diacritics/accents', () => {
    it('should strip accented characters', async () => {
      const result = await slugifyTransformer.transform(createContext('café résumé'));
      expect(result).toEqual({ success: true, value: 'cafe-resume' });
    });

    it('should handle ñ and other diacritics', async () => {
      const result = await slugifyTransformer.transform(createContext('Año Nuevo'));
      expect(result).toEqual({ success: true, value: 'ano-nuevo' });
    });
  });

  describe('special characters', () => {
    it('should remove special characters', async () => {
      const result = await slugifyTransformer.transform(createContext('Hello, World! @#$%'));
      expect(result).toEqual({ success: true, value: 'hello-world' });
    });

    it('should collapse consecutive hyphens', async () => {
      const result = await slugifyTransformer.transform(createContext('hello---world'));
      expect(result).toEqual({ success: true, value: 'hello-world' });
    });

    it('should trim leading and trailing hyphens', async () => {
      const result = await slugifyTransformer.transform(createContext('--hello-world--'));
      expect(result).toEqual({ success: true, value: 'hello-world' });
    });

    it('should handle mixed special chars creating consecutive hyphens', async () => {
      const result = await slugifyTransformer.transform(createContext('Hello & World'));
      expect(result).toEqual({ success: true, value: 'hello-world' });
    });
  });

  describe('non-string input', () => {
    it('should fail with useOriginal for number input', async () => {
      const result = await slugifyTransformer.transform(createContext(42));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Expected string');
        expect(result.useOriginal).toBe(true);
      }
    });

    it('should fail with useOriginal for object input', async () => {
      const result = await slugifyTransformer.transform(createContext({ foo: 'bar' }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.useOriginal).toBe(true);
      }
    });
  });

  describe('phase handling', () => {
    it('should skip in FK phase', async () => {
      const result = await slugifyTransformer.transform(createContext('Hello World', 'FK'));
      expect(result).toEqual({ success: true, skip: true });
    });
  });
});
