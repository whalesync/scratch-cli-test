import { X_SCRATCH_ARRAY_KEYED_BY, X_SCRATCH_READONLY, X_SCRATCH_WRITE_ONCE } from '@spinner/shared-types';
import { describe, expect, it } from 'vitest';
import { buildColumnDefinitions } from '../build-column-definitions';
import type { ColumnDefinition } from '../types';
import { loadFixture } from './load-fixture';

function byId(columns: ColumnDefinition[], id: string): ColumnDefinition {
  const column = columns.find((c) => c.id === id);
  if (!column) {
    throw new Error(`Column not found: ${id}`);
  }
  return column;
}

describe('buildColumnDefinitions — airtable semiprecious stones', () => {
  const columns = buildColumnDefinitions(loadFixture('airtable-semiprecious-stones.schema.json'));

  it('produces columns in schema declaration order, recursing into fields', () => {
    expect(columns.map((c) => c.id)).toEqual([
      'id',
      'fields.Stone',
      'fields.Hardness',
      'fields.Value',
      'fields.Details',
      'fields.Primary Minerals',
      'fields.Read Only Autonumber',
      'fields.Birth Stone',
      'fields.Name (from Birth Stone)',
      'fields.Lookup Column',
      'createdTime',
    ]);
  });

  it('uses the last path segment as displayName when title is absent', () => {
    expect(byId(columns, 'fields.Stone').displayName).toBe('Stone');
    expect(byId(columns, 'fields.Name (from Birth Stone)').displayName).toBe('Name (from Birth Stone)');
    expect(byId(columns, 'createdTime').displayName).toBe('createdTime');
  });

  it('preserves description separately from displayName', () => {
    expect(byId(columns, 'id').description).toBe('Unique record identifier');
    expect(byId(columns, 'createdTime').description).toBe('ISO 8601 timestamp of record creation');
  });

  it('maps JSON Schema types to normalized data types', () => {
    expect(byId(columns, 'fields.Stone').dataType).toBe('string');
    expect(byId(columns, 'fields.Hardness').dataType).toBe('number');
    expect(byId(columns, 'fields.Read Only Autonumber').dataType).toBe('integer');
    expect(byId(columns, 'fields.Primary Minerals').dataType).toBe('array');
  });

  it('captures format on date-time fields', () => {
    expect(byId(columns, 'createdTime').format).toBe('date-time');
  });

  it('flags x-scratch-readonly fields', () => {
    expect(byId(columns, 'fields.Read Only Autonumber').attributes.readOnly).toBe(true);
    expect(byId(columns, 'fields.Name (from Birth Stone)').attributes.readOnly).toBe(true);
    expect(byId(columns, 'fields.Lookup Column').attributes.readOnly).toBe(true);
    expect(byId(columns, 'fields.Stone').attributes.readOnly).toBe(false);
  });

  it('marks required fields from the top-level required array', () => {
    expect(byId(columns, 'id').attributes.required).toBe(true);
    expect(byId(columns, 'createdTime').attributes.required).toBe(true);
    // `fields` is required at the top level but never emits as a column — its children inherit
    // nothing because `fields` has no `required` array of its own.
    expect(byId(columns, 'fields.Stone').attributes.required).toBe(false);
  });

  it('flags nested columns', () => {
    expect(byId(columns, 'id').attributes.nested).toBe(false);
    expect(byId(columns, 'createdTime').attributes.nested).toBe(false);
    expect(byId(columns, 'fields.Stone').attributes.nested).toBe(true);
  });

  it('passes through connector data types and remote field ids', () => {
    const stone = byId(columns, 'fields.Stone');
    expect(stone.attributes.connectorDataType).toBe('singleLineText');
    expect(stone.attributes.remoteFieldId).toBe('fld5XniJxjXtubkA8');
  });

  it('parses foreign key targets', () => {
    expect(byId(columns, 'fields.Birth Stone').attributes.foreignKey).toEqual({
      linkedTableId: 'tblDm2PThSGMpxyJx',
    });
    expect(byId(columns, 'fields.Stone').attributes.foreignKey).toBeUndefined();
  });

  // Regression: the real Airtable schema annotates the `fields` container with
  // `x-scratch-airtable-field-order` (a child-ordering hint). That is a container-layout annotation,
  // NOT a leaf marker, so it must not stop recursion — otherwise the whole `fields` object collapses
  // into one "FIELDS" JSON leaf (the RecordReviewDrawer bug). Contrast with leaf-marking annotations
  // like x-scratch-readonly / x-scratch-foreign-key, which DO force a leaf (see Moco `company` /
  // HubSpot `associations` in connector-fixtures.test.ts).
  it('recurses into a `fields` object even when it carries x-scratch-airtable-field-order', () => {
    const ids = columns.map((c) => c.id);
    expect(ids).not.toContain('fields');
    expect(ids).toContain('fields.Stone');
    expect(ids).toContain('fields.Lookup Column');
  });
});

