import { Type } from '@sinclair/typebox';
import {
  TableViewCol,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_READONLY,
  X_SCRATCH_WRITE_ONCE,
} from '@spinner/shared-types';
import {
  AttioObjectViewConfig,
  buildAttioDefaultView,
  LIST_VIEW_CONFIG,
  OBJECT_VIEW_CONFIG,
} from '../attio-default-view';

/** Build an Attio attribute value-array schema with annotations. */
function attr(connectorDataType: string, opts: { readonly?: boolean } = {}) {
  const annotations: Record<string, unknown> = {
    [X_SCRATCH_CONNECTOR_DATA_TYPE]: connectorDataType,
  };
  if (opts.readonly) annotations[X_SCRATCH_READONLY] = true;
  return Type.Array(Type.Object({}, { additionalProperties: true }), annotations);
}

function makeObjectSchema() {
  return Type.Object({
    id: Type.Object(
      {
        workspace_id: Type.String(),
        object_id: Type.String(),
        record_id: Type.String(),
      },
      { [X_SCRATCH_READONLY]: true },
    ),
    created_at: Type.String({ format: 'date-time', [X_SCRATCH_READONLY]: true }),
    web_url: Type.Optional(Type.String({ [X_SCRATCH_READONLY]: true })),
    values: Type.Object({
      name: attr('text'),
      domains: attr('domain'),
      description: attr('text'),
      team: attr('actor-reference', { readonly: true }),
      email_addresses: attr('email-address'),
      phone_numbers: attr('phone-number'),
      categories: attr('select', { readonly: true }),
      created_by: attr('actor-reference', { readonly: true }),
      record_id: attr('record-id', { readonly: true }),
      primary_location: attr('location'),
      estimated_arr: attr('currency'),
      founded_date: attr('date'),
      is_active: attr('checkbox'),
    }),
  });
}

function makeListSchema() {
  return Type.Object({
    id: Type.Object(
      {
        workspace_id: Type.String(),
        list_id: Type.String(),
        entry_id: Type.String(),
      },
      { [X_SCRATCH_READONLY]: true },
    ),
    // Write-once (settable on create, not re-parentable) — mirrors the real
    // list schema. See attio-json-schema.ts.
    parent_record_id: Type.String({ [X_SCRATCH_WRITE_ONCE]: true }),
    parent_object: Type.String({ [X_SCRATCH_WRITE_ONCE]: true }),
    created_at: Type.String({ format: 'date-time', [X_SCRATCH_READONLY]: true }),
    entry_values: Type.Object({
      stage: attr('status'),
      value: attr('currency'),
      close_date: attr('date'),
    }),
  });
}

