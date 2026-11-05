import { Type, type TSchema } from '@sinclair/typebox';
import {
  getSuggestedTransform,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  type CreateFieldType,
  type TableView,
  type TableViewCol,
  type TransformerConfig,
} from '@spinner/shared-types';
import { Service } from 'src/remote-service/connectors/service-constants';
import { selectPlanFieldsFromTableView } from 'src/schema-builder/schema-builder-field-selection';
import {
  inferLogicalFieldType,
  type DestinationFieldTypeSupport,
} from 'src/schema-builder/schema-builder-plan-generator';
import {
  columnTransformInputFromSchemaField,
  resolveColumnTransformInput,
} from 'src/sync/resolve-column-transform-input';
import { applyTransformerPipeline, createNullLookupTools } from 'src/sync/transformers';
import { extractSchemaFields, type SchemaField } from 'src/utils/schema-helpers';
import { EntityId } from '../../../types';
import { AIRTABLE_SCHEMA_CREATION_CAPABILITIES } from '../../airtable/airtable-create-schema';
import { POSTGRES_SCHEMA_CREATION_CAPABILITIES } from '../../pg-common/pg-create-schema';
import { mapPgType } from '../../pg-common/pg-type-mapping';
import { buildSquareDefaultView } from '../square-default-view';
import { buildSquareJsonTableSpec } from '../square-json-schema';
import { SQUARE_ENTITY_TYPES, SquareEntityType } from '../square-types';

/**
 * End-to-end Live Export coverage for Square: what a user actually ends up with on a destination.
 *
 * Walks the whole chain an export takes — record schema → default view → plan field selection →
 * the destination field type — because Live Export bugs live in the seams between those layers
 * (see the Stripe equivalent, stripe-live-export.spec.ts).
 */

function specFor(entityType: SquareEntityType) {
  const id = { wsId: entityType, remoteId: [entityType] } as unknown as EntityId;
  return buildSquareJsonTableSpec(id, entityType, 'production');
}

function viewFor(entityType: SquareEntityType): TableView {
  return buildSquareDefaultView(specFor(entityType).schema, entityType);
}

function viewCols(entityType: SquareEntityType): TableViewCol[] {
  return viewFor(entityType).cols.filter((col): col is TableViewCol => col.kind === 'col');
}

function planSelection(entityType: SquareEntityType) {
  const spec = specFor(entityType);
  return selectPlanFieldsFromTableView({
    schema: spec.schema,
    view: viewFor(entityType),
    titlePath: spec.titlePath,
    idPath: spec.idPath,
  });
}

/** The create-field type the schema builder gives a column's destination field. */
function createFieldTypeFor(entityType: SquareEntityType, path: string): CreateFieldType {
  const { schemaFields, viewTypeByPath } = planSelection(entityType);
  const field = schemaFields.find((candidate) => candidate.path === path);
  if (!field) throw new Error(`No plan field at ${path} — it is not offered for export`);
  return inferLogicalFieldType(field, viewTypeByPath[path], 'Square').fieldType;
}

function exportedPaths(entityType: SquareEntityType): string[] {
  return planSelection(entityType).schemaFields.map((field) => field.path);
}

/** The create-field type a destination with this JSON / list column support gives a column's field. */
function createFieldTypeOnDestination(
  entityType: SquareEntityType,
  path: string,
  destinationFieldTypeSupport: DestinationFieldTypeSupport,
): CreateFieldType {
  const { schemaFields, viewTypeByPath } = planSelection(entityType);
  const field = schemaFields.find((candidate) => candidate.path === path);
  if (!field) throw new Error(`No plan field at ${path} — it is not offered for export`);
  return inferLogicalFieldType(field, viewTypeByPath[path], 'Square', destinationFieldTypeSupport).fieldType;
}

const POSTGRES_FIELD_TYPE_SUPPORT: DestinationFieldTypeSupport = {
  supportedFieldKinds: POSTGRES_SCHEMA_CREATION_CAPABILITIES.supportedFieldKinds,
  supportedArrayElementKinds: POSTGRES_SCHEMA_CREATION_CAPABILITIES.supportedArrayElementKinds,
};

const AIRTABLE_FIELD_TYPE_SUPPORT: DestinationFieldTypeSupport = {
  supportedFieldKinds: AIRTABLE_SCHEMA_CREATION_CAPABILITIES.supportedFieldKinds,
  supportedArrayElementKinds: AIRTABLE_SCHEMA_CREATION_CAPABILITIES.supportedArrayElementKinds,
};

