import type { TSchema } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';
import {
  TableViewCol,
  X_SCRATCH_ASSET_FIELD,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { BaseJsonTableSpec, dotPath } from '../../../types';
import { buildAirtableDefaultView } from '../airtable-default-view';
import { buildAirtableJsonTableSpec } from '../airtable-json-schema';
import {
  AirtableBase,
  AirtableDataType,
  AirtableTableV2,
  X_SCRATCH_AIRTABLE_LOOKUP_RESULT_TYPE,
} from '../airtable-types';

function makeSchema(connectorDataType: string, opts: { readonly?: boolean; lookupResultType?: string } = {}): TSchema {
  const s = Type.String();
  (s as Record<string, unknown>)[X_SCRATCH_CONNECTOR_DATA_TYPE] = connectorDataType;
  if (opts.readonly) (s as Record<string, unknown>)[X_SCRATCH_READONLY] = true;
  if (opts.lookupResultType)
    (s as Record<string, unknown>)[X_SCRATCH_AIRTABLE_LOOKUP_RESULT_TYPE] = opts.lookupResultType;
  return s;
}

function makeAttachmentSchema() {
  const s = Type.Array(
    Type.Object({
      id: Type.String(),
      url: Type.String({ format: 'uri' }),
      filename: Type.Optional(Type.String()),
    }),
  );
  (s as Record<string, unknown>)[X_SCRATCH_CONNECTOR_DATA_TYPE] = AirtableDataType.MULTIPLE_ATTACHMENTS;
  (s as Record<string, unknown>)[X_SCRATCH_ASSET_FIELD] = { idPath: 'id', urlExpires: true };
  return s;
}

// The default view is now a pure function of the spec (MR2). Wrap the per-field
// schemas into a real Airtable record spec — `{ id, fields: { ... }, createdTime }`
// with the primary field named by `titlePath` — so `buildAirtableDefaultView(spec)`
// sees exactly what schema-gen produces on a pull. The `fields` object's key order
// is the Airtable-native field order.
function specFor(fieldsSchema: Record<string, TSchema>, primaryFieldName?: string): BaseJsonTableSpec {
  const schema = Type.Object({
    id: Type.String({ description: 'Unique record identifier' }),
    fields: Type.Object(fieldsSchema, { description: 'Record field values keyed by field name' }),
    createdTime: Type.String({ format: 'date-time' }),
  });
  return {
    id: { wsId: 'tbl1', remoteId: ['app1', 'tbl1'] },
    slug: 'tbl1',
    name: 'Tasks',
    schema,
    idPath: dotPath('id'),
    titlePath: primaryFieldName ? dotPath(`fields.${primaryFieldName}`) : undefined,
    basePath: ['Base'],
  };
}

describe('buildAirtableDefaultView', () => {
  const fieldsSchema: Record<string, TSchema> = {
    Name: makeSchema(AirtableDataType.SINGLE_LINE_TEXT),
    Status: makeSchema(AirtableDataType.SINGLE_SELECT),
    'Due Date': makeSchema(AirtableDataType.DATE_TIME),
    Notes: makeSchema(AirtableDataType.RICH_TEXT),
    Done: makeSchema(AirtableDataType.CHECKBOX),
    Score: makeSchema(AirtableDataType.NUMBER),
    Attachments: makeAttachmentSchema(),
    Website: makeSchema(AirtableDataType.URL),
    Created: makeSchema(AirtableDataType.CREATED_TIME, { readonly: true }),
    Tags: makeSchema(AirtableDataType.MULTIPLE_SELECTS),
    Computed: makeSchema('formula-number', { readonly: true }),
    Assignee: makeSchema(AirtableDataType.SINGLE_COLLABORATOR),
    'Created By': makeSchema(AirtableDataType.CREATED_BY, { readonly: true }),
  };
  const fieldCount = Object.keys(fieldsSchema).length;

  const view = buildAirtableDefaultView(specFor(fieldsSchema, 'Name'));

  it('should return a view named "Default"', () => {
    expect(view.name).toBe('Default');
  });

  it('should place the primary field first', () => {
    const firstCol = view.cols[0] as TableViewCol;
    expect(firstCol.path).toBe('fields.Name');
    expect(firstCol.name).toBe('Name');
  });

  it('leads with whichever field titlePath names (honors a user name-field override)', () => {
    // MR2 intentionally builds the view AFTER the write sites re-apply a user's
    // nameFieldOverride onto spec.titlePath, so the overridden title field now leads
    // the default view (master built the view pre-override, so it always led with the
    // Airtable primary field). This locks in that deliberate behavior change.
    const overriddenView = buildAirtableDefaultView(specFor(fieldsSchema, 'Score'));
    expect((overriddenView.cols[0] as TableViewCol).path).toBe('fields.Score');
  });

  it('should use fields.FieldName paths for all field columns', () => {
    const fieldCols = view.cols.filter((c) => c.kind === 'col' && c.path.startsWith('fields.'));
    expect(fieldCols.length).toBe(fieldCount);
  });

  it('should add createdTime as the last column', () => {
    const lastCol = view.cols[view.cols.length - 1] as TableViewCol;
    expect(lastCol.path).toBe('createdTime');
    expect(lastCol.name).toBe('Created Time');
    expect(lastCol.type).toBe('date');
    expect(lastCol.readonly).toBe(true);
  });

  it('should preserve Airtable field order after the primary field', () => {
    const paths = view.cols.map((c) => (c as TableViewCol).path);
    expect(paths[0]).toBe('fields.Name');
    expect(paths[1]).toBe('fields.Status');
    expect(paths[2]).toBe('fields.Due Date');
    expect(paths[3]).toBe('fields.Notes');
  });

  it('should use field names as column names (not reformatted)', () => {
    const dueDateCol = view.cols.find((c) => c.kind === 'col' && c.path === 'fields.Due Date') as TableViewCol;
    expect(dueDateCol.name).toBe('Due Date');
  });

  describe('type mapping', () => {
    it('should map number fields to number type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fields.Score') as TableViewCol;
      expect(col.type).toBe('number');
    });

    it('should map checkbox to checkbox type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fields.Done') as TableViewCol;
      expect(col.type).toBe('checkbox');
    });

    it('should map dateTime to date type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fields.Due Date') as TableViewCol;
      expect(col.type).toBe('date');
    });

    it('should map createdTime to date type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fields.Created') as TableViewCol;
      expect(col.type).toBe('date');
    });

    it('should map url to url type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fields.Website') as TableViewCol;
      expect(col.type).toBe('url');
    });

    it('should map richText to richtext type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fields.Notes') as TableViewCol;
      expect(col.type).toBe('richtext');
    });

    it('should map multipleAttachments to object type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fields.Attachments') as TableViewCol;
      expect(col.type).toBe('object');
    });

    it('should map multipleSelects to object type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fields.Tags') as TableViewCol;
      expect(col.type).toBe('object');
    });

    it('should not set type for text fields (string is default)', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fields.Name') as TableViewCol;
      expect(col.type).toBeUndefined();
    });

    it('should not set type for singleSelect (rendered as string)', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fields.Status') as TableViewCol;
      expect(col.type).toBeUndefined();
    });

    it('renders a formula whose result is a number as a flattened computed-field string', () => {
      // A `formula-number` field's value can arrive wrapped/errored/as an array, so
      // the view flattens it with the computed-field transformer and routes it
      // through the text cell (type 'string') rather than the raw number cell.
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fields.Computed') as TableViewCol;
      expect(col.type).toBe('string');
      expect(col.displayTransformer).toBeDefined();
    });
  });

  describe('readonly', () => {
    it('should mark computed fields as readonly', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fields.Computed') as TableViewCol;
      expect(col.readonly).toBe(true);
    });

    it('should mark createdTime fields as readonly', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fields.Created') as TableViewCol;
      expect(col.readonly).toBe(true);
    });

    it('should not mark editable fields as readonly', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fields.Name') as TableViewCol;
      expect(col.readonly).toBeUndefined();
    });
  });

  describe('collaborator subfields', () => {
    it('should add subfields to singleCollaborator with email selected', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fields.Assignee') as TableViewCol;
      expect(col.subfields).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(col.subfields![0].relativePath).toBe('email');
      expect(col.selectedSubfield).toBe(0);
    });

    it('should add subfields to createdBy with email selected', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fields.Created By') as TableViewCol;
      expect(col.subfields).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(col.subfields![0].relativePath).toBe('email');
      expect(col.selectedSubfield).toBe(0);
    });

    it('should not add subfields to non-collaborator fields', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fields.Name') as TableViewCol;
      expect(col.subfields).toBeUndefined();
    });
  });

  it('should handle a table with no fields gracefully', () => {
    const emptyView = buildAirtableDefaultView(specFor({}));
    // Just the createdTime column
    expect(emptyView.cols.length).toBe(1);
    expect((emptyView.cols[0] as TableViewCol).path).toBe('createdTime');
  });

  it('should not produce any banner groups', () => {
    const groups = view.cols.filter((c) => c.kind === 'banner-group');
    expect(groups).toHaveLength(0);
  });
});

