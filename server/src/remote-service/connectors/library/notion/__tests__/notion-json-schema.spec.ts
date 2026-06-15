import { type DataSourceObjectResponse } from '@notionhq/client';
import {
  X_SCRATCH_ASSET_FIELD,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_LAST_MODIFIED_FIELD,
  X_SCRATCH_READONLY,
  X_SCRATCH_REMOTE_FIELD_ID,
  X_SCRATCH_VIRTUAL_FIELDS,
} from '@spinner/shared-types';
import { buildNotionJsonTableSpec, notionPropertyToJsonSchema } from '../notion-json-schema';

type SchemaNode = Record<string, unknown>;

/** Generate the envelope schema for a single property, as a navigable record. */
function prop(type: string, extra: Record<string, unknown> = {}): SchemaNode {
  const property = {
    id: `id_${type}`,
    name: `${type} field`,
    type,
    ...extra,
  } as unknown as DataSourceObjectResponse['properties'][string];
  return notionPropertyToJsonSchema(property) as unknown as SchemaNode;
}

/** The `properties` map of an object schema node. */
function props(node: SchemaNode): Record<string, SchemaNode> {
  return node.properties as Record<string, SchemaNode>;
}

/** The `const` of a Type.Literal node. */
function literalConst(node: SchemaNode): unknown {
  return node.const;
}

