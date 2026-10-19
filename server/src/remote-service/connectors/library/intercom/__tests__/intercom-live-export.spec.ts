import type { CreateFieldType } from '@spinner/shared-types';
import knex, { type Knex } from 'knex';
import { linkedTableIdIndexKeysForRemoteTableId } from 'src/schema-builder/foreign-key-linked-table-id';
import { selectPlanFieldsFromTableView } from 'src/schema-builder/schema-builder-field-selection';
import {
  generateCreatePlanFromSources,
  inferLogicalFieldType,
  type InferredFieldType,
  type PlanGeneratorSource,
} from 'src/schema-builder/schema-builder-plan-generator';
import type { BaseJsonTableSpec } from '../../../types';
import { buildAirtableCreateField } from '../../airtable/airtable-create-schema';
import { buildCreateTableQuery } from '../../pg-common/pg-create-schema';
import { buildIntercomDefaultView } from '../intercom-default-view';
import { buildIntercomCompaniesJsonTableSpec, buildIntercomContactsJsonTableSpec } from '../intercom-json-schema';
import { IntercomDataAttribute } from '../intercom-types';

/**
 * End-to-end Live Export coverage for the read-only Contacts table (DEV-12350): default view → plan
 * field selection → logical field type → the destination's native column.
 *
 * What this guards: custom attributes are the most valuable data on a contact, so each discovered
 * attribute must be OFFERED for export (a hidden column is dropped from the plan entirely) and must
 * keep its real type — a `date` attribute is epoch seconds and must land as a time-bearing date, an
 * attribute with options must land as a select. Both depend on the `custom_attributes` container
 * carrying no `x-scratch-*` key: the schema flattener keeps an annotated object whole, as one opaque
 * leaf, and the per-attribute types and options would never reach the plan.
 */

function contactAttribute(overrides: Partial<IntercomDataAttribute>): IntercomDataAttribute {
  return {
    type: 'data_attribute',
    model: 'contact',
    name: 'attr',
    full_name: 'custom_attributes.attr',
    label: 'attr',
    data_type: 'string',
    custom: true,
    archived: false,
    ...overrides,
  };
}

const CONTACTS_SPEC = buildIntercomContactsJsonTableSpec({ wsId: 'contacts', remoteId: ['contacts'] }, [
  contactAttribute({ name: 'plan_tier', data_type: 'string' }),
  contactAttribute({ name: 'Trial Ends At', data_type: 'date' }),
  contactAttribute({ name: 'priority', data_type: 'string', options: ['high', 'low'] }),
  contactAttribute({ name: 'mrr', data_type: 'float' }),
  contactAttribute({ name: 'is_paying', data_type: 'boolean' }),
]);
const COMPANIES_SPEC = buildIntercomCompaniesJsonTableSpec({ wsId: 'companies', remoteId: ['companies'] }, [
  contactAttribute({ model: 'company', name: 'creation_source', data_type: 'string' }),
  contactAttribute({ model: 'company', name: 'renewal_date', data_type: 'date' }),
  contactAttribute({ model: 'company', name: 'seats', data_type: 'integer' }),
]);

function planFieldSelection(spec: BaseJsonTableSpec = CONTACTS_SPEC) {
  return selectPlanFieldsFromTableView({
    schema: spec.schema,
    view: buildIntercomDefaultView(spec.schema, spec.id.wsId),
    titlePath: spec.titlePath,
    idPath: spec.idPath,
  });
}

/** Every path the plan would propose as a destination field — i.e. what the user is offered. */
function exportedPaths(spec: BaseJsonTableSpec = CONTACTS_SPEC): string[] {
  return planFieldSelection(spec).schemaFields.map((planField) => planField.path);
}

/** The logical field type (and mapping status) the schema builder would give the destination field at `path`. */
function inferredFieldTypeFor(path: string, spec: BaseJsonTableSpec = CONTACTS_SPEC): InferredFieldType {
  const { schemaFields, viewTypeByPath } = planFieldSelection(spec);
  const planField = schemaFields.find((candidate) => candidate.path === path);
  if (!planField) throw new Error(`No plan field at ${path} — it is not offered for export`);
  return inferLogicalFieldType(planField, viewTypeByPath[path], 'Intercom');
}

