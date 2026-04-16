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

// ─────────────────────────────────────────────────────────────────────────────
// Supabase — covers anyOf nullable unions with nested `format`, foreign keys.
// ─────────────────────────────────────────────────────────────────────────────
describe('buildColumnDefinitions — supabase deals', () => {
  const columns = buildColumnDefinitions(loadFixture('supabase-deals.schema.json'));

  it('emits exactly 9 columns in schema order', () => {
    expect(columns.map((c) => c.id)).toEqual([
      'id',
      'created_at',
      'name',
      'status',
      'priority',
      'notes',
      'close_date',
      'client_id',
      'company_id',
    ]);
  });

  it('normalizes direct scalar types', () => {
    expect(byId(columns, 'id').dataType).toBe('number');
    expect(byId(columns, 'created_at').dataType).toBe('string');
  });

  it('resolves anyOf nullable unions to their non-null member type', () => {
    expect(byId(columns, 'name').dataType).toBe('string');
    expect(byId(columns, 'priority').dataType).toBe('number');
    expect(byId(columns, 'close_date').dataType).toBe('string');
    expect(byId(columns, 'client_id').dataType).toBe('number');
  });

  it('promotes format from anyOf members when the outer prop has none', () => {
    // `close_date` carries `format: date-time` only inside its anyOf member.
    expect(byId(columns, 'close_date').format).toBe('date-time');
    // `created_at` declares `format` directly at the outer level.
    expect(byId(columns, 'created_at').format).toBe('date-time');
  });

  it('flags x-scratch-readonly fields', () => {
    expect(byId(columns, 'id').attributes.readOnly).toBe(true);
    expect(byId(columns, 'created_at').attributes.readOnly).toBe(true);
    expect(byId(columns, 'name').attributes.readOnly).toBe(false);
  });

  it('marks only top-level required members', () => {
    expect(byId(columns, 'id').attributes.required).toBe(true);
    expect(byId(columns, 'name').attributes.required).toBe(false);
  });

  it('parses foreign key targets declared alongside anyOf unions', () => {
    expect(byId(columns, 'client_id').attributes.foreignKey).toEqual({ linkedTableId: 'Clients' });
    expect(byId(columns, 'company_id').attributes.foreignKey).toEqual({ linkedTableId: 'companies' });
  });

  it('captures connector data types at the outer property level', () => {
    expect(byId(columns, 'id').attributes.connectorDataType).toBe('numeric');
    expect(byId(columns, 'created_at').attributes.connectorDataType).toBe('timestamp');
    expect(byId(columns, 'name').attributes.connectorDataType).toBe('text');
    expect(byId(columns, 'close_date').attributes.connectorDataType).toBe('timestamp');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Moco — covers anyOf enum-via-const, object leaves with x-scratch metadata,
// patternProperties-only objects, arrays.
// ─────────────────────────────────────────────────────────────────────────────
describe('buildColumnDefinitions — moco contacts', () => {
  const columns = buildColumnDefinitions(loadFixture('moco-contacts.schema.json'));

  it('emits exactly the 24 top-level properties in order', () => {
    expect(columns.map((c) => c.id)).toEqual([
      'id',
      'gender',
      'firstname',
      'lastname',
      'title',
      'job_position',
      'mobile_phone',
      'work_phone',
      'work_email',
      'work_fax',
      'work_address',
      'home_address',
      'home_email',
      'home_phone',
      'birthday',
      'salutation',
      'info',
      'avatar_url',
      'tags',
      'custom_properties',
      'company',
      'user',
      'created_at',
      'updated_at',
    ]);
  });

  it('resolves anyOf-of-consts (enum-style) to a scalar type', () => {
    // `gender` uses anyOf: [{const:'F',type:'string'},{const:'M',type:'string'},{const:'U',type:'string'}]
    expect(byId(columns, 'gender').dataType).toBe('string');
    expect(byId(columns, 'gender').attributes.required).toBe(true);
  });

  it('resolves nullable anyOf unions to their non-null member', () => {
    expect(byId(columns, 'firstname').dataType).toBe('string');
    expect(byId(columns, 'mobile_phone').dataType).toBe('string');
    expect(byId(columns, 'birthday').dataType).toBe('string');
  });

  it('promotes format from nested anyOf members (date, email)', () => {
    expect(byId(columns, 'birthday').format).toBe('date');
    expect(byId(columns, 'work_email').format).toBe('email');
    expect(byId(columns, 'home_email').format).toBe('email');
  });

  it('treats type:object properties with x-scratch-* metadata as leaves', () => {
    // Moco `company` has both readonly and foreign-key extensions and MUST NOT recurse into
    // its nested { id, type, name } subfields.
    const company = byId(columns, 'company');
    expect(company.dataType).toBe('object');
    expect(company.attributes.readOnly).toBe(true);
    expect(company.attributes.foreignKey).toEqual({ linkedTableId: 'companies' });
    expect(company.attributes.nested).toBe(false);
    expect(columns.find((c) => c.id === 'company.id')).toBeUndefined();
    expect(columns.find((c) => c.id === 'company.name')).toBeUndefined();

    // `user` has readonly but no foreign key — still a leaf.
    const user = byId(columns, 'user');
    expect(user.dataType).toBe('object');
    expect(user.attributes.readOnly).toBe(true);
    expect(columns.find((c) => c.id === 'user.id')).toBeUndefined();
  });

  it('treats type:object with patternProperties (no .properties) as a leaf', () => {
    const customProps = byId(columns, 'custom_properties');
    expect(customProps.dataType).toBe('object');
    expect(customProps.attributes.nested).toBe(false);
  });

  it('marks top-level required fields correctly', () => {
    // required: ['id', 'gender', 'lastname', 'created_at', 'updated_at']
    expect(byId(columns, 'id').attributes.required).toBe(true);
    expect(byId(columns, 'gender').attributes.required).toBe(true);
    expect(byId(columns, 'lastname').attributes.required).toBe(true);
    expect(byId(columns, 'created_at').attributes.required).toBe(true);
    expect(byId(columns, 'updated_at').attributes.required).toBe(true);
    expect(byId(columns, 'firstname').attributes.required).toBe(false);
    expect(byId(columns, 'company').attributes.required).toBe(false);
  });

  it('recognizes array fields', () => {
    expect(byId(columns, 'tags').dataType).toBe('array');
  });

  it('flags readonly timestamps', () => {
    expect(byId(columns, 'created_at').attributes.readOnly).toBe(true);
    expect(byId(columns, 'updated_at').attributes.readOnly).toBe(true);
    expect(byId(columns, 'created_at').format).toBe('date-time');
    expect(byId(columns, 'updated_at').format).toBe('date-time');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Shopify — covers object-inside-anyOf (nullable object), many flat leaves.
// ─────────────────────────────────────────────────────────────────────────────
describe('buildColumnDefinitions — shopify products', () => {
  const columns = buildColumnDefinitions(loadFixture('shopify-products.schema.json'));

  it('emits a flat list of leaf columns — no recursion into anyOf-wrapped objects', () => {
    expect(columns).toHaveLength(48);
  });

  it('never generates dot-paths for nullable-object fields', () => {
    const dottedIds = columns.map((c) => c.id).filter((id) => id.includes('.'));
    expect(dottedIds).toEqual([]);
  });

  it('preserves schema declaration order for the first and last few columns', () => {
    const ids = columns.map((c) => c.id);
    expect(ids.slice(0, 5)).toEqual([
      'availablePublicationsCount',
      'bodyHtml',
      'category',
      'combinedListing',
      'combinedListingRole',
    ]);
    expect(ids.slice(-5)).toEqual(['totalVariants', 'tracksInventory', 'updatedAt', 'variantsCount', 'vendor']);
  });

  it('resolves a nullable object (anyOf [object, null]) to dataType object', () => {
    const category = byId(columns, 'category');
    expect(category.dataType).toBe('object');
    expect(category.attributes.nested).toBe(false);
    expect(category.format).toBeUndefined();
  });

  it('resolves nullable scalars and arrays through anyOf', () => {
    expect(byId(columns, 'bodyHtml').dataType).toBe('string');
    expect(byId(columns, 'isGiftCard').dataType).toBe('boolean');
    expect(byId(columns, 'totalInventory').dataType).toBe('number');
    expect(byId(columns, 'tags').dataType).toBe('array');
  });

  it('direct scalar types still resolve correctly', () => {
    expect(byId(columns, 'id').dataType).toBe('string');
  });

  it('promotes format from nested anyOf date-time members', () => {
    expect(byId(columns, 'createdAt').format).toBe('date-time');
  });

  it('leaves attributes.readOnly false when no x-scratch-readonly flag is present', () => {
    expect(byId(columns, 'id').attributes.readOnly).toBe(false);
    expect(byId(columns, 'category').attributes.readOnly).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HubSpot — covers the "container" object pattern (recurse into `properties`)
// alongside leaf object with x-scratch metadata (`associations`).
// ─────────────────────────────────────────────────────────────────────────────
describe('buildColumnDefinitions — hubspot companies', () => {
  const columns = buildColumnDefinitions(loadFixture('hubspot-companies.schema.json'));
  const ids = columns.map((c) => c.id);

  it('starts with the top-level id column', () => {
    expect(ids[0]).toBe('id');
    expect(byId(columns, 'id').dataType).toBe('string');
    expect(byId(columns, 'id').attributes.readOnly).toBe(true);
    expect(byId(columns, 'id').attributes.nested).toBe(false);
  });

  it('recurses into the `properties` container because it has no x-scratch metadata', () => {
    const nestedProperty = byId(columns, 'properties.name');
    expect(nestedProperty.dataType).toBe('string');
    expect(nestedProperty.attributes.nested).toBe(true);
    expect(nestedProperty.attributes.connectorDataType).toBe('hubspot/string_text');
    expect(nestedProperty.attributes.remoteFieldId).toBe('name');
  });

  it('emits many nested property columns', () => {
    // Spot-check a handful of hubspot fields that must have been recursed.
    expect(ids).toContain('properties.about_us');
    expect(ids).toContain('properties.name');
    expect(ids).toContain('properties.createdate');
    expect(ids).toContain('properties.hs_object_id');
    expect(ids).toContain('properties.hubspot_owner_id');
    // The recursed fields should be numerous.
    const nestedCount = ids.filter((id) => id.startsWith('properties.')).length;
    expect(nestedCount).toBeGreaterThan(150);
  });

  it('treats `associations` as a leaf object because it carries x-scratch-readonly', () => {
    const associations = byId(columns, 'associations');
    expect(associations.dataType).toBe('object');
    expect(associations.attributes.readOnly).toBe(true);
    expect(associations.attributes.nested).toBe(false);
  });

  it('never generates dot-paths under `associations` (recursion stopped at the leaf)', () => {
    const leakedAssociationIds = ids.filter((id) => id.startsWith('associations.'));
    expect(leakedAssociationIds).toEqual([]);
  });

  it('keeps top-level scalar siblings of `properties` at the top level', () => {
    expect(byId(columns, 'createdAt').dataType).toBe('string');
    expect(byId(columns, 'createdAt').attributes.readOnly).toBe(true);
    expect(byId(columns, 'createdAt').attributes.nested).toBe(false);

    expect(byId(columns, 'updatedAt').dataType).toBe('string');
    expect(byId(columns, 'updatedAt').attributes.readOnly).toBe(true);

    expect(byId(columns, 'archived').dataType).toBe('boolean');
    expect(byId(columns, 'archived').attributes.readOnly).toBe(true);
  });

  it('marks top-level required fields', () => {
    // required: ['id', 'properties', 'createdAt', 'updatedAt', 'archived']
    expect(byId(columns, 'id').attributes.required).toBe(true);
    expect(byId(columns, 'createdAt').attributes.required).toBe(true);
    expect(byId(columns, 'updatedAt').attributes.required).toBe(true);
    expect(byId(columns, 'archived').attributes.required).toBe(true);
    expect(byId(columns, 'associations').attributes.required).toBe(false);
  });
});