describe('notionPropertyToJsonSchema — raw envelope shape', () => {
  describe('every property is an object envelope { id, type, <typeKey> }', () => {
    it('wraps a scalar property (email) in the envelope', () => {
      const s = prop('email');
      expect(s.type).toBe('object');
      expect(props(s).id.type).toBe('string');
      expect(literalConst(props(s).type)).toBe('email');
      // inner value is the unwrapped email value (nullable string union)
      expect(props(s).email.anyOf).toBeDefined();
    });

    it('wraps an array property (multi_select) in the envelope', () => {
      const s = prop('multi_select');
      expect(s.type).toBe('object');
      expect(literalConst(props(s).type)).toBe('multi_select');
      expect(props(s).multi_select.type).toBe('array');
    });

    it('wraps the title property; inner value is the rich-text array', () => {
      const s = prop('title');
      expect(literalConst(props(s).type)).toBe('title');
      expect(props(s).title.type).toBe('array');
    });
  });

  describe('annotations live on the OUTER envelope object', () => {
    it('puts connector-data-type and remote-field-id on the envelope', () => {
      const s = prop('email');
      expect(s[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('email');
      expect(s[X_SCRATCH_REMOTE_FIELD_ID]).toBe('id_email');
    });

    it('marks read-only property types readonly on the envelope', () => {
      expect(prop('formula')[X_SCRATCH_READONLY]).toBe(true);
      expect(prop('rollup')[X_SCRATCH_READONLY]).toBe(true);
      expect(prop('created_time')[X_SCRATCH_READONLY]).toBe(true);
    });

    it('does not mark writable property types readonly', () => {
      expect(prop('email')[X_SCRATCH_READONLY]).toBeUndefined();
      expect(prop('number')[X_SCRATCH_READONLY]).toBeUndefined();
    });

    it('puts the title virtual field on the envelope with an envelope-relative JSONPath', () => {
      const s = prop('title');
      const virtual = s[X_SCRATCH_VIRTUAL_FIELDS] as Array<{
        suggestedTransformer: { options: { expression: string } };
      }>;
      expect(virtual).toBeDefined();
      expect(virtual[0].suggestedTransformer.options.expression).toBe('$.title[*].plain_text');
    });

    it('puts the files asset-field and virtual field on the envelope', () => {
      const s = prop('files');
      expect(s[X_SCRATCH_ASSET_FIELD]).toEqual({ idPath: null, urlExpires: true });
      expect(s[X_SCRATCH_VIRTUAL_FIELDS]).toBeDefined();
      expect(props(s).files.type).toBe('array');
    });
  });

  describe('relation — modeled with has_more and FK on the outer envelope', () => {
    const s = prop('relation', { relation: { database_id: 'db_linked' } });

    it('models the relation array and the has_more sibling', () => {
      expect(literalConst(props(s).type)).toBe('relation');
      expect(props(s).relation.type).toBe('array');
      expect(props(s).has_more).toBeDefined();
      expect(props(s).has_more.type).toBe('boolean');
    });

    it('makes has_more optional (not in required)', () => {
      const required = s.required as string[];
      expect(required).toContain('id');
      expect(required).toContain('relation');
      expect(required).not.toContain('has_more');
    });

    it('puts the foreign-key options on the outer envelope', () => {
      expect(s[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'db_linked', map: 'id' });
    });

    it('omits foreign-key options when the relation has no database_id', () => {
      const noFk = prop('relation', { relation: {} });
      expect(noFk[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toBeUndefined();
    });
  });

  describe('rollup — both nesting levels modeled', () => {
    const s = prop('rollup');

    it('models the inner rollup object with function/type', () => {
      expect(literalConst(props(s).type)).toBe('rollup');
      const rollupInner = props(s).rollup;
      expect(rollupInner.type).toBe('object');
      expect(props(rollupInner).function).toBeDefined();
      expect(props(rollupInner).type).toBeDefined();
    });
  });

  describe('null inner values', () => {
    it('models select as a nullable inner object', () => {
      const s = prop('select');
      const inner = props(s).select;
      const variants = inner.anyOf as SchemaNode[];
      expect(variants).toBeDefined();
      expect(variants.some((v) => v.type === 'null')).toBe(true);
    });

    it('models number as a nullable inner number', () => {
      const s = prop('number');
      const variants = props(s).number.anyOf as SchemaNode[];
      expect(variants.some((v) => v.type === 'null')).toBe(true);
      expect(variants.some((v) => v.type === 'number')).toBe(true);
    });
  });

  describe('unknown / future property type', () => {
    it('keeps the envelope shape with an opaque inner value', () => {
      const s = prop('wacky_future_type');
      expect(s.type).toBe('object');
      expect(literalConst(props(s).type)).toBe('wacky_future_type');
      expect(props(s).wacky_future_type).toBeDefined();
      expect(s[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('wacky_future_type');
    });
  });
});

// ── Page-level envelope (unchanged behavior, kept as a guardrail) ──

function buildDataSource(): DataSourceObjectResponse {
  return {
    object: 'data_source',
    id: 'ds_123',
    title: [{ plain_text: 'My DB' }],
    properties: {
      Name: { id: 'title', name: 'Name', type: 'title' },
    },
  } as unknown as DataSourceObjectResponse;
}

describe('buildNotionJsonTableSpec top-level field annotations', () => {
  function topLevelProps(): Record<string, Record<string, unknown>> {
    const spec = buildNotionJsonTableSpec({ wsId: 'db', remoteId: ['db_123', 'ds_123'] }, buildDataSource());
    return (spec.schema as unknown as { properties: Record<string, Record<string, unknown>> }).properties;
  }

  it('annotates the top-level last_edited_time with x-scratch-last-modified-field=true', () => {
    expect(topLevelProps().last_edited_time[X_SCRATCH_LAST_MODIFIED_FIELD]).toBe(true);
  });

  it('does not annotate the created_time system field', () => {
    expect(topLevelProps().created_time[X_SCRATCH_LAST_MODIFIED_FIELD]).toBeUndefined();
  });

  it('marks the fixed read-only system fields readonly', () => {
    expect(topLevelProps().created_time[X_SCRATCH_READONLY]).toBe(true);
    expect(topLevelProps().last_edited_time[X_SCRATCH_READONLY]).toBe(true);
    expect(topLevelProps().created_by[X_SCRATCH_READONLY]).toBe(true);
    expect(topLevelProps().last_edited_by[X_SCRATCH_READONLY]).toBe(true);
    expect(topLevelProps().url[X_SCRATCH_READONLY]).toBe(true);
  });

  it('leaves genuinely writable fixed fields (cover, icon, in_trash) editable', () => {
    expect(topLevelProps().cover[X_SCRATCH_READONLY]).toBeUndefined();
    expect(topLevelProps().icon[X_SCRATCH_READONLY]).toBeUndefined();
    expect(topLevelProps().in_trash[X_SCRATCH_READONLY]).toBeUndefined();
  });
});