describe('buildColumnDefinitions — edge cases', () => {
  it('returns [] when the wrapper is not an object', () => {
    expect(buildColumnDefinitions(null)).toEqual([]);
    expect(buildColumnDefinitions('nope')).toEqual([]);
    expect(buildColumnDefinitions(['array'])).toEqual([]);
  });

  it('returns [] when the inner schema is missing', () => {
    expect(buildColumnDefinitions(loadFixture('missing-schema.schema.json'))).toEqual([]);
  });

  it('treats a type:object without properties as a leaf object column', () => {
    const columns = buildColumnDefinitions(loadFixture('object-without-properties.schema.json'));
    expect(columns).toHaveLength(1);
    expect(columns[0].id).toBe('metadata');
    expect(columns[0].dataType).toBe('object');
    expect(columns[0].attributes.nested).toBe(false);
  });

  // DEV-10469: Memberstack expands its `customFields` object into per-key string
  // properties (while staying open via `additionalProperties`) so each renders as its
  // own editable column instead of one JSON blob. Verifies the generic engine drills
  // an open-but-keyed object — the inverse of the leaf case above.
  it('expands a customFields object with properties into per-key columns (not one blob)', () => {
    const columns = buildColumnDefinitions(loadFixture('memberstack-members.schema.json'));
    const ids = columns.map((c) => c.id);

    // The parent object is drilled, not emitted as a single leaf column.
    expect(ids).not.toContain('customFields');
    expect(ids).toContain('customFields.first-name');
    expect(ids).toContain('customFields.company');

    expect(byId(columns, 'customFields.first-name').dataType).toBe('string');
    expect(byId(columns, 'customFields.first-name').attributes.nested).toBe(true);
    expect(byId(columns, 'customFields.first-name').attributes.readOnly).toBe(false);
  });

  it('treats arrays of objects as leaf array columns', () => {
    const columns = buildColumnDefinitions(loadFixture('array-of-objects.schema.json'));
    expect(columns).toHaveLength(1);
    expect(columns[0].id).toBe('attachments');
    expect(columns[0].dataType).toBe('array');
    expect(columns[0].attributes.connectorDataType).toBe('multipleAttachments');
  });

  it('handles nullable union types by picking the first non-null type', () => {
    const columns = buildColumnDefinitions(loadFixture('malformed-union-type.schema.json'));
    expect(byId(columns, 'nullable_string').dataType).toBe('string');
    expect(byId(columns, 'nullable_number').dataType).toBe('number');
    expect(byId(columns, 'null_only').dataType).toBe('unknown');
  });

  it('inherits read-only and required flags from the immediate parent schema', () => {
    const columns = buildColumnDefinitions(loadFixture('read-only-flags.schema.json'));
    expect(byId(columns, 'id').attributes.readOnly).toBe(true);
    expect(byId(columns, 'id').attributes.required).toBe(true);
    expect(byId(columns, 'fields.Name').attributes.required).toBe(true);
    expect(byId(columns, 'fields.Name').attributes.readOnly).toBe(false);
    expect(byId(columns, 'fields.Computed').attributes.readOnly).toBe(true);
    expect(byId(columns, 'fields.Computed').attributes.required).toBe(false);
    expect(byId(columns, 'fields.Editable').attributes.readOnly).toBe(false);
    expect(byId(columns, 'fields.Editable').attributes.required).toBe(false);
  });

  it('parses x-scratch-write-once into attributes.writeOnce, independent of read-only', () => {
    const columns = buildColumnDefinitions({
      schema: {
        type: 'object',
        properties: {
          parent_object: { type: 'string', [X_SCRATCH_WRITE_ONCE]: true },
          name: { type: 'string' },
          record_id: { type: 'string', [X_SCRATCH_READONLY]: true },
        },
      },
    });
    expect(byId(columns, 'parent_object').attributes.writeOnce).toBe(true);
    expect(byId(columns, 'parent_object').attributes.readOnly).toBe(false);
    expect(byId(columns, 'name').attributes.writeOnce).toBe(false);
    expect(byId(columns, 'record_id').attributes.writeOnce).toBe(false);
    expect(byId(columns, 'record_id').attributes.readOnly).toBe(true);
  });

  it('normalizes scalar types for a flat schema', () => {
    const columns = buildColumnDefinitions(loadFixture('minimal-scalar.schema.json'));
    expect(columns.map((c) => [c.id, c.dataType])).toEqual([
      ['id', 'integer'],
      ['name', 'string'],
      ['active', 'boolean'],
      ['score', 'number'],
    ]);
    expect(byId(columns, 'id').attributes.required).toBe(true);
    expect(byId(columns, 'name').attributes.required).toBe(true);
    expect(byId(columns, 'active').attributes.required).toBe(false);
  });

  it('recurses into anyOf-wrapped objects (nullable containers) when no x-scratch metadata', () => {
    const columns = buildColumnDefinitions({
      schema: {
        type: 'object',
        properties: {
          seo: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  title: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                  description: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                },
              },
              { type: 'null' },
            ],
          },
        },
      },
    });
    expect(columns.map((c) => c.id)).toEqual(['seo.title', 'seo.description']);
    expect(columns[0].attributes.nested).toBe(true);
    expect(columns[0].dataType).toBe('string');
    expect(columns[1].attributes.nested).toBe(true);
    expect(columns[1].dataType).toBe('string');
  });

  it('does NOT recurse into anyOf-wrapped objects when x-scratch metadata is present', () => {
    const columns = buildColumnDefinitions({
      schema: {
        type: 'object',
        properties: {
          category: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                },
              },
              { type: 'null' },
            ],
            'x-scratch-readonly': true,
          },
        },
      },
    });
    expect(columns.map((c) => c.id)).toEqual(['category']);
    expect(columns[0].dataType).toBe('object');
    expect(columns[0].attributes.readOnly).toBe(true);
    expect(columns[0].attributes.nested).toBe(false);
  });

  it('recurses into oneOf-wrapped objects the same as anyOf', () => {
    const columns = buildColumnDefinitions({
      schema: {
        type: 'object',
        properties: {
          meta: {
            oneOf: [
              {
                type: 'object',
                properties: {
                  key: { type: 'string' },
                  value: { type: 'string' },
                },
              },
              { type: 'null' },
            ],
          },
        },
      },
    });
    expect(columns.map((c) => c.id)).toEqual(['meta.key', 'meta.value']);
  });
});

