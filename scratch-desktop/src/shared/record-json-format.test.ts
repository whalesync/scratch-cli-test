import { describe, expect, it } from 'vitest';

import { formatRecordJson } from '@spinner/shared-types/format';

/**
 * Pins the canonical on-disk record-JSON format: 2-space indentation + a single
 * trailing newline. Every Scratch writer must produce these exact bytes so an
 * edit round-trips byte-identical to a fresh pull — the server's git commits and
 * the desktop's local saves both call this function, and the scratchmd Rust CLI
 * (`json_object_to_bytes`) is held to the same string by its own test. See
 * DEV-10308 and docs/cell-edit-save-coercion.md.
 */
describe('formatRecordJson (canonical on-disk record format)', () => {
  it('uses 2-space indentation and a trailing newline for objects', () => {
    expect(formatRecordJson({ a: 1, b: 'two' })).toBe('{\n  "a": 1,\n  "b": "two"\n}\n');
  });

  it('formats nested objects and arrays the same way', () => {
    expect(formatRecordJson({ properties: { Size: { number: 25000 } } })).toBe(
      '{\n  "properties": {\n    "Size": {\n      "number": 25000\n    }\n  }\n}\n',
    );
    expect(formatRecordJson([{ kind: 'x' }])).toBe('[\n  {\n    "kind": "x"\n  }\n]\n');
  });

  it('always ends with exactly one trailing newline', () => {
    expect(formatRecordJson({})).toBe('{}\n');
    expect(formatRecordJson([])).toBe('[]\n');
    expect(formatRecordJson({ a: 1 }).endsWith('}\n')).toBe(true);
    expect(formatRecordJson({}).endsWith('\n\n')).toBe(false);
  });
});