describe('buildAirtableDefaultView: computed-field display transformers', () => {
  const fieldsSchema: Record<string, TSchema> = {
    Name: makeSchema(AirtableDataType.SINGLE_LINE_TEXT),
    Summary: makeSchema(AirtableDataType.AI_TEXT, { readonly: true }),
    'Text Formula': makeSchema('formula-singleLineText', { readonly: true }),
    'AI Formula': makeSchema('formula-aiText', { readonly: true }),
    'Number Formula': makeSchema('formula-number', { readonly: true }),
    'Date Rollup': makeSchema('rollup-dateTime', { readonly: true }),
    // multipleLookupValues carries its result type in the dedicated annotation, not
    // in the connector-data-type suffix — mirror what schema-gen emits.
    'AI Lookup': makeSchema(AirtableDataType.MULTIPLE_LOOKUP_VALUES, {
      readonly: true,
      lookupResultType: AirtableDataType.AI_TEXT,
    }),
    'Number Lookup': makeSchema(AirtableDataType.MULTIPLE_LOOKUP_VALUES, {
      readonly: true,
      lookupResultType: AirtableDataType.NUMBER,
    }),
  };

  const view = buildAirtableDefaultView(specFor(fieldsSchema, 'Name'));
  const colByPath = (path: string) => view.cols.find((c) => c.kind === 'col' && c.path === path) as TableViewCol;

  const EXPECTED_TRANSFORMER = {
    type: 'computed-field',
    options: { valueKeys: ['value', 'specialValue'], blankOnKeys: ['error'] },
  };

  it.each([
    ['fields.Summary', 'direct aiText'],
    ['fields.Text Formula', 'formula-of-text'],
    ['fields.AI Formula', 'formula-of-aiText'],
    ['fields.AI Lookup', 'lookup-of-aiText'],
    ['fields.Number Formula', 'formula-of-number (Infinity / NaN / #ERROR!)'],
    ['fields.Number Lookup', 'lookup-of-number'],
  ])('attaches a string computed-field transformer to %s (%s)', (path) => {
    const col = colByPath(path);
    expect(col.type).toBe('string');
    expect(col.displayTransformer).toEqual(EXPECTED_TRANSFORMER);
  });

  it.each([
    ['fields.Name', 'plain text field', undefined],
    ['fields.Date Rollup', 'rollup-of-date keeps its formatted date cell', 'date'],
  ])('does NOT attach a transformer to %s (%s)', (path, _desc, expectedType) => {
    const col = colByPath(path);
    expect(col.displayTransformer).toBeUndefined();
    expect(col.type).toBe(expectedType);
  });
});

