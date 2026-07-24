import type { TSchema } from '@sinclair/typebox';
import {
  getSuggestedTransform,
  type TableView,
  type TransformerConfig,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_SUGGESTED_IN_TRANSFORMER,
  X_SCRATCH_SUGGESTED_TRANSFORMER,
} from '@spinner/shared-types';
import { extractSchemaFields, resolveSchemaTypeAtPath, type SchemaField } from '../utils/schema-helpers';
import { columnTransformInputFromSchemaField, resolveColumnTransformInput } from './resolve-column-transform-input';

// Transform hints (envelope-relative) the way Notion's json-schema declares them.
const notesUnpack: TransformerConfig = { type: 'jsonpath', options: { expression: '$.rich_text[*].plain_text' } };
const notesPack: TransformerConfig = {
  type: 'wrap_object',
  options: { template: { type: 'rich_text', rich_text: '$value' } },
};
const statusPack: TransformerConfig = {
  type: 'wrap_object',
  options: { template: { type: 'select', select: '$value' } },
};
const filesUnpack: TransformerConfig = { type: 'notion_file_url', options: { arrayHandling: 'array' } };

// A Notion-shaped record schema: each property is a single leaf at its ENVELOPE (`properties.X`, tagged
// with x-scratch so the flattener keeps it whole), while the real value nests one level deeper.
const schema = {
  type: 'object',
  properties: {
    properties: {
      type: 'object',
      properties: {
        Notes: {
          type: 'object',
          [X_SCRATCH_SUGGESTED_TRANSFORMER]: notesUnpack,
          [X_SCRATCH_SUGGESTED_IN_TRANSFORMER]: notesPack,
          properties: {
            id: { type: 'string' },
            rich_text: { type: 'array', items: { type: 'object' } },
          },
        },
        Tags: {
          type: 'object',
          [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'multi_select',
          properties: {
            id: { type: 'string' },
            multi_select: { type: 'array', items: { type: 'object' } },
          },
        },
        Status: {
          type: 'object',
          [X_SCRATCH_SUGGESTED_IN_TRANSFORMER]: statusPack,
          properties: {
            id: { type: 'string' },
            select: { type: 'object', properties: { name: { type: 'string' }, color: { type: 'string' } } },
          },
        },
        Files: {
          type: 'object',
          [X_SCRATCH_SUGGESTED_TRANSFORMER]: filesUnpack,
          properties: {
            id: { type: 'string' },
            files: { type: 'array', items: { type: 'object' } },
          },
        },
      },
    },
  },
} as unknown as TSchema;

const view: TableView = {
  name: 'default',
  cols: [
    {
      kind: 'col',
      path: 'properties.Notes.rich_text',
      name: 'Notes',
      type: 'richtext',
      displayTransformer: { type: 'jsonpath', options: { expression: '$[*].plain_text', arrayHandling: 'concat' } },
    },
    { kind: 'col', path: 'properties.Tags.multi_select', name: 'Tags', type: 'object' },
    { kind: 'col', path: 'properties.Files.files', name: 'Files', type: 'object' },
    {
      kind: 'col',
      path: 'properties.Status.select',
      name: 'Status',
      type: 'object',
      subfields: [{ relativePath: 'name', name: 'Name', type: 'string' }],
      selectedSubfield: 0,
    },
  ],
};

const fieldsByPath = new Map(extractSchemaFields(schema).map((field) => [field.path, field]));
const resolve = (columnId: string) => resolveColumnTransformInput({ columnId, schema, fieldsByPath, view });

describe('resolveSchemaTypeAtPath', () => {
  it('reads the JSON type at a DRILLED path, past the connector envelope', () => {
    expect(resolveSchemaTypeAtPath(schema, 'properties.Tags.multi_select')).toBe('array');
    expect(resolveSchemaTypeAtPath(schema, 'properties.Notes.rich_text')).toBe('array');
  });

  it('reads a subfield leaf type', () => {
    expect(resolveSchemaTypeAtPath(schema, 'properties.Status.select.name')).toBe('string');
  });

  it('returns unknown for a missing path', () => {
    expect(resolveSchemaTypeAtPath(schema, 'properties.Nope.gone')).toBe('unknown');
  });
});

describe('resolveColumnTransformInput (dissolves the Notion inner-path mole)', () => {
  it('resolves a drilled rich_text column: toCore from the view display transformer, fromCore from the envelope', () => {
    // The mapping references `properties.Notes.rich_text` (the drilled view path); an exact lookup in the
    // envelope-only flattening would find nothing. The resolver instead finds the view column here AND
    // walks up to the `properties.Notes` envelope for the pack hint.
    const input = resolve('properties.Notes.rich_text');
    expect(input.toCore).toEqual({
      type: 'jsonpath',
      options: { expression: '$[*].plain_text', arrayHandling: 'concat' },
    });
    expect(input.fromCore).toEqual(notesPack);
    expect(input.cardinality).toBe('single'); // concat reduces to one value
    expect(input.logicalType).toBe('richtext');
    expect(input.primitiveType).toBe('array');
  });

  it('resolves a drilled multi_select column with no codec: multi from the native array shape', () => {
    const input = resolve('properties.Tags.multi_select');
    expect(input.toCore).toBeUndefined();
    expect(input.fromCore).toBeUndefined();
    expect(input.primitiveType).toBe('array');
    expect(input.cardinality).toBe('multi'); // no declared toCore → native array shape is honest here
    expect(input.logicalType).toBe('object');
  });

  it('resolves a Notion files column as MULTI via its notion_file_url extract (arrayHandling: array)', () => {
    const input = resolve('properties.Files.files');
    expect(input.toCore).toEqual(filesUnpack);
    expect(input.cardinality).toBe('multi'); // notion_file_url emits multiple file URLs, not one value
  });

  it('resolves a selected-subfield leaf: pack hint via ancestor-walk to the envelope', () => {
    const input = resolve('properties.Status.select.name');
    expect(input.fromCore).toEqual(statusPack); // walked up from the subfield leaf to properties.Status
    expect(input.primitiveType).toBe('string');
    expect(input.logicalType).toBe('string'); // from the subfield's own type
    expect(input.cardinality).toBe('single');
  });

  it("prefers a column's explicit logicalType over its render type (Attio-style text-rendered number)", () => {
    // A display-transformer column renders as text (`type:'string'`) but declares its
    // real semantic type in `logicalType`; the export layer must read THAT (DEV-11040).
    const numberSchema = {
      type: 'object',
      properties: { values: { type: 'object', properties: { amount: { type: 'array', items: { type: 'object' } } } } },
    } as unknown as TSchema;
    const numberView: TableView = {
      name: 'default',
      cols: [
        {
          kind: 'col',
          path: 'values.amount',
          name: 'Amount',
          type: 'string', // grid renders text so it consults the displayTransformer
          logicalType: 'number', // ...but the flattened value is really a number
          displayTransformer: { type: 'jsonpath', options: { expression: '$[0].value', arrayHandling: 'first' } },
        },
      ],
    };
    const input = resolveColumnTransformInput({
      columnId: 'values.amount',
      schema: numberSchema,
      fieldsByPath: new Map(extractSchemaFields(numberSchema).map((field) => [field.path, field])),
      view: numberView,
    });
    expect(input.logicalType).toBe('number');
  });
});

describe('columnTransformInputFromSchemaField (destination side)', () => {
  it('builds a single-valued input carrying the pack hint and primitive type', () => {
    const destField: SchemaField = { path: 'Bio', type: 'string', suggestedInTransformer: notesPack };
    expect(columnTransformInputFromSchemaField(destField)).toEqual({
      cardinality: 'single',
      primitiveType: 'string',
      logicalType: 'string',
      fromCore: notesPack,
    });
  });

  it('is MULTI for a raw native-array field with no pack (e.g. an Airtable options field)', () => {
    const destField: SchemaField = { path: 'Categories', type: 'array' };
    expect(columnTransformInputFromSchemaField(destField)).toEqual({
      cardinality: 'multi',
      primitiveType: 'array',
      logicalType: 'array',
    });
  });

  it('propagates the declared pack input primitive (fromCoreInputType) from the schema field (DEV-10952)', () => {
    const destField: SchemaField = {
      path: 'Notes',
      type: 'object', // Notion property envelope
      suggestedInTransformer: notesPack,
      suggestedInTransformerInputType: 'string',
    };
    expect(columnTransformInputFromSchemaField(destField)).toEqual({
      cardinality: 'single',
      primitiveType: 'object',
      logicalType: 'object',
      fromCore: notesPack,
      fromCoreInputType: 'string',
    });
  });

  it('handles an undefined destination field', () => {
    expect(columnTransformInputFromSchemaField(undefined)).toEqual({ cardinality: 'single' });
  });
});

describe('end-to-end: a fancy Notion rich_text SOURCE into two Airtable destinations', () => {
  const richTextSource = resolve('properties.Notes.rich_text'); // toCore concat → single string
  const concat: TransformerConfig = {
    type: 'jsonpath',
    options: { expression: '$[*].plain_text', arrayHandling: 'concat' },
  };

  it('→ a raw Airtable TEXT field (single): no middle, no floor — just the extract', () => {
    const destText = columnTransformInputFromSchemaField({ path: 'Bio', type: 'string' });
    const suggestion = getSuggestedTransform(richTextSource, destText);
    expect(suggestion.result === 'valid' && suggestion.options[0].transformerChain).toEqual([concat]);
  });

  it('→ a raw Airtable OPTIONS field (string[]): the middle wrap IS needed (string → string[])', () => {
    const destOptions = columnTransformInputFromSchemaField({ path: 'Categories', type: 'array' });
    const suggestion = getSuggestedTransform(richTextSource, destOptions);
    expect(suggestion.result === 'valid' && suggestion.options[0].transformerChain).toEqual([
      concat,
      { type: 'auto_convert', options: { targetType: 'array' } },
    ]);
  });

  it('collapses a Notion FILES array into an Airtable TEXT field (comma-join, not a raw array)', () => {
    // Regression: a files column resolves to MULTI, so the multi→single middle joins the URLs into a
    // string instead of dumping a raw array that a text field rejects ("cannot accept the provided value").
    const filesSource = resolve('properties.Files.files');
    const destText = columnTransformInputFromSchemaField({ path: 'Files', type: 'string' });
    const suggestion = getSuggestedTransform(filesSource, destText);
    expect(suggestion.result === 'valid' && suggestion.options[0].transformerChain).toEqual([
      filesUnpack,
      { type: 'auto_convert', options: { targetType: 'string' } },
    ]);
  });
});
