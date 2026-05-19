import { TSchema } from '@sinclair/typebox';
import { X_SCRATCH_LAST_MODIFIED_FIELD } from '@spinner/shared-types';
import {
  BaseJsonTableSpec,
  clearRecordId,
  findLastModifiedFieldName,
  idPath,
  readRecordId,
  readRecordIdAsString,
  recordWithId,
  writeRecordId,
} from '../types';

function specWithSchema(schema: unknown): BaseJsonTableSpec {
  return {
    id: { wsId: 't', remoteId: ['t'] },
    slug: 't',
    name: 't',
    idColumnRemoteId: 'id',
    schema: schema as TSchema,
  };
}

describe('IdPath helpers', () => {
  // ── readRecordId ──────────────────────────────────────────────────────────
  describe('readRecordId', () => {
    it('returns the raw value at a top-level path', () => {
      expect(readRecordId({ id: 'rec_1' }, idPath('id'))).toBe('rec_1');
    });

    it('returns the raw object at a top-level path so callers can detect non-primitive ids', () => {
      const triple = { workspace_id: 'w', object_id: 'o', record_id: 'r' };
      expect(readRecordId({ id: triple }, idPath('id'))).toEqual(triple);
    });

    it('traverses dot paths into nested objects', () => {
      const record = { id: { workspace_id: 'w', object_id: 'o', record_id: 'r' } };
      expect(readRecordId(record, idPath('id.record_id'))).toBe('r');
    });

    it('returns undefined when the path is missing', () => {
      expect(readRecordId({ id: 'rec_1' }, idPath('id.record_id'))).toBeUndefined();
      expect(readRecordId({}, idPath('id'))).toBeUndefined();
    });
  });

  // ── readRecordIdAsString ──────────────────────────────────────────────────
  describe('readRecordIdAsString', () => {
    it('returns string ids as-is', () => {
      expect(readRecordIdAsString({ id: 'rec_1' }, idPath('id'))).toBe('rec_1');
    });

    it('coerces finite numeric ids to a string', () => {
      expect(readRecordIdAsString({ id: 42 }, idPath('id'))).toBe('42');
    });

    it('returns the leaf string at a nested dot path', () => {
      const record = { id: { record_id: 'r_1', workspace_id: 'w', object_id: 'o' } };
      expect(readRecordIdAsString(record, idPath('id.record_id'))).toBe('r_1');
    });

    it('returns null when the path resolves to a non-primitive value (e.g. the whole id triple)', () => {
      const record = { id: { record_id: 'r_1' } };
      // Asking for the whole triple — not a string id, callers must drill deeper.
      expect(readRecordIdAsString(record, idPath('id'))).toBeNull();
    });

    it('returns null for null, undefined, and missing values', () => {
      expect(readRecordIdAsString({ id: null as unknown as string }, idPath('id'))).toBeNull();
      expect(readRecordIdAsString({}, idPath('id'))).toBeNull();
      expect(readRecordIdAsString({ id: undefined as unknown as string }, idPath('id'))).toBeNull();
    });

    it('returns null for non-finite numbers', () => {
      expect(readRecordIdAsString({ id: NaN as unknown as number }, idPath('id'))).toBeNull();
      expect(readRecordIdAsString({ id: Infinity as unknown as number }, idPath('id'))).toBeNull();
    });
  });

  // ── writeRecordId ─────────────────────────────────────────────────────────
  describe('writeRecordId', () => {
    it('sets a value at a flat top-level path', () => {
      const record: Record<string, unknown> = {};
      writeRecordId(record, idPath('id'), 'rec_1');
      expect(record).toEqual({ id: 'rec_1' });
    });

    it('sets a value at a nested dot path, creating intermediate objects', () => {
      const record: Record<string, unknown> = {};
      writeRecordId(record, idPath('id.record_id'), 'r_1');
      expect(record).toEqual({ id: { record_id: 'r_1' } });
    });

    it('preserves sibling keys at intermediate objects', () => {
      const record: Record<string, unknown> = {
        id: { workspace_id: 'w', object_id: 'o' },
      };
      writeRecordId(record, idPath('id.record_id'), 'r_1');
      expect(record).toEqual({ id: { workspace_id: 'w', object_id: 'o', record_id: 'r_1' } });
    });
  });

  // ── clearRecordId ─────────────────────────────────────────────────────────
  describe('clearRecordId', () => {
    it('removes a top-level id', () => {
      const record: Record<string, unknown> = { id: 'rec_1', name: 'x' };
      clearRecordId(record, idPath('id'));
      expect(record).toEqual({ name: 'x' });
    });

    it('removes the leaf at a nested dot path without disturbing siblings', () => {
      const record: Record<string, unknown> = {
        id: { workspace_id: 'w', object_id: 'o', record_id: 'r' },
        name: 'x',
      };
      clearRecordId(record, idPath('id.record_id'));
      expect(record).toEqual({ id: { workspace_id: 'w', object_id: 'o' }, name: 'x' });
    });

    it('is a no-op when the path is missing', () => {
      const record: Record<string, unknown> = { name: 'x' };
      expect(() => clearRecordId(record, idPath('id.record_id'))).not.toThrow();
      expect(record).toEqual({ name: 'x' });
    });
  });

  // ── recordWithId ──────────────────────────────────────────────────────────
  describe('recordWithId', () => {
    it('builds a flat stub for a top-level id path', () => {
      expect(recordWithId(idPath('id'), 'rec_1')).toEqual({ id: 'rec_1' });
    });

    it('builds a nested stub for a dot path — the shape used as a connector delete filter', () => {
      expect(recordWithId(idPath('id.record_id'), 'r_1')).toEqual({ id: { record_id: 'r_1' } });
    });

    it('accepts numeric ids', () => {
      expect(recordWithId(idPath('id'), 42)).toEqual({ id: 42 });
    });
  });
});

