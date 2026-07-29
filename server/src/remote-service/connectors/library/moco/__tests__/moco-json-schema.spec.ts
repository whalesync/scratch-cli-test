import { TObject } from '@sinclair/typebox';
import { X_SCRATCH_FOREIGN_KEY_OPTIONS, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { buildMocoJsonTableSpec } from '../moco-json-schema';
import { MocoEntityType } from '../moco-types';

function schemaFor(entityType: MocoEntityType): TObject {
  return buildMocoJsonTableSpec({ wsId: entityType, remoteId: [entityType] }, entityType).schema as TObject;
}

function propsFor(entityType: MocoEntityType): Record<string, Record<string, unknown>> {
  return schemaFor(entityType).properties as unknown as Record<string, Record<string, unknown>>;
}

function allowsNull(field: Record<string, unknown>): boolean {
  const anyOf = field.anyOf as Array<{ type?: unknown }> | undefined;
  return Array.isArray(anyOf) && anyOf.some((member) => member.type === 'null');
}

// A verbatim Moco GET leaves optional fields null and never lets the user satisfy a
// read-only field, so the generated schema must (a) never require a read-only field and
// (b) accept null for optional fields. (DEV-10453)
describe('buildMocoJsonTableSpec — read-only fields are never required', () => {
  it('companies require only the writable create-mandatory fields', () => {
    const required = [...(schemaFor('companies').required ?? [])].sort();
    expect(required).toEqual(['name', 'type']);
  });

  it('contacts require only the writable create-mandatory fields', () => {
    const required = [...(schemaFor('contacts').required ?? [])].sort();
    expect(required).toEqual(['gender', 'lastname']);
  });

  it('projects require name but not read-only or now-nullable date fields', () => {
    const required = schemaFor('projects').required ?? [];
    expect(required).toContain('name');
    for (const excluded of ['id', 'created_at', 'updated_at', 'start_date', 'finish_date']) {
      expect(required).not.toContain(excluded);
    }
  });
});

describe('buildMocoJsonTableSpec — schema matches verbatim data', () => {
  it('adds the previously-missing Company fields with the right nullability', () => {
    const companies = propsFor('companies');
    expect(companies.active).toBeDefined();
    expect(allowsNull(companies.invoice_format)).toBe(true);
    expect(allowsNull(companies.default_payment_means)).toBe(true);
    expect(allowsNull(companies.archived_on)).toBe(true);
    expect(companies.archived_on[X_SCRATCH_READONLY]).toBe(true);
  });

  it('makes Project start_date/finish_date optional + nullable', () => {
    const projects = propsFor('projects');
    expect(allowsNull(projects.start_date)).toBe(true);
    expect(allowsNull(projects.finish_date)).toBe(true);
  });

  it('sweeps non-nullable optional fields to nullable unions', () => {
    const companies = propsFor('companies');
    expect(allowsNull(companies.labels)).toBe(true);
    expect(allowsNull(companies.tags)).toBe(true);
    expect(allowsNull(companies.billing_tax)).toBe(true);
  });

  it('keeps description + x-scratch annotations on a swept read-only foreign-key field', () => {
    const company = propsFor('contacts').company;
    expect(allowsNull(company)).toBe(true);
    expect(company[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({
      linkedTableId: 'companies',
      linkedTableRemoteId: ['companies'],
    });
    expect(company[X_SCRATCH_READONLY]).toBe(true);
  });

  it('does NOT make always-present read-only timestamps nullable', () => {
    const updatedAt = propsFor('companies').updated_at;
    expect(updatedAt.type).toBe('string');
    expect(updatedAt.anyOf).toBeUndefined();
    expect(updatedAt[X_SCRATCH_READONLY]).toBe(true);
  });
});