describe('buildColumnDefinitions — keyed arrays (x-scratch-array-keyed-by)', () => {
  const columns = buildColumnDefinitions({
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        custom_fields: {
          type: 'array',
          [X_SCRATCH_ARRAY_KEYED_BY]: {
            keyField: 'custom_field_definition_id',
            valuePath: 'value',
            columns: [
              { key: 700123, name: 'Tier', type: 'string' },
              { key: 700124, name: 'Active', type: 'checkbox', readonly: true },
            ],
          },
        },
      },
    },
  });

  it('expands one filtered-path column per annotated key instead of a single leaf', () => {
    expect(columns.map((c) => c.id)).toEqual([
      'name',
      'custom_fields.[custom_field_definition_id=700123].value',
      'custom_fields.[custom_field_definition_id=700124].value',
    ]);
  });

  it('carries the annotation name, type hint and readonly onto each expanded column', () => {
    const tier = byId(columns, 'custom_fields.[custom_field_definition_id=700123].value');
    expect(tier.displayName).toBe('Tier');
    expect(tier.dataType).toBe('string');
    expect(tier.attributes.readOnly).toBe(false);

    const active = byId(columns, 'custom_fields.[custom_field_definition_id=700124].value');
    expect(active.dataType).toBe('boolean'); // 'checkbox' hint → boolean data type
    expect(active.attributes.readOnly).toBe(true);
  });
});
