import { getMatchFieldCompatibility, TransformerTypes } from '@spinner/shared-types';
import { Service } from 'src/remote-service/connectors/service-constants';
import { BaseJsonTableSpec } from 'src/remote-service/connectors/types';
import { deriveCanonicalMatchKey, getFieldUnpackTransformer } from 'src/sync/record-matching';

// The connector-declared extraction transformer Notion attaches to a rich_text
// field: unpack the envelope to its plain text.
const NOTION_RICH_TEXT_UNPACK = {
  type: TransformerTypes.JSONPath,
  options: { expression: '$.rich_text[*].plain_text', arrayHandling: 'concat' as const },
};

const recordWith = (value: unknown) => ({ id: 'r1', filePath: 'r1.json', fields: { id: value, name: 'X' } });

describe('deriveCanonicalMatchKey', () => {
  const base = (value: unknown) => ({
    record: recordWith(value),
    fieldPath: 'id',
    tableSpec: null,
    service: Service.NOTION,
  });

  it('uses a primitive string directly', async () => {
    expect(await deriveCanonicalMatchKey(base('abc'), undefined)).toBe('abc');
  });

  it('coerces a number to a string (so number↔string still match)', async () => {
    expect(await deriveCanonicalMatchKey(base(42), undefined)).toBe('42');
  });

  it('trims surrounding whitespace', async () => {
    expect(await deriveCanonicalMatchKey(base('  abc  '), undefined)).toBe('abc');
  });

  it('returns null for null / undefined / empty / whitespace-only', async () => {
    expect(await deriveCanonicalMatchKey(base(null), undefined)).toBeNull();
    expect(await deriveCanonicalMatchKey(base(undefined), undefined)).toBeNull();
    expect(await deriveCanonicalMatchKey(base(''), undefined)).toBeNull();
    expect(await deriveCanonicalMatchKey(base('   '), undefined)).toBeNull();
  });

  it('returns null for a non-primitive value with no extraction transformer', async () => {
    expect(await deriveCanonicalMatchKey(base({ rich_text: [] }), undefined)).toBeNull();
  });

  it('extracts a primitive from a Notion rich_text envelope via the suggested transformer', async () => {
    const value = {
      type: 'rich_text',
      rich_text: [{ type: 'text', text: { content: '09b70260' }, plain_text: '09b70260' }],
    };
    expect(await deriveCanonicalMatchKey(base(value), NOTION_RICH_TEXT_UNPACK)).toBe('09b70260');
  });

  it('reduces a Notion envelope and a plain string to the SAME key (direction independence)', async () => {
    const notion = { rich_text: [{ type: 'text', text: { content: 'shared-id' }, plain_text: 'shared-id' }] };
    const fromNotion = await deriveCanonicalMatchKey(base(notion), NOTION_RICH_TEXT_UNPACK);
    const fromPlain = await deriveCanonicalMatchKey(base('shared-id'), undefined);
    expect(fromNotion).toBe('shared-id');
    expect(fromNotion).toBe(fromPlain);
  });

  it('returns null when the extraction transformer yields a non-primitive', async () => {
    const value = { rich_text: [{ plain_text: 'a' }, { plain_text: 'b' }] };
    const arrayUnpack = {
      type: TransformerTypes.JSONPath,
      options: { expression: '$.rich_text[*].plain_text', arrayHandling: 'array' as const },
    };
    expect(await deriveCanonicalMatchKey(base(value), arrayUnpack)).toBeNull();
  });

  it('does not apply a transformer when the service is missing', async () => {
    const ctx = { record: recordWith({ rich_text: [] }), fieldPath: 'id', tableSpec: null };
    expect(await deriveCanonicalMatchKey(ctx, NOTION_RICH_TEXT_UNPACK)).toBeNull();
  });

  it('reads a match field whose name literally contains dots (DEV-10959)', async () => {
    // Matching on a Postgres column named `col.with.dots`: the value must be read
    // from that flat key, not a nested `col → with → dots` miss that would yield a
    // null match key and silently mis-pair (or skip) the record.
    const ctx = {
      record: { id: 'r1', filePath: 'r1.json', fields: { 'col.with.dots': 'match-me' } },
      fieldPath: 'col.with.dots',
      tableSpec: null,
      service: Service.NOTION,
    };
    expect(await deriveCanonicalMatchKey(ctx, undefined)).toBe('match-me');
  });
});

describe('getFieldUnpackTransformer', () => {
  it('returns undefined when there is no spec', () => {
    expect(getFieldUnpackTransformer(null, 'id')).toBeUndefined();
  });

  it('reads x-scratch-suggested-transformer for a field, and nothing for a plain field', () => {
    const spec = {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'object', 'x-scratch-suggested-transformer': NOTION_RICH_TEXT_UNPACK },
          name: { type: 'string' },
        },
      },
    } as unknown as BaseJsonTableSpec;
    expect(getFieldUnpackTransformer(spec, 'id')).toEqual(NOTION_RICH_TEXT_UNPACK);
    expect(getFieldUnpackTransformer(spec, 'name')).toBeUndefined();
  });
});

// The shared editor-facing predicate must stay in lockstep with deriveCanonicalMatchKey's
// rule (primitive | has extraction transformer | otherwise unusable). Tested here because
// shared-types has no test runner of its own.
describe('getMatchFieldCompatibility', () => {
  it('allows primitive field types', () => {
    expect(getMatchFieldCompatibility({ type: 'string' })).toEqual({ usable: true });
    expect(getMatchFieldCompatibility({ type: 'number' })).toEqual({ usable: true });
    expect(getMatchFieldCompatibility({ type: 'integer' })).toEqual({ usable: true });
  });

  it('allows a non-primitive field that declares an extraction transformer', () => {
    expect(getMatchFieldCompatibility({ type: 'object', suggestedTransformer: NOTION_RICH_TEXT_UNPACK })).toEqual({
      usable: true,
    });
  });

  it('rejects a non-primitive field with no extraction transformer', () => {
    expect(getMatchFieldCompatibility({ type: 'object' })).toEqual({
      usable: false,
      reason: 'no-extractable-primitive',
    });
    expect(getMatchFieldCompatibility({ type: 'array' })).toEqual({
      usable: false,
      reason: 'no-extractable-primitive',
    });
  });

  it('rejects an undefined field (hints not loaded / field absent)', () => {
    expect(getMatchFieldCompatibility(undefined)).toEqual({ usable: false, reason: 'no-extractable-primitive' });
  });
});
