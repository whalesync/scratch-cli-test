import { Value } from '@sinclair/typebox/value';
import { inferJsonSchema, type InferredJsonSchema } from '../generic-api-schema-inference';
import { inferredFieldToTypeBox, inferredSchemaToTableSchema } from '../generic-api-schema-to-typebox';

/**
 * The generic connector has no schema endpoint — it infers the schema from the
 * runtime shape of probed records (`inferJsonSchema`) and then re-hydrates that
 * plain JSON Schema into TypeBox here so the frontends render columns. This is
 * the failure-prone surface (every API shape flows through it), so it's tested
 * exhaustively: every JSON value kind, unions, nesting, required/optional, the
 * empty/malformed fallbacks, and full record→infer→convert→validate round-trips.
 */

// Convenience: read the JSON-Schema-ish view of a TypeBox schema (TypeBox
// schemas ARE plain objects; symbol metadata doesn't affect these reads).
type JsonSchemaView = {
  type?: string;
  format?: string;
  properties?: Record<string, JsonSchemaView>;
  required?: string[];
  items?: JsonSchemaView;
  anyOf?: JsonSchemaView[];
  additionalProperties?: boolean;
};
const view = (schema: unknown): JsonSchemaView => schema as JsonSchemaView;

describe('inferredFieldToTypeBox — primitive value kinds', () => {
  it('maps string → { type: "string" }', () => {
    expect(view(inferredFieldToTypeBox({ type: 'string' })).type).toBe('string');
  });

  it('drops the inferred format hint so a guessed format never rejects a valid record', () => {
    const s = view(inferredFieldToTypeBox({ type: 'string', format: 'date-time' }));
    expect(s.type).toBe('string');
    expect(s.format).toBeUndefined();
    // a date-time-shaped string and any other string both validate
    expect(Value.Check(inferredFieldToTypeBox({ type: 'string', format: 'date-time' }), '2026-01-01T00:00:00Z')).toBe(
      true,
    );
    expect(Value.Check(inferredFieldToTypeBox({ type: 'string', format: 'email' }), 'not-an-email')).toBe(true);
  });

  it('maps number, integer, boolean, null to their TypeBox kinds', () => {
    expect(view(inferredFieldToTypeBox({ type: 'number' })).type).toBe('number');
    expect(view(inferredFieldToTypeBox({ type: 'integer' })).type).toBe('integer');
    expect(view(inferredFieldToTypeBox({ type: 'boolean' })).type).toBe('boolean');
    expect(view(inferredFieldToTypeBox({ type: 'null' })).type).toBe('null');
  });
});

describe('inferredFieldToTypeBox — arrays', () => {
  it('maps an array with item type', () => {
    const a = view(inferredFieldToTypeBox({ type: 'array', items: { type: 'string' } }));
    expect(a.type).toBe('array');
    expect(a.items?.type).toBe('string');
  });

  it('maps an itemless array to an array of unknown (does not crash)', () => {
    const a = view(inferredFieldToTypeBox({ type: 'array' }));
    expect(a.type).toBe('array');
    // Type.Unknown() produces an empty schema {} — items is present but untyped.
    expect(a.items).toBeDefined();
  });

  it('recurses into arrays of objects', () => {
    const a = view(
      inferredFieldToTypeBox({ type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } }),
    );
    expect(a.items?.type).toBe('object');
    expect(a.items?.properties?.id?.type).toBe('string');
  });
});

describe('inferredFieldToTypeBox — nested objects', () => {
  it('recurses into nested object properties', () => {
    const o = view(
      inferredFieldToTypeBox({
        type: 'object',
        properties: { city: { type: 'string' }, zip: { type: 'integer' } },
      }),
    );
    expect(o.type).toBe('object');
    expect(o.properties?.city?.type).toBe('string');
    expect(o.properties?.zip?.type).toBe('integer');
  });
});