describe('buildAttioDefaultView (object)', () => {
  const schema = makeObjectSchema();
  const config = OBJECT_VIEW_CONFIG['companies'];
  const view = buildAttioDefaultView(schema, config);

  it('should return a view named "Default"', () => {
    expect(view.name).toBe('Default');
  });

  describe('column ordering', () => {
    it('should place title (name) first', () => {
      const first = view.cols[0] as TableViewCol;
      expect(first.path).toBe('values.name');
    });

    it('should place id right after title', () => {
      const second = view.cols[1] as TableViewCol;
      expect(second.path).toBe('id');
    });

    it('should place priority fields after id', () => {
      const third = view.cols[2] as TableViewCol;
      const fourth = view.cols[3] as TableViewCol;
      const fifth = view.cols[4] as TableViewCol;
      expect(third.path).toBe('values.domains');
      expect(fourth.path).toBe('values.description');
      expect(fifth.path).toBe('values.team');
    });

    it('should place remaining fixed fields after all value fields', () => {
      const createdAtIdx = view.cols.findIndex((c) => c.kind === 'col' && c.path === 'created_at');
      const lastValueIdx = view.cols.findIndex((c) => c.kind === 'col' && c.path === 'values.is_active');
      expect(lastValueIdx).toBeLessThan(createdAtIdx);
    });
  });

  describe('name formatting', () => {
    it('should format snake_case value field names as Title Case', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'values.email_addresses') as TableViewCol;
      expect(col.name).toBe('Email Addresses');
    });

    it('should format kebab-case attribute names as Title Case', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'values.primary_location') as TableViewCol;
      expect(col.name).toBe('Primary Location');
    });

    it('should format snake_case fixed fields as Title Case', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'created_at') as TableViewCol;
      expect(col.name).toBe('Created At');
    });
  });

  describe('hidden fields', () => {
    it('should hide web_url', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'web_url') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should hide system value fields like created_by', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'values.created_by') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should hide record_id value field', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'values.record_id') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should hide categories value field', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'values.categories') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should not hide useful value columns', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'values.name') as TableViewCol;
      expect(col.hidden).toBeUndefined();
    });

    it('should not hide id', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'id') as TableViewCol;
      expect(col.hidden).toBeUndefined();
    });
  });

  describe('type mapping', () => {
    // Value columns that carry a displayTransformer render the flattened scalar
    // as text — the grid's number/checkbox/url cell kinds ignore displayTransformer
    // and would render the raw value array instead — so they are all typed
    // 'string' regardless of the underlying Attio attribute type.
    it('should type value columns with a displayTransformer as string', () => {
      for (const path of [
        'values.name', // text
        'values.domains', // domain
        'values.estimated_arr', // currency
        'values.is_active', // checkbox
        'values.founded_date', // date
        'values.primary_location', // location
        'values.email_addresses', // email-address
        'values.team', // actor-reference
      ]) {
        const col = view.cols.find((c) => c.kind === 'col' && c.path === path) as TableViewCol;
        expect(col.type).toBe('string');
      }
    });

    it('should map date-time format fixed field to date type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'created_at') as TableViewCol;
      expect(col.type).toBe('date');
    });

    it('should map id Object Kind to object type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'id') as TableViewCol;
      expect(col.type).toBe('object');
    });
  });

  describe('display transformer (declarative value-array flattening)', () => {
    it('extracts the scalar value via JSONPath for simple value types', () => {
      const name = view.cols.find((c) => c.kind === 'col' && c.path === 'values.name') as TableViewCol;
      expect(name.displayTransformer).toEqual({
        type: 'jsonpath',
        options: { expression: '$[0].value', arrayHandling: 'first' },
      });
      const arr = view.cols.find((c) => c.kind === 'col' && c.path === 'values.estimated_arr') as TableViewCol;
      expect(arr.displayTransformer).toEqual({
        type: 'jsonpath',
        options: { expression: '$[0].value', arrayHandling: 'first' },
      });
    });

    it('extracts type-specific payload keys (domain, email, actor-reference)', () => {
      // Helper narrows the DisplayTransformerConfig union to the jsonpath arm so
      // `.options.expression` is accessible (a computed-field arm has no expression).
      const expressionOf = (col: TableViewCol): string | undefined => {
        const transformer = col.displayTransformer;
        return transformer?.type === 'jsonpath' ? transformer.options.expression : undefined;
      };
      const domains = view.cols.find((c) => c.kind === 'col' && c.path === 'values.domains') as TableViewCol;
      expect(expressionOf(domains)).toBe('$[0].domain');
      const emails = view.cols.find((c) => c.kind === 'col' && c.path === 'values.email_addresses') as TableViewCol;
      expect(expressionOf(emails)).toBe('$[0].email_address');
      const team = view.cols.find((c) => c.kind === 'col' && c.path === 'values.team') as TableViewCol;
      expect(expressionOf(team)).toBe('$[0].referenced_actor_id');
    });

    it('does not attach a transformer to types without an extraction expression', () => {
      // `record_id` (attribute type `record-id`) has no entry in ATTIO_VALUE_EXPRESSION.
      const recordId = view.cols.find((c) => c.kind === 'col' && c.path === 'values.record_id') as TableViewCol;
      expect(recordId.displayTransformer).toBeUndefined();
    });

    it('does not attach a transformer to fixed (non-value) columns', () => {
      const id = view.cols.find((c) => c.kind === 'col' && c.path === 'id') as TableViewCol;
      const createdAt = view.cols.find((c) => c.kind === 'col' && c.path === 'created_at') as TableViewCol;
      expect(id.displayTransformer).toBeUndefined();
      expect(createdAt.displayTransformer).toBeUndefined();
    });

    it('extracts a personal-name title via full_name', () => {
      const peopleSchema = Type.Object({
        id: Type.Object({
          workspace_id: Type.String(),
          object_id: Type.String(),
          record_id: Type.String(),
        }),
        values: Type.Object({ name: attr('personal-name') }),
      });
      const peopleView = buildAttioDefaultView(peopleSchema, OBJECT_VIEW_CONFIG['people']);
      const nameCol = peopleView.cols.find((c) => c.kind === 'col' && c.path === 'values.name') as TableViewCol;
      expect(nameCol.displayTransformer).toEqual({
        type: 'jsonpath',
        options: { expression: '$[0].full_name', arrayHandling: 'first' },
      });
    });
  });

  describe('id column subfield', () => {
    it('defaults the id triple to its record_id subfield instead of raw JSON', () => {
      const id = view.cols.find((c) => c.kind === 'col' && c.path === 'id') as TableViewCol;
      expect(id.subfields).toEqual([{ relativePath: 'record_id', name: 'Record Id', type: 'string' }]);
      expect(id.selectedSubfield).toBe(0);
      // The id column itself stays read-only; the subfield doesn't change that.
      expect(id.readonly).toBe(true);
    });

    it('leaves a plain (non-object) id with no subfield', () => {
      const stringIdSchema = Type.Object({
        id: Type.String(),
        custom_values: Type.Object({ title: attr('text') }),
      });
      const stringIdView = buildAttioDefaultView(stringIdSchema, {
        valuesKey: 'custom_values',
        titleField: 'title',
      });
      const id = stringIdView.cols.find((c) => c.kind === 'col' && c.path === 'id') as TableViewCol;
      expect(id.subfields).toBeUndefined();
      expect(id.selectedSubfield).toBeUndefined();
    });
  });

  describe('readonly', () => {
    it('should mark schema-annotated readonly value fields', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'values.team') as TableViewCol;
      expect(col.readonly).toBe(true);
    });

    it('should mark created_by as readonly (always-readonly)', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'values.created_by') as TableViewCol;
      expect(col.readonly).toBe(true);
    });

    it('should mark id as readonly', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'id') as TableViewCol;
      expect(col.readonly).toBe(true);
    });

    it('should mark created_at as readonly', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'created_at') as TableViewCol;
      expect(col.readonly).toBe(true);
    });

    it('should not mark writable value fields as readonly', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'values.name') as TableViewCol;
      expect(col.readonly).toBeUndefined();
    });
  });

  it('should handle an empty values schema', () => {
    const emptySchema = Type.Object({
      id: Type.Object({
        workspace_id: Type.String(),
        object_id: Type.String(),
        record_id: Type.String(),
      }),
      created_at: Type.String(),
      values: Type.Object({}),
    });
    const emptyView = buildAttioDefaultView(emptySchema, { valuesKey: 'values' });
    expect(emptyView.cols.length).toBe(2); // id, created_at
  });

  it('should handle a schema with no values field at all', () => {
    const noValuesSchema = Type.Object({
      id: Type.Object({
        workspace_id: Type.String(),
        object_id: Type.String(),
        record_id: Type.String(),
      }),
    });
    const noValuesView = buildAttioDefaultView(noValuesSchema, { valuesKey: 'values' });
    expect(noValuesView.cols.length).toBe(1); // just id
  });
});

