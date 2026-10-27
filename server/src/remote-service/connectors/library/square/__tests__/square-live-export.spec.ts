import type { CreateFieldType, TableView, TableViewCol } from '@spinner/shared-types';
import { selectPlanFieldsFromTableView } from 'src/schema-builder/schema-builder-field-selection';
import { inferLogicalFieldType } from 'src/schema-builder/schema-builder-plan-generator';
import { EntityId } from '../../../types';
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
