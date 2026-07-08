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

  it('supports arrayHandling=first: string verbatim, scalar number/boolean stringified', () => {
    const first: DisplayTransformerConfig = {
      type: 'jsonpath',
      options: { expression: '$[*].plain_text', arrayHandling: 'first' },
    };
    // A string first-match is shown verbatim.
    expect(applyDisplayTransformer(first, [{ plain_text: 'one' }, { plain_text: 'two' }])).toEqual({
      ok: true,
      value: 'one',
    });
    // Scalar number / boolean first-matches (e.g. an Attio number, currency,
    // rating, or checkbox value) render as their display string — 0 and false
    // must show, not blank. This is a faithful display, not a dropped/corrupted
    // value, so it does not violate fail-closed (the concat path above still
    // enforces it for the rich-text case).
    expect(applyDisplayTransformer(first, [{ plain_text: 5 }])).toEqual({ ok: true, value: '5' });
    expect(applyDisplayTransformer(first, [{ plain_text: 0 }])).toEqual({ ok: true, value: '0' });
    expect(applyDisplayTransformer(first, [{ plain_text: false }])).toEqual({ ok: true, value: 'false' });
  });

  it('arrayHandling=first blanks an empty array, fails closed on a missing key or object match', () => {
    const firstValue: DisplayTransformerConfig = {
      type: 'jsonpath',
      options: { expression: '$[0].value', arrayHandling: 'first' },
    };
    // An empty value array (an unset Attio field stored as `[]`) renders blank.
    expect(applyDisplayTransformer(firstValue, [])).toEqual({ ok: true, value: '' });
    // A non-empty array whose key is missing fails closed (surfaces the issue).
    expect(applyDisplayTransformer(firstValue, [{ other: 'x' }])).toEqual({ ok: false });
    // An object first-match (not a scalar) fails closed.
    expect(applyDisplayTransformer(firstValue, [{ value: { nested: true } }])).toEqual({ ok: false });
  });

  it('FAILS CLOSED on an unsupported transformer type', () => {
    // Simulate a malformed/oversupplied config arriving on a view.
    const bad = { type: 'lookup_field', options: {} } as unknown as DisplayTransformerConfig;
    expect(applyDisplayTransformer(bad, [{ plain_text: 'x' }])).toEqual({ ok: false });
  });
});

describe('applyDisplayTransformer: computed-field (Airtable aiText / formula-error shapes)', () => {
  // Mirrors the transformer the Airtable connector attaches to aiText /
  // formula-of-text / numeric / lookup columns: aiText `value` and numeric
  // `specialValue` are shown, genuine `error` wrappers blanked.
  const computedField: DisplayTransformerConfig = {
    type: 'computed-field',
    options: { valueKeys: ['value', 'specialValue'], blankOnKeys: ['error'] },
  };

  it('unwraps an aiText object to its generated text', () => {
    expect(applyDisplayTransformer(computedField, { state: 'generated', value: 'Hello there', isStale: true })).toEqual(
      { ok: true, value: 'Hello there' },
    );
  });

  it('blanks an empty aiText object (value:null / state:empty)', () => {
    expect(applyDisplayTransformer(computedField, { state: 'empty', value: null })).toEqual({ ok: true, value: '' });
  });

  it('blanks a formula error wrapper instead of showing raw JSON', () => {
    expect(applyDisplayTransformer(computedField, { error: '#ERROR!' })).toEqual({ ok: true, value: '' });
  });

  it('shows a numeric specialValue (Infinity / NaN) as its string, not blank', () => {
    expect(applyDisplayTransformer(computedField, { specialValue: 'Infinity' })).toEqual({
      ok: true,
      value: 'Infinity',
    });
    expect(applyDisplayTransformer(computedField, { specialValue: 'NaN' })).toEqual({ ok: true, value: 'NaN' });
  });

  it('passes a bare scalar formula result through as its display string', () => {
    expect(applyDisplayTransformer(computedField, 'plain text')).toEqual({ ok: true, value: 'plain text' });
    expect(applyDisplayTransformer(computedField, 42)).toEqual({ ok: true, value: '42' });
    expect(applyDisplayTransformer(computedField, false)).toEqual({ ok: true, value: 'false' });
  });

  it('joins a multipleLookupValues array, dropping blank/error items', () => {
    const lookup = [
      { state: 'generated', value: 'first' },
      { state: 'empty', value: null },
      { error: '#ERROR!' },
      { state: 'generated', value: 'second' },
    ];
    expect(applyDisplayTransformer(computedField, lookup)).toEqual({ ok: true, value: 'first, second' });
  });

  it('joins a lookup array of plain scalars', () => {
    expect(applyDisplayTransformer(computedField, ['a', 'b', 'c'])).toEqual({ ok: true, value: 'a, b, c' });
  });

  it('blanks an empty lookup array', () => {
    expect(applyDisplayTransformer(computedField, [])).toEqual({ ok: true, value: '' });
  });

  it('FAILS CLOSED on a wrapper object missing the valueKey (surfaces the odd shape)', () => {
    // Not an error wrapper and no `value` key — show the raw value rather than lie.
    expect(applyDisplayTransformer(computedField, { state: 'generated' })).toEqual({ ok: false });
  });

  it('FAILS CLOSED when the value key holds a nested object', () => {
    expect(applyDisplayTransformer(computedField, { value: { nested: true } })).toEqual({ ok: false });
  });

  it('FAILS CLOSED on null / undefined (raw fallback shows blank)', () => {
    expect(applyDisplayTransformer(computedField, null)).toEqual({ ok: false });
    expect(applyDisplayTransformer(computedField, undefined)).toEqual({ ok: false });
  });

  it('does NOT throw on a stale config missing valueKeys (fails closed, never crashes the grid)', () => {
    // A view pulled by an earlier server stored the old `{ valueKey }` shape; the
    // updated applier must fail closed on the wrapper, not throw `not iterable`.
    const staleConfig = { type: 'computed-field', options: { valueKey: 'value', blankOnKeys: ['error'] } };
    const cfg = staleConfig as unknown as DisplayTransformerConfig;
    expect(() => applyDisplayTransformer(cfg, { state: 'generated', value: 'hi' })).not.toThrow();
    expect(applyDisplayTransformer(cfg, { state: 'generated', value: 'hi' })).toEqual({ ok: false });
    // Scalars still render even with a malformed config (no object unwrap needed).
    expect(applyDisplayTransformer(cfg, 'plain')).toEqual({ ok: true, value: 'plain' });
  });

  it('does NOT throw when options is entirely absent (fails closed)', () => {
    const brokenConfig = { type: 'computed-field' } as unknown as DisplayTransformerConfig;
    expect(() => applyDisplayTransformer(brokenConfig, { value: 'x' })).not.toThrow();
    expect(applyDisplayTransformer(brokenConfig, { value: 'x' })).toEqual({ ok: false });
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