describe('buildAttioDefaultView (list)', () => {
  const schema = makeListSchema();
  const view = buildAttioDefaultView(schema, LIST_VIEW_CONFIG);

  it('should return a view named "Default"', () => {
    expect(view.name).toBe('Default');
  });

  it('should use entry_values paths for list attributes', () => {
    const stagePath = view.cols.find((c) => c.kind === 'col' && c.path === 'entry_values.stage');
    expect(stagePath).toBeDefined();
  });

  it('should attach a status-title displayTransformer to a status entry value', () => {
    const stage = view.cols.find((c) => c.kind === 'col' && c.path === 'entry_values.stage') as TableViewCol;
    expect(stage.type).toBe('string');
    expect(stage.displayTransformer).toEqual({
      type: 'jsonpath',
      options: { expression: '$[0].status.title', arrayHandling: 'first' },
    });
  });

  it('should place id first when no title field is configured', () => {
    const first = view.cols[0] as TableViewCol;
    expect(first.path).toBe('id');
  });

  it('should default the list id triple to its entry_id subfield', () => {
    const id = view.cols.find((c) => c.kind === 'col' && c.path === 'id') as TableViewCol;
    expect(id.subfields).toEqual([{ relativePath: 'entry_id', name: 'Entry Id', type: 'string' }]);
    expect(id.selectedSubfield).toBe(0);
  });

  it('should place entry value fields after id', () => {
    const stageIdx = view.cols.findIndex((c) => c.kind === 'col' && c.path === 'entry_values.stage');
    const idIdx = view.cols.findIndex((c) => c.kind === 'col' && c.path === 'id');
    expect(stageIdx).toBeGreaterThan(idIdx);
  });

  it('should show parent_record_id and parent_object so a user can set them when creating an entry', () => {
    const parentRecordCol = view.cols.find((c) => c.kind === 'col' && c.path === 'parent_record_id') as TableViewCol;
    const parentObjectCol = view.cols.find((c) => c.kind === 'col' && c.path === 'parent_object') as TableViewCol;
    expect(parentRecordCol.hidden).toBeUndefined();
    expect(parentObjectCol.hidden).toBeUndefined();
  });

  it('should mark parent_record_id and parent_object write-once (not read-only) on the view column', () => {
    const parentRecordCol = view.cols.find((c) => c.kind === 'col' && c.path === 'parent_record_id') as TableViewCol;
    const parentObjectCol = view.cols.find((c) => c.kind === 'col' && c.path === 'parent_object') as TableViewCol;
    expect(parentRecordCol.writeOnce).toBe(true);
    expect(parentObjectCol.writeOnce).toBe(true);
    // Write-once must NOT be read-only, or the grid would block creating a new entry.
    expect(parentRecordCol.readonly).toBeUndefined();
    expect(parentObjectCol.readonly).toBeUndefined();
  });
});

