import type { TableViewCol } from '@spinner/shared-types';
import { describe, expect, it } from 'vitest';
import { resolveDisplayString } from '../resolve-display';

/** A Notion rich-text column: drilled to the span array + the flatten transformer. */
const richTextCol: Pick<TableViewCol, 'displayTransformer'> = {
  displayTransformer: { type: 'jsonpath', options: { expression: '$[*].plain_text', arrayHandling: 'concat' } },
};

const spanArray = [
  { type: 'text', plain_text: 'Ben ', href: null },
  { type: 'text', plain_text: 'Tossell', href: null },
];

describe('resolveDisplayString', () => {
  it('flattens a rich-text span array via the column transformer', () => {
    expect(resolveDisplayString(spanArray, richTextCol)).toBe('Ben Tossell');
  });

  it('falls back to the generic stringifier when the column has no transformer', () => {
    expect(resolveDisplayString(spanArray, {})).toBe(JSON.stringify(spanArray));
    expect(resolveDisplayString(spanArray, undefined)).toBe(JSON.stringify(spanArray));
  });

  it('falls back to raw JSON when the transformer fails closed (malformed span)', () => {
    const malformed = [{ plain_text: null }];
    // applyDisplayTransformer returns {ok:false} -> raw JSON, never "null"
    expect(resolveDisplayString(malformed, richTextCol)).toBe(JSON.stringify(malformed));
  });

  it('falls back to raw JSON when a span is missing plain_text (no silent drop)', () => {
    const partial = [{ plain_text: 'kept' }, { type: 'mention' }];
    expect(resolveDisplayString(partial, richTextCol)).toBe(JSON.stringify(partial));
  });

  it('renders an empty rich-text array as blank', () => {
    expect(resolveDisplayString([], richTextCol)).toBe('');
  });

  it('passes scalar values straight through the fallback stringifier', () => {
    expect(resolveDisplayString('hello', {})).toBe('hello');
    expect(resolveDisplayString(42, {})).toBe('42');
    expect(resolveDisplayString(null, richTextCol)).toBe(''); // null -> {ok:false} -> formatCellForGrid(null) = ''
  });

  it('does not mutate the input value', () => {
    const input = [{ plain_text: 'x' }];
    const snapshot = JSON.stringify(input);
    resolveDisplayString(input, richTextCol);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

// An Attio value column: drilled to the verbatim value array + a `$[0].value`
// (or type-specific key) transformer that flattens the array to its scalar.
describe('resolveDisplayString — Attio value arrays (arrayHandling: first)', () => {
  const valueCol: Pick<TableViewCol, 'displayTransformer'> = {
    displayTransformer: { type: 'jsonpath', options: { expression: '$[0].value', arrayHandling: 'first' } },
  };
  const statusCol: Pick<TableViewCol, 'displayTransformer'> = {
    displayTransformer: { type: 'jsonpath', options: { expression: '$[0].status.title', arrayHandling: 'first' } },
  };

  it('flattens a text value array to its string', () => {
    expect(resolveDisplayString([{ attribute_type: 'text', value: 'Acme Corp' }], valueCol)).toBe('Acme Corp');
  });

  it('renders a number value as its decimal string', () => {
    expect(resolveDisplayString([{ attribute_type: 'currency', value: 42 }], valueCol)).toBe('42');
    // Zero must display, not blank.
    expect(resolveDisplayString([{ attribute_type: 'number', value: 0 }], valueCol)).toBe('0');
  });

  it('renders a boolean checkbox value as true/false', () => {
    expect(resolveDisplayString([{ attribute_type: 'checkbox', value: true }], valueCol)).toBe('true');
    expect(resolveDisplayString([{ attribute_type: 'checkbox', value: false }], valueCol)).toBe('false');
  });

  it('extracts a nested status title', () => {
    expect(resolveDisplayString([{ attribute_type: 'status', status: { title: 'Open' } }], statusCol)).toBe('Open');
  });

  it('renders an unset field (empty value array) as blank', () => {
    expect(resolveDisplayString([], valueCol)).toBe('');
  });

  it('falls back to raw JSON when the expected key is missing on a non-empty array', () => {
    const missing = [{ attribute_type: 'text' }];
    expect(resolveDisplayString(missing, valueCol)).toBe(JSON.stringify(missing));
  });
});
