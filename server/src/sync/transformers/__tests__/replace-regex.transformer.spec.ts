import { ReplaceRegexOptions } from '@spinner/shared-types';
import { Service } from 'src/remote-service/connectors/service-constants';
import { replaceRegexTransformer } from '../implementations/replace-regex.transformer';
import { createNullLookupTools } from '../lookup-tools';
import { SyncRecord, TransformContext } from '../transformer.types';

function createContext(sourceValue: unknown, options?: ReplaceRegexOptions): TransformContext {
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

describe('replaceRegexTransformer', () => {
  it('should have correct type', () => {
    expect(replaceRegexTransformer.type).toBe('replace_regex');
  });

  it('should return null for null input', async () => {
    const result = await replaceRegexTransformer.transform(createContext(null, { pattern: 'x' }));
    expect(result).toEqual({ success: true, value: null });
  });

  it('should return null for undefined input', async () => {
    const result = await replaceRegexTransformer.transform(createContext(undefined, { pattern: 'x' }));
    expect(result).toEqual({ success: true, value: null });
  });

  it('should pass through non-string values', async () => {
    const result = await replaceRegexTransformer.transform(createContext(42, { pattern: 'x' }));
    expect(result).toEqual({ success: true, value: 42 });
  });

  it('should fail when pattern is missing', async () => {
    const result = await replaceRegexTransformer.transform(createContext('hello'));
    expect(result).toEqual({ success: false, error: 'replace_regex requires a "pattern" option' });
  });

  it('should replace simple pattern', async () => {
    const result = await replaceRegexTransformer.transform(
      createContext('hello world', { pattern: 'world', replacement: 'there' }),
    );
    expect(result).toEqual({ success: true, value: 'hello there' });
  });

  it('should replace all occurrences (global)', async () => {
    const result = await replaceRegexTransformer.transform(
      createContext('aaa bbb aaa', { pattern: 'aaa', replacement: 'ccc' }),
    );
    expect(result).toEqual({ success: true, value: 'ccc bbb ccc' });
  });

  it('should support capture groups', async () => {
    const result = await replaceRegexTransformer.transform(
      createContext('2024-01-15', { pattern: '(\\d{4})-(\\d{2})-(\\d{2})', replacement: '$2/$3/$1' }),
    );
    expect(result).toEqual({ success: true, value: '01/15/2024' });
  });

  it('should normalize youtu.be URLs', async () => {
    const result = await replaceRegexTransformer.transform(
      createContext('https://youtu.be/CVyknwC62oo?si=hky50-L5ANW--qXg', {
        pattern: 'https?://youtu\\.be/',
        replacement: 'https://youtube.com/watch?v=',
      }),
    );
    expect(result).toEqual({ success: true, value: 'https://youtube.com/watch?v=CVyknwC62oo?si=hky50-L5ANW--qXg' });
  });

  it('should default to empty replacement (deletion)', async () => {
    const result = await replaceRegexTransformer.transform(createContext('hello123world', { pattern: '\\d+' }));
    expect(result).toEqual({ success: true, value: 'helloworld' });
  });

  it('should return string unchanged when no match', async () => {
    const result = await replaceRegexTransformer.transform(
      createContext('hello', { pattern: 'xyz', replacement: 'abc' }),
    );
    expect(result).toEqual({ success: true, value: 'hello' });
  });

  it('should fail on invalid regex', async () => {
    const result = await replaceRegexTransformer.transform(createContext('hello', { pattern: '[invalid' }));
    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain('Invalid regex pattern');
  });
});