/** The destination schema field for a single column with this schema. */
function destinationFieldWithSchema(columnName: string, columnSchema: TSchema): SchemaField {
  const [field] = extractSchemaFields(Type.Object({ [columnName]: columnSchema }));
  return field;
}

/** A Postgres `jsonb` column's field, as the Postgres connector reports it after creating the column. */
function postgresJsonbDestinationField(columnName: string): SchemaField {
  const { schema, pgType } = mapPgType('jsonb', 'jsonb', true);
  return destinationFieldWithSchema(columnName, { ...schema, [X_SCRATCH_CONNECTOR_DATA_TYPE]: pgType } as TSchema);
}

/** The transformer chain Live Export stores for copying a Square column into this destination column. */
function transformerChainInto(
  entityType: SquareEntityType,
  sourcePath: string,
  destinationField: SchemaField,
): TransformerConfig[] {
  const spec = specFor(entityType);
  const sourceFieldsByPath = new Map(extractSchemaFields(spec.schema).map((field) => [field.path, field]));
  const suggestion = getSuggestedTransform(
    resolveColumnTransformInput({
      columnId: sourcePath,
      schema: spec.schema,
      fieldsByPath: sourceFieldsByPath,
      view: viewFor(entityType),
    }),
    columnTransformInputFromSchemaField(destinationField),
  );
  if (suggestion.result !== 'valid') throw new Error(suggestion.reason);
  return suggestion.options[0].transformerChain;
}

/** Run a stored transformer chain on one source value, the way a sync does. */
async function runTransformerChain(transformerChain: TransformerConfig[], sourceValue: unknown): Promise<unknown> {
  const result = await applyTransformerPipeline(transformerChain, sourceValue, {
    sourceRecord: { id: 'r', filePath: 'r.json', fields: {} },
    sourceFieldPath: 'field',
    sourceTableSpec: null,
    sourceService: Service.SQUARE,
    destinationFieldPath: 'field',
    destinationTableSpec: null,
    destinationService: Service.AIRTABLE,
    lookupTools: createNullLookupTools(),
    phase: 'DATA',
  });
  if (!result.success) throw new Error(`transform failed: ${result.error}`);
  return result.value;
}

