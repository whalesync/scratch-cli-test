import type { CreateFieldType, TableView } from '@spinner/shared-types';
import { applyDisplayTransformer } from '@spinner/shared-types/transform';
import { selectPlanFieldsFromTableView } from 'src/schema-builder/schema-builder-field-selection';
import { inferLogicalFieldType } from 'src/schema-builder/schema-builder-plan-generator';
import { EntityId } from '../../../types';
import { buildAirtableCreateField } from '../../airtable/airtable-create-schema';
import { buildStripeDefaultView } from '../stripe-default-view';
import { buildStripeJsonTableSpec } from '../stripe-json-schema';
import { StripeEntityType } from '../stripe-types';

/**
 * End-to-end Live Export coverage for Stripe: what a user actually ends up with on a destination.
 *
 * The unit specs check each layer in isolation; this one walks the whole chain the export takes —
 * default view → plan field selection → logical field type → the destination pack's native field —
 * because every Stripe Live Export bug in this batch was a seam between two of those layers rather
 * than a fault inside any one of them (DEV-11145, DEV-11147, DEV-11148, DEV-11149).
 */

function specFor(entityType: StripeEntityType) {
  const id = { wsId: entityType, remoteId: [entityType] } as unknown as EntityId;
  return buildStripeJsonTableSpec(id, entityType);
}

function viewFor(entityType: StripeEntityType): TableView {
  return buildStripeDefaultView(specFor(entityType).schema, entityType);
}

/** Every path the plan would propose as a destination field — i.e. what the user is offered. */
function exportedPaths(entityType: StripeEntityType): string[] {
  const spec = specFor(entityType);
  return selectPlanFieldsFromTableView({
    schema: spec.schema,
    view: viewFor(entityType),
    titlePath: spec.titlePath,
    idPath: spec.idPath,
  }).schemaFields.map((field) => field.path);
}

/** The create-field type the schema builder would give this column's destination field. */
function createFieldTypeFor(entityType: StripeEntityType, path: string): CreateFieldType {
  const spec = specFor(entityType);
  const { schemaFields, viewTypeByPath } = selectPlanFieldsFromTableView({
    schema: spec.schema,
    view: viewFor(entityType),
    titlePath: spec.titlePath,
    idPath: spec.idPath,
  });
  const field = schemaFields.find((candidate) => candidate.path === path);
  if (!field) throw new Error(`No plan field at ${path} — it is not offered for export`);
  return inferLogicalFieldType(field, viewTypeByPath[path], 'Stripe').fieldType;
}

/** The native Airtable field the destination pack would create for a column. */
function airtableFieldFor(entityType: StripeEntityType, path: string) {
  const built = buildAirtableCreateField(
    { name: path, fieldType: createFieldTypeFor(entityType, path) },
    { baseId: 'appBASE' },
  );
  if ('skip' in built) throw new Error(`Airtable skipped ${path}: ${built.skip}`);
  return built.field;
}

// ── DEV-11145 ──
describe('Unix-epoch timestamps reach a destination as real dates', () => {
  it('creates a time-bearing date field, not a number', () => {
    // The whole point: `created` used to land as a number column holding 1785436554.
    expect(createFieldTypeFor('customers', 'created')).toEqual({ kind: 'date', includesTime: true });
  });

  it('becomes an Airtable dateTime column that keeps the time of day', () => {
    const field = airtableFieldFor('customers', 'created');

    expect(field.type).toBe('dateTime');
  });

  it('reports the field as cleanly mapped, with no downgrade warning', () => {
    const spec = specFor('customers');
    const { schemaFields, viewTypeByPath } = selectPlanFieldsFromTableView({
      schema: spec.schema,
      view: viewFor('customers'),
      titlePath: spec.titlePath,
      idPath: spec.idPath,
    });
    const created = schemaFields.find((field) => field.path === 'created');
    if (!created) throw new Error('created is not offered for export');

    expect(inferLogicalFieldType(created, viewTypeByPath['created'], 'Stripe').status).toBe('mapped');
  });

  it('renders the raw epoch as a date in the grid', () => {
    const created = viewFor('customers').cols.find((c) => c.kind === 'col' && c.path === 'created');
    const displayTransformer = created?.kind === 'col' ? created.displayTransformer : undefined;
    if (!displayTransformer) throw new Error('created has no display transformer');

    expect(applyDisplayTransformer(displayTransformer, 1785436554)).toEqual({
      ok: true,
      value: '2026-07-30T18:35:54.000Z',
    });
  });

  it('leaves an ordinary number field as a number', () => {
    expect(createFieldTypeFor('customers', 'balance')).toEqual({ kind: 'number' });
  });
});

// ── DEV-11148 ──
describe('fields that used to be dropped are now offered for export', () => {
  it('exports a customer address as one destination field per subfield', () => {
    const paths = exportedPaths('customers');

    expect(paths).toEqual(expect.arrayContaining(['address.city', 'address.line1', 'address.postal_code']));
    // The raw container stays hidden, so it is NOT proposed as a duplicate field.
    expect(paths).not.toContain('address');
  });

  it('exports a nested shipping address', () => {
    expect(exportedPaths('customers')).toEqual(
      expect.arrayContaining(['shipping.name', 'shipping.address.city', 'shipping.address.line1']),
    );
  });

  it('exports charge billing details', () => {
    expect(exportedPaths('charges')).toEqual(
      expect.arrayContaining(['billing_details.email', 'billing_details.address.city']),
    );
  });

  it('exports product images and subscription items rather than dropping them silently', () => {
    expect(exportedPaths('products')).toContain('images');
    expect(exportedPaths('subscriptions')).toContain('items');
  });

  it('creates address subfields as ordinary text columns', () => {
    expect(createFieldTypeFor('customers', 'address.city')).toEqual({ kind: 'text' });
  });

  it('warns rather than silently dropping when a list can only ride through as text', () => {
    const spec = specFor('products');
    const { schemaFields, viewTypeByPath } = selectPlanFieldsFromTableView({
      schema: spec.schema,
      view: viewFor('products'),
      titlePath: spec.titlePath,
      idPath: spec.idPath,
    });
    const images = schemaFields.find((field) => field.path === 'images');
    if (!images) throw new Error('images is not offered for export');
    const inferred = inferLogicalFieldType(images, viewTypeByPath['images'], 'Stripe');

    expect(inferred.status).toBe('downgraded');
    expect(inferred.fieldType).toEqual({ kind: 'text' });
  });

  it('still keeps genuine plumbing out of the export', () => {
    const paths = exportedPaths('customers');

    expect(paths).not.toContain('object');
    expect(paths).not.toContain('livemode');
    expect(paths).not.toContain('metadata');
  });
});

// ── DEV-11149 ──
describe('prices.recurring exports a real interval column, not raw JSON', () => {
  it('proposes the plucked subfield path instead of the container', () => {
    const paths = exportedPaths('prices');

    expect(paths).toContain('recurring.interval');
    expect(paths).not.toContain('recurring');
  });

  it('creates it as text rather than downgrading an object to a JSON blob', () => {
    expect(createFieldTypeFor('prices', 'recurring.interval')).toEqual({ kind: 'text' });
  });
});

// ── DEV-11147 ──
describe('multi-line text survives the Airtable destination pack', () => {
  it('creates a Stripe description as multilineText, which preserves newlines', () => {
    // `singleLineText` silently collapses newlines and tabs to spaces.
    expect(airtableFieldFor('customers', 'description').type).toBe('multilineText');
  });
});
