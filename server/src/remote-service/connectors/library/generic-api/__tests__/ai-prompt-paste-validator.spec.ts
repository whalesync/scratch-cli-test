import { extractJsonBlock, validatePastedConfig } from '@spinner/shared-types';

describe('extractJsonBlock', () => {
  it('returns null for empty / whitespace input', () => {
    expect(extractJsonBlock('')).toBeNull();
    expect(extractJsonBlock('   \n  ')).toBeNull();
  });

  it('returns null when there is no opening brace', () => {
    expect(extractJsonBlock('Just some prose, no JSON here.')).toBeNull();
  });

  it('extracts plain JSON (no wrapper)', () => {
    expect(extractJsonBlock('{"a":1}')).toBe('{"a":1}');
  });

  it('strips ```json markdown fences', () => {
    const input = 'Here\'s the config:\n```json\n{"a":1}\n```\nHope this helps.';
    expect(extractJsonBlock(input)).toBe('{"a":1}');
  });

  it('strips plain ``` fences without language tag', () => {
    expect(extractJsonBlock('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('extracts the first {...} from prose-wrapped JSON', () => {
    const input = 'Sure! Here\'s what you want: {"a":1, "b": [1,2,3]} -- let me know if you need anything else.';
    expect(extractJsonBlock(input)).toBe('{"a":1, "b": [1,2,3]}');
  });

  it('handles nested braces correctly', () => {
    expect(extractJsonBlock('{"a": {"b": {"c": 1}}}')).toBe('{"a": {"b": {"c": 1}}}');
  });

  it('ignores braces inside string literals', () => {
    expect(extractJsonBlock('{"x": "a }b{ c"}')).toBe('{"x": "a }b{ c"}');
  });
});

describe('validatePastedConfig — REST happy path', () => {
  it('accepts a minimal valid REST config and normalizes apiType + ids', () => {
    const result = validatePastedConfig(
      JSON.stringify({
        authHeader: 'Bearer',
        endpoints: [{ name: 'Projects', method: 'GET', url: 'https://api.example.com/v1/projects' }],
      }),
      'rest',
    );
    if (!result.ok) throw new Error('expected ok, got: ' + result.error.message);
    expect(result.extras.apiType).toBe('rest');
    expect(result.extras.authHeader).toEqual({ style: 'bearer' });
    expect(result.extras.endpoints).toHaveLength(1);
    expect(result.extras.endpoints[0].id).toMatch(/^ep_/); // stamped with a stable id
  });

  it('accepts X-API-Key auth and maps to custom-header style', () => {
    const result = validatePastedConfig(
      JSON.stringify({
        authHeader: 'X-API-Key',
        endpoints: [{ method: 'GET', url: 'https://api.example.com/x' }],
      }),
      'rest',
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.extras.authHeader).toEqual({ style: 'custom-header', headerName: 'X-API-Key' });
  });

  it('accepts JSON wrapped in markdown fences', () => {
    const result = validatePastedConfig(
      '```json\n{"authHeader":"Bearer","endpoints":[{"method":"GET","url":"https://x.com/y"}]}\n```',
      'rest',
    );
    expect(result.ok).toBe(true);
  });

  it('accepts JSON wrapped in prose', () => {
    const result = validatePastedConfig(
      'Sure, here you go: {"authHeader":"Bearer","endpoints":[{"method":"GET","url":"https://x.com/y"}]} -- enjoy!',
      'rest',
    );
    expect(result.ok).toBe(true);
  });
});

describe('validatePastedConfig — asset mapping', () => {
  it('accepts an endpoint with a full asset block', () => {
    const result = validatePastedConfig(
      JSON.stringify({
        authHeader: 'Bearer',
        endpoints: [
          {
            name: 'Documents',
            method: 'GET',
            url: 'https://api.example.com/v1/documents',
            asset: {
              urlPath: 'url',
              filenamePath: 'name',
              mimeTypePath: 'content_type',
              sizePath: 'size',
              urlExpires: true,
            },
          },
        ],
      }),
      'rest',
    );
    if (!result.ok) throw new Error('expected ok, got: ' + result.error.message);
    expect(result.extras.endpoints[0].asset).toEqual({
      urlPath: 'url',
      filenamePath: 'name',
      mimeTypePath: 'content_type',
      sizePath: 'size',
      urlExpires: true,
    });
  });

  it('accepts an asset block with only the required urlPath', () => {
    const result = validatePastedConfig(
      JSON.stringify({
        authHeader: 'Bearer',
        endpoints: [{ method: 'GET', url: 'https://api.example.com/v1/documents', asset: { urlPath: 'download_url' } }],
      }),
      'rest',
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an asset block missing urlPath', () => {
    const result = validatePastedConfig(
      JSON.stringify({
        authHeader: 'Bearer',
        endpoints: [{ method: 'GET', url: 'https://api.example.com/v1/documents', asset: { filenamePath: 'name' } }],
      }),
      'rest',
    );
    if (result.ok) throw new Error('expected failure');
    expect(result.error.message).toContain('asset.urlPath');
  });

  it('rejects a non-boolean asset.urlExpires', () => {
    const result = validatePastedConfig(
      JSON.stringify({
        authHeader: 'Bearer',
        endpoints: [
          { method: 'GET', url: 'https://api.example.com/v1/documents', asset: { urlPath: 'url', urlExpires: 'yes' } },
        ],
      }),
      'rest',
    );
    if (result.ok) throw new Error('expected failure');
    expect(result.error.message).toContain('asset.urlExpires');
  });
});

describe('validatePastedConfig — GraphQL happy path', () => {
  it('requires `query` field on each endpoint and not `method`', () => {
    const result = validatePastedConfig(
      JSON.stringify({
        authHeader: 'Bearer',
        endpoints: [{ name: 'Issues', url: 'https://api.linear.app/graphql', query: '{ issues { nodes { id } } }' }],
      }),
      'graphql',
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.extras.apiType).toBe('graphql');
  });
});

describe('validatePastedConfig — failure cases all build fix-it messages', () => {
  it('extract failure: no JSON in the text', () => {
    const result = validatePastedConfig('Just plain prose.', 'rest');
    if (result.ok) throw new Error('expected failure');
    expect(result.error.stage).toBe('extract');
    expect(result.error.fixItMessage).toContain('Scratch');
    expect(result.error.fixItMessage).toContain('Bearer'); // mentions the expected shape
  });

  it('parse failure: malformed JSON', () => {
    const result = validatePastedConfig('{ this is not json', 'rest');
    if (result.ok) throw new Error('expected failure');
    expect(result.error.stage).toBe('parse');
    expect(result.error.fixItMessage).toContain('failed to parse');
  });

  it('shape failure: missing authHeader', () => {
    const result = validatePastedConfig(JSON.stringify({ endpoints: [] }), 'rest');
    if (result.ok) throw new Error('expected failure');
    expect(result.error.stage).toBe('shape');
    expect(result.error.message).toContain('authHeader');
  });

  it('shape failure: empty endpoints array', () => {
    const result = validatePastedConfig(JSON.stringify({ authHeader: 'Bearer', endpoints: [] }), 'rest');
    if (result.ok) throw new Error('expected failure');
    expect(result.error.message).toContain('empty');
  });

  it('shape failure: REST endpoint missing method', () => {
    const result = validatePastedConfig(
      JSON.stringify({ authHeader: 'Bearer', endpoints: [{ url: 'https://x.com/y' }] }),
      'rest',
    );
    if (result.ok) throw new Error('expected failure');
    expect(result.error.message).toContain('method');
  });

  it('shape failure: invalid URL', () => {
    const result = validatePastedConfig(
      JSON.stringify({ authHeader: 'Bearer', endpoints: [{ method: 'GET', url: 'not a url' }] }),
      'rest',
    );
    if (result.ok) throw new Error('expected failure');
    expect(result.error.message).toContain('not a valid URL');
  });

  it('shape failure: GraphQL endpoint missing query', () => {
    const result = validatePastedConfig(
      JSON.stringify({ authHeader: 'Bearer', endpoints: [{ url: 'https://api.example.com/graphql' }] }),
      'graphql',
    );
    if (result.ok) throw new Error('expected failure');
    expect(result.error.message).toContain('query');
  });
});
