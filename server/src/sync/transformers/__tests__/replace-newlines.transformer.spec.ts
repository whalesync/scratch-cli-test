import { ReplaceNewlinesOptions } from '@spinner/shared-types';
import { Service } from 'src/remote-service/connectors/service-constants';
import { replaceNewlinesTransformer } from '../implementations/replace-newlines.transformer';
import { createNullLookupTools } from '../lookup-tools';
import { SyncRecord, TransformContext } from '../transformer.types';

function createContext(sourceValue: unknown, options?: ReplaceNewlinesOptions): TransformContext {
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

describe('replaceNewlinesTransformer', () => {
  it('should have correct type', () => {
    expect(replaceNewlinesTransformer.type).toBe('replace_newlines');
  });

  it('should return null for null input', async () => {
    const result = await replaceNewlinesTransformer.transform(createContext(null));
    expect(result).toEqual({ success: true, value: null });
  });

  it('should return null for undefined input', async () => {
    const result = await replaceNewlinesTransformer.transform(createContext(undefined));
    expect(result).toEqual({ success: true, value: null });
  });

  it('should pass through non-string values', async () => {
    const result = await replaceNewlinesTransformer.transform(createContext(42));
    expect(result).toEqual({ success: true, value: 42 });
  });

  it('should strip newlines by default (empty replacement)', async () => {
    const result = await replaceNewlinesTransformer.transform(createContext('hello\nworld'));
    expect(result).toEqual({ success: true, value: 'helloworld' });
  });

  it('should replace \\n with <br>', async () => {
    const result = await replaceNewlinesTransformer.transform(
      createContext('line1\nline2\nline3', { replacement: '<br>' }),
    );
    expect(result).toEqual({ success: true, value: 'line1<br>line2<br>line3' });
  });

  it('should replace \\r\\n (CRLF)', async () => {
    const result = await replaceNewlinesTransformer.transform(createContext('line1\r\nline2', { replacement: '<br>' }));
    expect(result).toEqual({ success: true, value: 'line1<br>line2' });
  });

  it('should replace \\r (CR)', async () => {
    const result = await replaceNewlinesTransformer.transform(createContext('line1\rline2', { replacement: '<br>' }));
    expect(result).toEqual({ success: true, value: 'line1<br>line2' });
  });

  it('should replace Unicode NEL (U+0085)', async () => {
    const result = await replaceNewlinesTransformer.transform(
      createContext('line1\u0085line2', { replacement: '<br>' }),
    );
    expect(result).toEqual({ success: true, value: 'line1<br>line2' });
  });

  it('should replace vertical tab (U+000B)', async () => {
    const result = await replaceNewlinesTransformer.transform(
      createContext('line1\u000Bline2', { replacement: '<br>' }),
    );
    expect(result).toEqual({ success: true, value: 'line1<br>line2' });
  });

  it('should replace form feed (U+000C)', async () => {
    const result = await replaceNewlinesTransformer.transform(
      createContext('line1\u000Cline2', { replacement: '<br>' }),
    );
    expect(result).toEqual({ success: true, value: 'line1<br>line2' });
  });

  it('should replace line separator (U+2028)', async () => {
    const result = await replaceNewlinesTransformer.transform(
      createContext('line1\u2028line2', { replacement: '<br>' }),
    );
    expect(result).toEqual({ success: true, value: 'line1<br>line2' });
  });

  it('should replace paragraph separator (U+2029)', async () => {
    const result = await replaceNewlinesTransformer.transform(
      createContext('line1\u2029line2', { replacement: '<br>' }),
    );
    expect(result).toEqual({ success: true, value: 'line1<br>line2' });
  });

  it('should replace with spaces', async () => {
    const result = await replaceNewlinesTransformer.transform(createContext('hello\nworld', { replacement: ' ' }));
    expect(result).toEqual({ success: true, value: 'hello world' });
  });

  it('should return string unchanged when no newlines present', async () => {
    const result = await replaceNewlinesTransformer.transform(createContext('no newlines here'));
    expect(result).toEqual({ success: true, value: 'no newlines here' });
  });
});