describe('OBJECT_VIEW_CONFIG', () => {
  it('should have configs for companies, people, and deals', () => {
    expect(OBJECT_VIEW_CONFIG['companies']).toBeDefined();
    expect(OBJECT_VIEW_CONFIG['people']).toBeDefined();
    expect(OBJECT_VIEW_CONFIG['deals']).toBeDefined();
  });

  it('should all use "values" as valuesKey', () => {
    for (const config of Object.values(OBJECT_VIEW_CONFIG)) {
      expect(config.valuesKey).toBe('values');
    }
  });

  it('should all have "name" as title field', () => {
    for (const config of Object.values(OBJECT_VIEW_CONFIG)) {
      expect(config.titleField).toBe('name');
    }
  });
});

describe('people view config', () => {
  it('should prioritize contact-relevant fields', () => {
    const config = OBJECT_VIEW_CONFIG['people'];
    expect(config.priorityFields).toContain('email_addresses');
    expect(config.priorityFields).toContain('phone_numbers');
  });
});

describe('custom config', () => {
  it('should accept a custom config with different valuesKey and priorities', () => {
    const schema = Type.Object({
      id: Type.String(),
      custom_values: Type.Object({
        title: attr('text'),
        status: attr('status'),
      }),
    });
    const config: AttioObjectViewConfig = {
      valuesKey: 'custom_values',
      titleField: 'title',
      priorityFields: ['status'],
    };
    const view = buildAttioDefaultView(schema, config);
    const first = view.cols[0] as TableViewCol;
    expect(first.path).toBe('custom_values.title');
  });
});