describe('every Square table', () => {
  it.each(SQUARE_ENTITY_TYPES)('%s offers its id and at least a handful of fields', (entityType) => {
    expect(exportedPaths(entityType)).toContain('id');
    expect(exportedPaths(entityType).length).toBeGreaterThan(5);
  });

  // Destinations reject duplicate field names, so a clash would fail table creation outright.
  it.each(SQUARE_ENTITY_TYPES)('%s has unique column names', (entityType) => {
    const names = viewCols(entityType).map((col) => col.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(SQUARE_ENTITY_TYPES)('%s columns are all read-only and typed for export', (entityType) => {
    for (const col of viewCols(entityType)) {
      expect(col.readonly).toBe(true);
      expect(col.logicalType).toBeDefined();
    }
  });
});

describe('timestamps', () => {
  it('reach a destination as date-times that keep the time of day', () => {
    expect(createFieldTypeFor('payments', 'created_at')).toEqual({ kind: 'date', includesTime: true });
    expect(createFieldTypeFor('orders', 'closed_at')).toEqual({ kind: 'date', includesTime: true });
  });

  it('keeps a calendar date date-only', () => {
    expect(createFieldTypeFor('payouts', 'arrival_date')).toMatchObject({ kind: 'date' });
    expect(createFieldTypeFor('payouts', 'arrival_date')).not.toMatchObject({ includesTime: true });
  });
});

describe('money', () => {
  // Square's Money is `{ amount, currency }` with the amount in the smallest currency unit. Left
  // whole it would export as a blob of JSON text; split, it is a queryable number plus a code.
  it('splits into a numeric amount and a currency code', () => {
    expect(createFieldTypeFor('orders', 'total_money.amount')).toEqual({ kind: 'number' });
    expect(createFieldTypeFor('orders', 'total_money.currency')).toEqual({ kind: 'text' });
    expect(exportedPaths('orders')).not.toContain('total_money');
  });

  it('names the parts after the money field', () => {
    const names = viewCols('payments').map((col) => col.name);
    expect(names).toEqual(expect.arrayContaining(['Amount Money (Amount)', 'Amount Money (Currency)']));
  });

  it('expands money nested in a catalog variation (its price)', () => {
    expect(createFieldTypeFor('catalog_item_variations', 'item_variation_data.price_money.amount')).toEqual({
      kind: 'number',
    });
  });
});

describe('catalog tables', () => {
  it('expose the object’s own fields by their own names', () => {
    const nameColumn = viewCols('catalog_items').find((col) => col.path === 'item_data.name');
    expect(nameColumn?.name).toBe('Name');
    expect(viewCols('catalog_items')[0].path).toBe('item_data.name');
  });

  it('hide the constant catalog `type`', () => {
    expect(exportedPaths('catalog_items')).not.toContain('type');
  });
});

describe('relations', () => {
  it('declare top-level links as single-valued foreign keys', () => {
    const locationField = planSelection('payments').schemaFields.find((field) => field.path === 'location_id');
    expect(locationField?.foreignKey).toMatchObject({ linkedTableId: 'locations', isSingleValued: true });
  });

  it.each([
    ['catalog_item_variations', 'item_variation_data.item_id', 'catalog_items'],
    ['catalog_items', 'item_data.reporting_category.id', 'catalog_categories'],
    ['invoices', 'primary_recipient.customer_id', 'customers'],
  ] as const)('declare the nested link %s.%s → %s', (entityType, path, linkedTableId) => {
    const field = planSelection(entityType).schemaFields.find((candidate) => candidate.path === path);
    expect(field?.foreignKey).toMatchObject({ linkedTableId, isSingleValued: true });
  });
});

describe('plumbing', () => {
  it('is hidden from export', () => {
    expect(exportedPaths('orders')).not.toContain('version');
    expect(exportedPaths('payments')).not.toContain('version_token');
  });

  it('keeps the raw container of an expanded object hidden rather than dropping it', () => {
    const rawAmountColumn = viewCols('payments').find((col) => col.path === 'amount_money');
    expect(rawAmountColumn?.hidden).toBe(true);
  });
});

// Square nests sub-records as arrays of objects: an order's line items, taxes, and tenders, a payment's
// processing fees, an invoice's payment requests. Fever exports orders to Supabase to answer "tickets sold"
// over SQL, and those live in `line_items` (DEV-12572).
describe('arrays of objects', () => {
  const ARRAY_OF_OBJECTS_COLUMNS = [
    ['orders', 'line_items'],
    ['orders', 'taxes'],
    ['orders', 'discounts'],
    ['orders', 'tenders'],
    ['orders', 'fulfillments'],
    ['orders', 'returns'],
    ['payments', 'processing_fee'],
    ['invoices', 'payment_requests'],
  ] as const;

  const threeLineItems = [
    { uid: 'li-1', name: 'fable_qa Printed Programme', quantity: '1' },
    { uid: 'li-2', name: 'fable_qa Candlelight: Vivaldi’s Four Seasons', quantity: '2' },
    { uid: 'li-3', name: 'fable_qa 東京 Jazz Night — 日本語', quantity: '1' },
  ];

  it.each(ARRAY_OF_OBJECTS_COLUMNS)('creates %s.%s as a json column on Postgres and Supabase', (entityType, path) => {
    expect(createFieldTypeOnDestination(entityType, path, POSTGRES_FIELD_TYPE_SUPPORT)).toEqual({ kind: 'json' });
  });

  it.each(ARRAY_OF_OBJECTS_COLUMNS)('copies %s.%s into a jsonb column whole', (entityType, path) => {
    expect(transformerChainInto(entityType, path, postgresJsonbDestinationField(path))).toEqual([]);
  });

  it.each(ARRAY_OF_OBJECTS_COLUMNS)(
    'flattens %s.%s to text on a destination with no JSON column',
    (entityType, path) => {
      expect(createFieldTypeOnDestination(entityType, path, AIRTABLE_FIELD_TYPE_SUPPORT)).toEqual({ kind: 'text' });
    },
  );

  it('writes the line items into a text column as one JSON array, not comma-joined fragments', async () => {
    const transformerChain = transformerChainInto(
      'orders',
      'line_items',
      destinationFieldWithSchema('line_items', Type.String()),
    );

    const textWritten = await runTransformerChain(transformerChain, threeLineItems);

    expect(typeof textWritten).toBe('string');
    expect(JSON.parse(textWritten as string)).toEqual(threeLineItems);
  });
});
