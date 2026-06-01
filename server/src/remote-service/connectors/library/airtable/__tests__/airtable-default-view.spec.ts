import { Type } from '@sinclair/typebox';
import {
  TableViewCol,
  X_SCRATCH_ASSET_FIELD,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { buildAirtableDefaultView } from '../airtable-default-view';
import { AirtableDataType, AirtableFieldsV2, AirtableTableV2 } from '../airtable-types';

function makeField(id: string, name: string, type: AirtableDataType): AirtableFieldsV2 {
  return { id, name, type } as AirtableFieldsV2;
}

function makeSchema(connectorDataType: string, opts: { readonly?: boolean } = {}) {
  const s = Type.String();
  (s as Record<string, unknown>)[X_SCRATCH_CONNECTOR_DATA_TYPE] = connectorDataType;
  if (opts.readonly) (s as Record<string, unknown>)[X_SCRATCH_READONLY] = true;
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

describe('buildAirtableDefaultView', () => {
  const fields: AirtableFieldsV2[] = [
    makeField('fld1', 'Name', AirtableDataType.SINGLE_LINE_TEXT),
    makeField('fld2', 'Status', AirtableDataType.SINGLE_SELECT),
    makeField('fld3', 'Due Date', AirtableDataType.DATE_TIME),
    makeField('fld4', 'Notes', AirtableDataType.RICH_TEXT),
    makeField('fld5', 'Done', AirtableDataType.CHECKBOX),
    makeField('fld6', 'Score', AirtableDataType.NUMBER),
    makeField('fld7', 'Attachments', AirtableDataType.MULTIPLE_ATTACHMENTS),
    makeField('fld8', 'Website', AirtableDataType.URL),
    makeField('fld9', 'Created', AirtableDataType.CREATED_TIME),
    makeField('fld10', 'Tags', AirtableDataType.MULTIPLE_SELECTS),
    makeField('fld11', 'Computed', AirtableDataType.FORMULA),
    makeField('fld12', 'Assignee', AirtableDataType.SINGLE_COLLABORATOR),
    makeField('fld13', 'Created By', AirtableDataType.CREATED_BY),
  ];

  const table: AirtableTableV2 = {
    id: 'tbl1',
    name: 'Tasks',
    primaryFieldId: 'fld1',
    fields,
  } as AirtableTableV2;

  const fieldsSchema: Record<string, ReturnType<typeof makeSchema>> = {
    Name: makeSchema(AirtableDataType.SINGLE_LINE_TEXT),
    Status: makeSchema(AirtableDataType.SINGLE_SELECT),
    'Due Date': makeSchema(AirtableDataType.DATE_TIME),
    Notes: makeSchema(AirtableDataType.RICH_TEXT),
    Done: makeSchema(AirtableDataType.CHECKBOX),
    Score: makeSchema(AirtableDataType.NUMBER),
    Attachments: makeAttachmentSchema() as unknown as ReturnType<typeof makeSchema>,
    Website: makeSchema(AirtableDataType.URL),
    Created: makeSchema(AirtableDataType.CREATED_TIME, { readonly: true }),
    Tags: makeSchema(AirtableDataType.MULTIPLE_SELECTS),
    Computed: makeSchema('formula-number', { readonly: true }),
    Assignee: makeSchema(AirtableDataType.SINGLE_COLLABORATOR),
    'Created By': makeSchema(AirtableDataType.CREATED_BY, { readonly: true }),
  };

  const view = buildAirtableDefaultView(table, fieldsSchema);

  it('should return a view named "Default"', () => {
    expect(view.name).toBe('Default');
  });

  it('should place the primary field first', () => {
    const firstCol = view.cols[0] as TableViewCol;
    expect(firstCol.path).toBe('fields.Name');
    expect(firstCol.name).toBe('Name');
  });

  it('should use fields.FieldName paths for all field columns', () => {
    const fieldCols = view.cols.filter((c) => c.kind === 'col' && c.path.startsWith('fields.'));
    expect(fieldCols.length).toBe(fields.length);
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

    it('should map formula-number to number type', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fields.Computed') as TableViewCol;
      expect(col.type).toBe('number');
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
      expect(col.subfields![0].relativePath).toBe('email');
      expect(col.selectedSubfield).toBe(0);
    });

    it('should add subfields to createdBy with email selected', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fields.Created By') as TableViewCol;
      expect(col.subfields).toBeDefined();
      expect(col.subfields![0].relativePath).toBe('email');
      expect(col.selectedSubfield).toBe(0);
    });

    it('should not add subfields to non-collaborator fields', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'fields.Name') as TableViewCol;
      expect(col.subfields).toBeUndefined();
    });
  });

  it('should handle a table with no fields gracefully', () => {
    const emptyTable = { id: 'tbl2', name: 'Empty', fields: [] } as unknown as AirtableTableV2;
    const emptyView = buildAirtableDefaultView(emptyTable, {});
    // Just the createdTime column
    expect(emptyView.cols.length).toBe(1);
    expect((emptyView.cols[0] as TableViewCol).path).toBe('createdTime');
  });

  it('should not produce any banner groups', () => {
    const groups = view.cols.filter((c) => c.kind === 'banner-group');
    expect(groups).toHaveLength(0);
  });
});
