import { inferJsonSchema, SCHEMA_INFERENCE_RECORD_CAP } from '../generic-api-schema-inference';

describe('inferJsonSchema', () => {
  it('returns the empty-properties shape for an empty records array', () => {
    const s = inferJsonSchema([]);
    expect(s.type).toBe('object');
    expect(s.properties).toEqual({});
    expect(s.required).toBeUndefined();
  });

  it('infers primitive types from a single-record sample', () => {
    const s = inferJsonSchema([{ id: 'abc', count: 42, ratio: 3.14, active: true, deleted_at: null }]);
    expect(s.properties.id).toEqual({ type: 'string' });
    expect(s.properties.count).toEqual({ type: 'integer' });
    expect(s.properties.ratio).toEqual({ type: 'number' });
    expect(s.properties.active).toEqual({ type: 'boolean' });
    expect(s.properties.deleted_at).toEqual({ type: 'null' });
  });

  it('unions string | null when one record has null for a field', () => {
    const s = inferJsonSchema([
      { id: 'a', notes: 'hello' },
      { id: 'b', notes: null },
    ]);
    const notes = s.properties.notes;
    expect('anyOf' in notes).toBe(true);
    if ('anyOf' in notes) {
      expect(notes.anyOf).toHaveLength(2);
      expect(notes.anyOf).toContainEqual({ type: 'string' });
      expect(notes.anyOf).toContainEqual({ type: 'null' });
    }
  });

  it('marks `required` only for fields present in EVERY record', () => {
    const s = inferJsonSchema([
      { id: 'a', name: 'A', optional: 'set' },
      { id: 'b', name: 'B' }, // missing `optional`
    ]);
    expect(s.required).toEqual(['id', 'name']);
    expect(s.properties.optional).toEqual({ type: 'string' });
  });

  it('detects date-time format for ISO 8601 strings', () => {
    const s = inferJsonSchema([{ created_at: '2026-05-18T12:34:56Z' }]);
    expect(s.properties.created_at).toEqual({ type: 'string', format: 'date-time' });
  });

  it('detects email format', () => {
    const s = inferJsonSchema([{ email: 'jane@example.com' }]);
    expect(s.properties.email).toEqual({ type: 'string', format: 'email' });
  });

  it('detects uri format for http(s) URLs', () => {
    const s = inferJsonSchema([{ avatar: 'https://example.com/a.png' }]);
    expect(s.properties.avatar).toEqual({ type: 'string', format: 'uri' });
  });

  it('recurses into nested objects', () => {
    const s = inferJsonSchema([{ address: { street: '1 Main', zip: 12345 } }]);
    // ESLint's no-unsafe-member-access doesn't track through the union narrowing,
    // so we cast to a permissive shape that lets the test assertions read clean.
    const addr = s.properties.address as { type: string; properties?: Record<string, unknown> };
    expect(addr.type).toBe('object');
    expect(addr.properties?.street).toEqual({ type: 'string' });
    expect(addr.properties?.zip).toEqual({ type: 'integer' });
  });

  it('unions array item types when an array has mixed primitives', () => {
    const s = inferJsonSchema([{ tags: ['admin', 1, true] }]);
    const tags = s.properties.tags as { type?: string; items?: unknown };
    expect(tags.type).toBe('array');
    if (tags.type === 'array' && tags.items) {
      expect('anyOf' in (tags.items as Record<string, unknown>)).toBe(true);
    }
  });

  it('returns just `type: array` for an empty array (no items inferable)', () => {
    const s = inferJsonSchema([{ tags: [] }]);
    expect(s.properties.tags).toEqual({ type: 'array' });
  });

  it('caps the walk at SCHEMA_INFERENCE_RECORD_CAP records', () => {
    // Construct N+1 records; the last one introduces a new field that
    // should NOT appear in the inferred schema if the cap is respected.
    const records: unknown[] = Array.from({ length: SCHEMA_INFERENCE_RECORD_CAP + 1 }, () => ({ id: 'x' }));
    records[SCHEMA_INFERENCE_RECORD_CAP] = { id: 'x', late_field: 'should be ignored' };
    const s = inferJsonSchema(records);
    expect(s.properties.late_field).toBeUndefined();
  });

  it('skips non-object entries silently', () => {
    const s = inferJsonSchema([{ id: 'a' }, 'not an object', null, { id: 'b' }]);
    expect(s.properties.id).toEqual({ type: 'string' });
    expect(Object.keys(s.properties)).toEqual(['id']);
  });
});