describe('findLastModifiedFieldName', () => {
  const annotated = { type: 'string', [X_SCRATCH_LAST_MODIFIED_FIELD]: true };
  const plain = { type: 'string' };

  // 1. Airtable-nested: properties.fields.properties.<name> (unchanged behavior)
  describe('Airtable-nested shape', () => {
    it('returns the annotated field under properties.fields.properties', () => {
      const spec = specWithSchema({
        properties: { fields: { properties: { Name: plain, 'Last Modified': annotated } } },
      });
      expect(findLastModifiedFieldName(spec)).toBe('Last Modified');
    });

    it('returns undefined when no nested field is annotated', () => {
      const spec = specWithSchema({ properties: { fields: { properties: { Name: plain } } } });
      expect(findLastModifiedFieldName(spec)).toBeUndefined();
    });
  });

  // 2. Flat top-level: properties.<name> (WordPress / Linear / Shopify)
  describe('flat top-level shape', () => {
    it('returns the annotated top-level field (Linear/WordPress/Shopify)', () => {
      const spec = specWithSchema({ properties: { id: plain, updatedAt: annotated } });
      expect(findLastModifiedFieldName(spec)).toBe('updatedAt');
    });

    it('returns undefined when no top-level field is annotated', () => {
      const spec = specWithSchema({ properties: { id: plain, updatedAt: plain } });
      expect(findLastModifiedFieldName(spec)).toBeUndefined();
    });
  });

  // 3. HubSpot-nested: properties.properties.properties.<name>
  describe('HubSpot-nested shape', () => {
    it('returns the annotated property under the nested properties object', () => {
      const spec = specWithSchema({
        properties: {
          id: plain,
          properties: { properties: { name: plain, hs_lastmodifieddate: annotated } },
        },
      });
      expect(findLastModifiedFieldName(spec)).toBe('hs_lastmodifieddate');
    });

    it('returns undefined when no nested HubSpot property is annotated', () => {
      const spec = specWithSchema({
        properties: { id: plain, properties: { properties: { name: plain } } },
      });
      expect(findLastModifiedFieldName(spec)).toBeUndefined();
    });
  });

  it('returns undefined for an empty or shapeless schema', () => {
    expect(findLastModifiedFieldName(specWithSchema({}))).toBeUndefined();
    expect(findLastModifiedFieldName(specWithSchema({ properties: {} }))).toBeUndefined();
  });

  it('prefers the Airtable-nested match over a flat top-level one', () => {
    const spec = specWithSchema({
      properties: { updatedAt: annotated, fields: { properties: { 'Last Modified': annotated } } },
    });
    expect(findLastModifiedFieldName(spec)).toBe('Last Modified');
  });
});