describe('buildAirtableDefaultView: column order for numeric field names (regression)', () => {
  // Airtable field names are user-controlled and can be purely numeric. JS object-key
  // iteration hoists integer-like keys to an ascending-numeric front, so ordering off
  // Object.keys would silently reorder them. Schema-gen records the real API field
  // order in x-scratch-airtable-field-order; the view must honor it. Build the spec
  // through the real schema-gen so the annotation is present.
  const BASE = { id: 'app1', name: 'My Base' } as unknown as AirtableBase;
  const NUMERIC_FIELDS = [
    { id: 'f0', name: 'Name', type: AirtableDataType.SINGLE_LINE_TEXT },
    { id: 'f3', name: '3', type: AirtableDataType.NUMBER },
    { id: 'f1', name: '1', type: AirtableDataType.NUMBER },
    { id: 'f2', name: '2', type: AirtableDataType.NUMBER },
    { id: 'f10', name: '10', type: AirtableDataType.NUMBER },
    { id: 'fN', name: 'Notes', type: AirtableDataType.RICH_TEXT },
  ];

  function orderFor(primaryFieldId: string): string[] {
    const table = { id: 'tbl1', name: 'T', primaryFieldId, fields: NUMERIC_FIELDS } as unknown as AirtableTableV2;
    const spec = buildAirtableJsonTableSpec({ wsId: 'tbl1', remoteId: ['app1', 'tbl1'] }, BASE, table);
    return buildAirtableDefaultView(spec).cols.map((c) => (c as TableViewCol).path);
  }

  it('preserves native (non-ascending) Airtable order, not JS numeric-key order', () => {
    // Native order is Name, 3, 1, 2, 10, Notes — NOT the 1,2,3,10 a numeric sort gives.
    expect(orderFor('f0')).toEqual([
      'fields.Name',
      'fields.3',
      'fields.1',
      'fields.2',
      'fields.10',
      'fields.Notes',
      'createdTime',
    ]);
  });

  it('still leads with the primary field even when it is numeric', () => {
    expect(orderFor('f2')).toEqual([
      'fields.2',
      'fields.Name',
      'fields.3',
      'fields.1',
      'fields.10',
      'fields.Notes',
      'createdTime',
    ]);
  });
});
