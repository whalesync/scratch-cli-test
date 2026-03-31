import { SkipIfDestMatchesOptions } from '@spinner/shared-types';
import { Service } from 'src/remote-service/connectors/service-constants';
import { skipIfDestMatchesTransformer } from '../implementations/skip-if-dest-matches.transformer';
import { createNullLookupTools } from '../lookup-tools';
import { SyncRecord, TransformContext } from '../transformer.types';

function createContext(
  sourceValue: unknown,
  destinationValue?: unknown,
  options?: SkipIfDestMatchesOptions,
): TransformContext {
  const sourceRecord: SyncRecord = { id: 'test', filePath: '/test', fields: { value: sourceValue } };
  return {
    sourceRecord,
    sourceFieldPath: 'value',
    sourceValue,
    sourceTableSpec: null,
    sourceService: Service.AIRTABLE,
    destinationFieldPath: 'value',
    destinationValue,
    destinationTableSpec: null,
    destinationService: Service.WEBFLOW,
    lookupTools: createNullLookupTools(),
    options: options ?? {},
    phase: 'DATA',
  };
}

describe('skipIfDestMatchesTransformer', () => {
  it('should have correct type', () => {
    expect(skipIfDestMatchesTransformer.type).toBe('skip_if_dest_matches');
  });

  describe('default options ($ vs $)', () => {
    it('should skip when both values are equal strings', async () => {
      const result = await skipIfDestMatchesTransformer.transform(createContext('hello', 'hello'));
      expect(result).toEqual({ success: true, skip: true });
    });

    it('should skip when both values are deeply equal objects', async () => {
      const obj = { a: 1, b: [2, 3] };
      const result = await skipIfDestMatchesTransformer.transform(createContext(obj, { a: 1, b: [2, 3] }));
      expect(result).toEqual({ success: true, skip: true });
    });

    it('should pass through when values differ', async () => {
      const result = await skipIfDestMatchesTransformer.transform(createContext('hello', 'world'));
      expect(result).toEqual({ success: true, value: 'hello' });
    });

    it('should skip when both are null', async () => {
      const result = await skipIfDestMatchesTransformer.transform(createContext(null, null));
      expect(result).toEqual({ success: true, skip: true });
    });

    it('should skip when both are undefined', async () => {
      const result = await skipIfDestMatchesTransformer.transform(createContext(undefined, undefined));
      expect(result).toEqual({ success: true, skip: true });
    });

    it('should pass through when source has value but dest is null', async () => {
      const result = await skipIfDestMatchesTransformer.transform(createContext('hello', null));
      expect(result).toEqual({ success: true, value: 'hello' });
    });

    it('should pass through when source is null but dest has value', async () => {
      const result = await skipIfDestMatchesTransformer.transform(createContext(null, 'world'));
      expect(result).toEqual({ success: true, value: null });
    });
  });

  describe('with destinationExpression', () => {
    it('should skip when source matches extracted dest subfield', async () => {
      const dest = { url: 'https://youtube.com/watch?v=abc', metadata: { title: 'Test' } };
      const opts: SkipIfDestMatchesOptions = { destinationExpression: '$.url' };
      const result = await skipIfDestMatchesTransformer.transform(
        createContext('https://youtube.com/watch?v=abc', dest, opts),
      );
      expect(result).toEqual({ success: true, skip: true });
    });

    it('should pass through when source differs from extracted dest subfield', async () => {
      const dest = { url: 'https://youtube.com/watch?v=old', metadata: { title: 'Old' } };
      const opts: SkipIfDestMatchesOptions = { destinationExpression: '$.url' };
      const result = await skipIfDestMatchesTransformer.transform(
        createContext('https://youtube.com/watch?v=new', dest, opts),
      );
      expect(result).toEqual({ success: true, value: 'https://youtube.com/watch?v=new' });
    });

    it('should skip when extracted nested fields match', async () => {
      const dest = { data: { nested: { value: 42 } } };
      const opts: SkipIfDestMatchesOptions = { destinationExpression: '$.data.nested.value' };
      const result = await skipIfDestMatchesTransformer.transform(createContext(42, dest, opts));
      expect(result).toEqual({ success: true, skip: true });
    });
  });

  describe('with sourceExpression', () => {
    it('should skip when extracted source subfield matches dest', async () => {
      const source = { url: 'https://example.com', extra: 'data' };
      const opts: SkipIfDestMatchesOptions = { sourceExpression: '$.url' };
      const result = await skipIfDestMatchesTransformer.transform(createContext(source, 'https://example.com', opts));
      expect(result).toEqual({ success: true, skip: true });
    });
  });

  describe('with both expressions', () => {
    it('should skip when both extracted subfields match', async () => {
      const source = { data: { id: 'abc' } };
      const dest = { record: { ref: 'abc' } };
      const opts: SkipIfDestMatchesOptions = { sourceExpression: '$.data.id', destinationExpression: '$.record.ref' };
      const result = await skipIfDestMatchesTransformer.transform(createContext(source, dest, opts));
      expect(result).toEqual({ success: true, skip: true });
    });

    it('should pass through when both extracted subfields differ', async () => {
      const source = { data: { id: 'abc' } };
      const dest = { record: { ref: 'xyz' } };
      const opts: SkipIfDestMatchesOptions = { sourceExpression: '$.data.id', destinationExpression: '$.record.ref' };
      const result = await skipIfDestMatchesTransformer.transform(createContext(source, dest, opts));
      expect(result).toEqual({ success: true, value: source });
    });
  });

  describe('error handling', () => {
    it('should pass through when JSONPath fails on non-object source', async () => {
      const opts: SkipIfDestMatchesOptions = { sourceExpression: '$.foo.bar' };
      const result = await skipIfDestMatchesTransformer.transform(createContext('simple string', 'other', opts));
      // JSONPath on a string with $.foo.bar returns empty array, so no match
      expect(result).toEqual({ success: true, value: 'simple string' });
    });
  });
});