/** A plan-generator source for an Intercom table, built exactly as the create-schema flow builds it. */
function planGeneratorSourceFor(spec: BaseJsonTableSpec): PlanGeneratorSource {
  const { schemaFields, viewTypeByPath, viewUnpackTransformerByPath } = planFieldSelection(spec);
  return {
    ref: spec.id.wsId,
    dataFolderId: `dfd_${spec.id.wsId}`,
    tableName: spec.name,
    schemaFields,
    primaryFieldPath: spec.titlePath,
    idFieldPath: spec.idPath,
    remoteTableIds: linkedTableIdIndexKeysForRemoteTableId(spec.id.remoteId),
    viewTypeByPath,
    viewUnpackTransformerByPath,
  };
}

function airtableFieldTypeFor(destinationFieldName: string, fieldType: CreateFieldType): string {
  const built = buildAirtableCreateField({ name: destinationFieldName, fieldType }, { baseId: 'appBASE' });
  if ('skip' in built) throw new Error(`Airtable skipped ${destinationFieldName}: ${built.skip}`);
  return built.field.type;
}

// Connection-less Knex: builds the CREATE TABLE a Postgres / Supabase destination would run, with no database.
const postgresQueryBuilder: Knex = knex({ client: 'pg' });

afterAll(async () => {
  await postgresQueryBuilder.destroy();
});

function postgresCreateTableSqlFor(destinationFieldName: string, fieldType: CreateFieldType): string {
  return buildCreateTableQuery(
    postgresQueryBuilder,
    'public',
    'contacts',
    [{ name: destinationFieldName, fieldType }],
    new Map(),
  )
    .toString()
    .toLowerCase();
}

describe('Intercom Contacts in a Live Export plan', () => {
  it('offers every discovered custom attribute', () => {
    expect(exportedPaths()).toEqual(
      expect.arrayContaining([
        'custom_attributes.plan_tier',
        'custom_attributes.Trial Ends At',
        'custom_attributes.priority',
        'custom_attributes.mrr',
        'custom_attributes.is_paying',
      ]),
    );
  });

  it('keeps hidden plumbing and stub lists out of the plan', () => {
    for (const hiddenPath of ['type', 'workspace_id', 'notes', 'companies', 'custom_attributes', 'tags.data']) {
      expect(exportedPaths()).not.toContain(hiddenPath);
    }
  });

  it('types each custom attribute by its Intercom data type', () => {
    expect(inferredFieldTypeFor('custom_attributes.plan_tier').fieldType).toEqual({ kind: 'text' });
    expect(inferredFieldTypeFor('custom_attributes.mrr').fieldType).toEqual({ kind: 'number' });
    expect(inferredFieldTypeFor('custom_attributes.is_paying').fieldType).toEqual({ kind: 'boolean' });
    expect(inferredFieldTypeFor('custom_attributes.priority').fieldType).toEqual({
      kind: 'select',
      options: [{ name: 'high' }, { name: 'low' }],
    });
  });

  it('plans a date custom attribute as a time-bearing date, cleanly mapped', () => {
    expect(inferredFieldTypeFor('custom_attributes.Trial Ends At')).toEqual({
      status: 'mapped',
      fieldType: { kind: 'date', includesTime: true },
    });
  });

  it('lands a date custom attribute as an Airtable dateTime and a Postgres / Supabase timestamptz', () => {
    const { fieldType } = inferredFieldTypeFor('custom_attributes.Trial Ends At');

    expect(airtableFieldTypeFor('Trial Ends At', fieldType)).toBe('dateTime');
    expect(postgresCreateTableSqlFor('Trial Ends At', fieldType)).toContain('"trial ends at" timestamptz');
  });

  it.each(['created_at', 'updated_at', 'signed_up_at', 'last_seen_at', 'last_contacted_at'])(
    'plans the built-in %s as a time-bearing date',
    (path) => {
      expect(inferredFieldTypeFor(path).fieldType).toEqual({ kind: 'date', includesTime: true });
    },
  );

  it('plans role as a select of user | lead', () => {
    expect(inferredFieldTypeFor('role').fieldType).toEqual({
      kind: 'select',
      options: [{ name: 'user' }, { name: 'lead' }],
    });
  });
});

