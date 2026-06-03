import * as sharedTypesBarrel from '@spinner/shared-types';
import { applyDisplayTransformer, applyJsonPath, type DisplayTransformerConfig } from '@spinner/shared-types/transform';

/**
 * Unit tests for the shared, client-safe transform core in
 * `@spinner/shared-types/transform`. Run here because shared-types has no test
 * runner of its own and the server already imports the subpath. The server's
 * own jsonpath transformer behavior is separately pinned by
 * jsonpath.transformer.spec.ts (the parity/regression gate for the delegation).
 */

describe('applyJsonPath (pure shared core)', () => {
  it('concatenates wildcard matches', () => {
    expect(applyJsonPath(['a', 'b', 'c'], '$[*]', 'concat')).toEqual({ ok: true, value: 'abc' });
  });

  it('returns the first match by default', () => {
    expect(applyJsonPath({ items: ['x', 'y'] }, '$.items[*]')).toEqual({ ok: true, value: 'x' });
  });

  it('returns the full array with arrayHandling=array', () => {
    expect(applyJsonPath(['a', 'b'], '$[*]', 'array')).toEqual({ ok: true, value: ['a', 'b'] });
  });

  it('auto-prepends $. to a bare expression', () => {
    expect(applyJsonPath({ a: { b: 42 } }, 'a.b')).toEqual({ ok: true, value: 42 });
  });

  it('fails on objects that cannot be joined', () => {
    const result = applyJsonPath([{ id: 1 }], '$[*]', 'concat');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('cannot be joined');
  });

  it('fails on an invalid expression', () => {
    const result = applyJsonPath({ name: 'a' }, '$[invalid');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('Invalid JSONPath expression');
  });
});

describe('applyDisplayTransformer (fail-closed display)', () => {
  const richText: DisplayTransformerConfig = {
    type: 'jsonpath',
    options: { expression: '$[*].plain_text', arrayHandling: 'concat' },
  };

  it('flattens a clean Notion rich-text span array to plain_text', () => {
    const spans = [
      { type: 'text', plain_text: 'Ben ', href: null },
      { type: 'text', plain_text: 'Tossell', href: null },
    ];
    expect(applyDisplayTransformer(richText, spans)).toEqual({ ok: true, value: 'Ben Tossell' });
  });

  it('returns an empty string for an empty array', () => {
    expect(applyDisplayTransformer(richText, [])).toEqual({ ok: true, value: '' });
  });

  it('FAILS CLOSED when a span has plain_text:null (never renders "null")', () => {
    expect(applyDisplayTransformer(richText, [{ plain_text: null }])).toEqual({ ok: false });
  });

  it('FAILS CLOSED when a span is missing plain_text (never silently drops text)', () => {
    expect(applyDisplayTransformer(richText, [{ plain_text: 'kept' }, { type: 'mention' }])).toEqual({ ok: false });
  });

  it('FAILS CLOSED on a non-array value', () => {
    expect(applyDisplayTransformer(richText, { plain_text: 'x' })).toEqual({ ok: false });
  });

  it('FAILS CLOSED on null / undefined', () => {
    expect(applyDisplayTransformer(richText, null)).toEqual({ ok: false });
    expect(applyDisplayTransformer(richText, undefined)).toEqual({ ok: false });
  });

  it('supports arrayHandling=first, requiring a string match', () => {
    const first: DisplayTransformerConfig = {
      type: 'jsonpath',
      options: { expression: '$[*].plain_text', arrayHandling: 'first' },
    };
    expect(applyDisplayTransformer(first, [{ plain_text: 'one' }, { plain_text: 'two' }])).toEqual({
      ok: true,
      value: 'one',
    });
    expect(applyDisplayTransformer(first, [{ plain_text: 5 }])).toEqual({ ok: false });
  });

  it('FAILS CLOSED on an unsupported transformer type', () => {
    // Simulate a malformed/oversupplied config arriving on a view.
    const bad = { type: 'lookup_field', options: {} } as unknown as DisplayTransformerConfig;
    expect(applyDisplayTransformer(bad, [{ plain_text: 'x' }])).toEqual({ ok: false });
  });
});

describe('shared-types barrel isolation (keeps jsonpath out of barrel consumers)', () => {
  // The transform runtime (and its jsonpath-rfc9535 dependency) must stay behind
  // the `@spinner/shared-types/transform` subpath, never re-exported from the
  // barrel — otherwise barrel-only consumers like the Next.js client would bundle
  // jsonpath. If someone adds `export * from './transform'` to index.ts, these
  // names appear on the barrel and this guard fails.
  it('does not expose the transform runtime from the package barrel', () => {
    const barrel = sharedTypesBarrel as Record<string, unknown>;
    expect(barrel.applyJsonPath).toBeUndefined();
    expect(barrel.applyDisplayTransformer).toBeUndefined();
  });
});