describe('inferredFieldToTypeBox — unions (anyOf)', () => {
  it('maps a string|null union to a Union that accepts both', () => {
    const u = inferredFieldToTypeBox({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    expect(view(u).anyOf).toBeDefined();
    expect(Value.Check(u, 'hello')).toBe(true);
    expect(Value.Check(u, null)).toBe(true);
    expect(Value.Check(u, 42)).toBe(false);
  });
});

describe('inferredSchemaToTableSchema — the fix: populate properties', () => {
  it('populates top-level properties from the inferred schema (was empty before the fix)', () => {
    const inferred: InferredJsonSchema = {
      type: 'object',
      properties: { id: { type: 'string' }, archived: { type: 'boolean' } },
      required: ['id', 'archived'],
    };
    const out = view(inferredSchemaToTableSchema(inferred, 'rec'));
    expect(out.type).toBe('object');
    expect(Object.keys(out.properties ?? {})).toEqual(['id', 'archived']);
    expect(out.properties?.id?.type).toBe('string');
    expect(out.properties?.archived?.type).toBe('boolean');
  });

  it('marks fields not seen on every record as optional, keeps required fields required', () => {
    const inferred: InferredJsonSchema = {
      type: 'object',
      properties: { id: { type: 'string' }, nickname: { type: 'string' } },
      required: ['id'], // nickname seen on some records only
    };
    const out = view(inferredSchemaToTableSchema(inferred, 'rec'));
    expect(out.required).toEqual(['id']);
    // both still appear as columns
    expect(Object.keys(out.properties ?? {})).toEqual(['id', 'nickname']);
  });

  it('returns an empty object schema for an empty inferred schema (table probed while empty)', () => {
    const out = view(inferredSchemaToTableSchema({ type: 'object', properties: {} }, 'rec'));
    expect(out.type).toBe('object');
    expect(Object.keys(out.properties ?? {})).toEqual([]);
  });

  it('falls back to an empty object for a malformed persisted blob (never throws at read time)', () => {
    expect(() => inferredSchemaToTableSchema({ garbage: true } as object, 'rec')).not.toThrow();
    const out = view(inferredSchemaToTableSchema({ garbage: true } as object, 'rec'));
    expect(out.type).toBe('object');
    expect(Object.keys(out.properties ?? {})).toEqual([]);
  });

  it('carries description and additionalProperties through', () => {
    const out = view(
      inferredSchemaToTableSchema({ type: 'object', properties: {}, additionalProperties: true }, 'desc-here'),
    );
    expect((out as { description?: string }).description).toBe('desc-here');
    expect(out.additionalProperties).toBe(true);
  });
});

describe('inferredSchemaToTableSchema — validates real records (end to end)', () => {
  it('a CompanyCam-Project-like record validates against the converted schema', () => {
    const inferred: InferredJsonSchema = {
      type: 'object',
      properties: {
        id: { type: 'string' },
        photo_count: { type: 'integer' },
        public: { type: 'boolean' },
        notepad: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        address: { type: 'object', properties: { city: { type: 'string' }, postal_code: { type: 'string' } } },
        coordinates: { type: 'object', properties: { lat: { type: 'number' }, lon: { type: 'number' } } },
        feature_image: { type: 'array' },
        created_at: { type: 'integer' },
      },
      required: ['id', 'photo_count', 'public', 'address', 'coordinates', 'created_at'],
    };
    const schema = inferredSchemaToTableSchema(inferred, 'CompanyCam Project');

    const record = {
      id: '105997447',
      photo_count: 0,
      public: true,
      notepad: null,
      address: { city: 'Boston', postal_code: '02134' },
      coordinates: { lat: 42.36, lon: -71.12 },
      feature_image: [],
      created_at: 1779462645,
    };
    expect(Value.Check(schema, record)).toBe(true);

    // nested object columns are present
    expect(view(schema).properties?.address?.properties?.city?.type).toBe('string');
    // optional field (notepad, not in required) still renders as a column
    expect(Object.keys(view(schema).properties ?? {})).toContain('notepad');
  });
});

describe('round-trip: infer from records → convert → validate the same records', () => {
  it('every record key becomes a column and the records validate', () => {
    const records = [
      { id: 'a1', name: 'Alpha', tags: ['x', 'y'], score: 3, active: true, deleted_at: null },
      { id: 'a2', name: 'Beta', tags: [], score: 7.5, active: false, deleted_at: '2026-01-01T00:00:00Z' },
    ];
    const inferred = inferJsonSchema(records);
    const schema = inferredSchemaToTableSchema(inferred, 'rec');

    const columns = Object.keys(view(schema).properties ?? {}).sort();
    expect(columns).toEqual(['active', 'deleted_at', 'id', 'name', 'score', 'tags']);

    // both original records validate against the inferred+converted schema
    for (const r of records) expect(Value.Check(schema, r)).toBe(true);

    // score was seen as both integer and number → a union that accepts both
    expect(Value.Check(schema, { ...records[0], score: 9 })).toBe(true);
    expect(Value.Check(schema, { ...records[0], score: 9.9 })).toBe(true);
    // deleted_at was seen as null + date-time string → accepts both, rejects a number
    expect(Value.Check(schema, { ...records[0], deleted_at: 12345 })).toBe(false);
  });
});