describe('Intercom Companies in a Live Export plan', () => {
  it('offers the company fields, the plan name and the discovered custom attributes', () => {
    expect(exportedPaths(COMPANIES_SPEC)).toEqual(
      expect.arrayContaining([
        'name',
        'company_id',
        'website',
        'industry',
        'plan.name',
        'size',
        'user_count',
        'monthly_spend',
        'tags',
        'custom_attributes.creation_source',
        'custom_attributes.renewal_date',
        'custom_attributes.seats',
      ]),
    );
    for (const hiddenPath of ['type', 'app_id', 'segments', 'plan', 'plan.id', 'custom_attributes']) {
      expect(exportedPaths(COMPANIES_SPEC)).not.toContain(hiddenPath);
    }
  });

  it.each(['created_at', 'updated_at', 'remote_created_at', 'last_request_at', 'custom_attributes.renewal_date'])(
    'plans %s as a time-bearing date',
    (path) => {
      expect(inferredFieldTypeFor(path, COMPANIES_SPEC).fieldType).toEqual({ kind: 'date', includesTime: true });
    },
  );

  it('plans numbers as numbers and the plan name and tags as text', () => {
    for (const path of ['size', 'user_count', 'session_count', 'monthly_spend', 'custom_attributes.seats']) {
      expect(inferredFieldTypeFor(path, COMPANIES_SPEC).fieldType).toEqual({ kind: 'number' });
    }
    expect(inferredFieldTypeFor('plan.name', COMPANIES_SPEC).fieldType).toEqual({ kind: 'text' });
    expect(inferredFieldTypeFor('tags', COMPANIES_SPEC).fieldType).toEqual({ kind: 'text' });
  });
});

describe('Contact → Companies link in a Live Export plan', () => {
  it('declares the Companies column as a foreign key into the Companies table', () => {
    const companiesField = planFieldSelection().schemaFields.find((field) => field.path === 'companies.data');
    expect(companiesField?.foreignKey).toEqual({ linkedTableId: 'companies', linkedTableRemoteId: ['companies'] });
    expect(planFieldSelection().viewUnpackTransformerByPath['companies.data']).toEqual({
      type: 'jsonpath',
      options: { expression: '$[*].id', arrayHandling: 'array' },
    });
  });

  it('becomes a link to the exported Companies table when both tables are exported', () => {
    const { tables } = generateCreatePlanFromSources({
      sources: [planGeneratorSourceFor(CONTACTS_SPEC), planGeneratorSourceFor(COMPANIES_SPEC)],
      destinationConnectorAccountId: 'coa_destination',
    });

    const companiesLink = tables
      .find((table) => table.ref === 'contacts')
      ?.fields.find((field) => field.name === 'Companies');
    expect(companiesLink?.fieldType).toEqual({ kind: 'foreignKey', target: { ref: 'companies' } });
  });

  it('waits for a target when Companies is not part of the export (never silently dropped)', () => {
    const { tables, notes } = generateCreatePlanFromSources({
      sources: [planGeneratorSourceFor(CONTACTS_SPEC)],
      destinationConnectorAccountId: 'coa_destination',
    });

    const companiesLink = tables
      .find((table) => table.ref === 'contacts')
      ?.fields.find((field) => field.name === 'Companies');
    expect(companiesLink?.fieldType).toMatchObject({
      kind: 'foreignKey',
      target: { unresolvedLinkedTableId: 'companies', unresolvedLinkedTableRemoteId: ['companies'] },
    });
    expect(notes.find((note) => note.sourceFieldPath === 'companies.data')?.status).toBe('needs_target');
  });
});
