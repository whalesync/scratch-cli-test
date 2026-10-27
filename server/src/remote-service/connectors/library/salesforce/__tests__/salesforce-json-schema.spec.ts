import {
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_CUSTOM_FIELD,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_LAST_MODIFIED_FIELD,
  X_SCRATCH_MAX_LENGTH,
  X_SCRATCH_READONLY,
  X_SCRATCH_REMOTE_FIELD_ID,
  X_SCRATCH_WRITE_ONCE,
} from '@spinner/shared-types';
import { findLastModifiedFieldName } from '../../../types';
import { buildSalesforceJsonTableSpec, salesforceFieldValueSchema } from '../salesforce-json-schema';
import {
  ACCOUNT_DESCRIBE,
  ACCOUNT_TABLE_ID,
  accountTableSpec,
  salesforceField,
  SYSTEM_FIELDS,
  TEST_INSTANCE_URL,
} from './salesforce-test-fixtures';

type SchemaProperties = Record<string, Record<string, unknown>>;

/** The schema as it's written to schema.json — without TypeBox's in-memory symbol keys. */
function asPlainJson(schema: unknown): unknown {
  return JSON.parse(JSON.stringify(schema)) as unknown;
}

function propertiesOf(spec: ReturnType<typeof accountTableSpec>): SchemaProperties {
  return (spec.schema as unknown as { properties: SchemaProperties }).properties;
}

describe('buildSalesforceJsonTableSpec', () => {
  const spec = accountTableSpec();
  const properties = propertiesOf(spec);

  it('describes every field in describe order, after the attributes block', () => {
    expect(Object.keys(properties)).toEqual(['attributes', ...ACCOUNT_DESCRIBE.fields.map((field) => field.name)]);
  });

  it('identifies records by Id, titles them by the name field, and links to the object in Salesforce', () => {
    expect(spec.idPath).toBe('Id');
    expect(spec.titlePath).toBe('Name');
    expect(spec.name).toBe('Accounts');
    expect(spec.remoteWebUrl).toBe('https://acme.my.salesforce.com/lightning/o/Account/list');
  });

  it('records the native type and API name on every field', () => {
    expect(properties.Industry[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('salesforce/picklist');
    expect(properties.Industry[X_SCRATCH_REMOTE_FIELD_ID]).toBe('Industry');
    expect(properties.Industry.description).toBe('Industry');
    // A rich text area is its own field type in Salesforce, and its value is HTML.
    expect(properties.Notes__c[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('salesforce/richtextarea');
    expect(properties.Description[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('salesforce/textarea');
  });

  it('marks never-writable fields read-only and create-only fields write-once', () => {
    for (const readonlyField of [
      'Id',
      'IsDeleted',
      'CreatedDate',
      'SystemModstamp',
      'BillingAddress',
      'LastActivityDate',
    ]) {
      expect(properties[readonlyField][X_SCRATCH_READONLY]).toBe(true);
    }
    expect(properties.attributes[X_SCRATCH_READONLY]).toBe(true);
    expect(properties.BillingCity[X_SCRATCH_READONLY]).toBeUndefined();
    expect(properties.LegacyNumber__c[X_SCRATCH_WRITE_ONCE]).toBe(true);
    expect(properties.LegacyNumber__c[X_SCRATCH_READONLY]).toBeUndefined();
  });

  it('flags custom fields and text length limits', () => {
    expect(properties.Notes__c[X_SCRATCH_CUSTOM_FIELD]).toBe(true);
    expect(properties.Name[X_SCRATCH_CUSTOM_FIELD]).toBeUndefined();
    expect(properties.Name[X_SCRATCH_MAX_LENGTH]).toBe(255);
    expect(properties.NumberOfEmployees[X_SCRATCH_MAX_LENGTH]).toBeUndefined();
  });

  it('links single-target lookups and leaves polymorphic ones as plain ids', () => {
    expect(properties.ParentId[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({
      linkedTableId: 'account',
      linkedTableRemoteId: ['Account'],
      isSingleValued: true,
    });
    expect(properties.OwnerId[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toBeUndefined();
  });

  it('annotates SystemModstamp as the last-modified field', () => {
    expect(properties.SystemModstamp[X_SCRATCH_LAST_MODIFIED_FIELD]).toBe(true);
    expect(findLastModifiedFieldName(spec)).toBe('SystemModstamp');
  });

  it('falls back to LastModifiedDate when an object has no SystemModstamp', () => {
    const specWithoutSystemModstamp = buildSalesforceJsonTableSpec(
      ACCOUNT_TABLE_ID,
      {
        ...ACCOUNT_DESCRIBE,
        fields: [
          SYSTEM_FIELDS[0],
          salesforceField({ name: 'LastModifiedDate', type: 'datetime', createable: false, updateable: false }),
        ],
      },
      TEST_INSTANCE_URL,
    );
    expect(findLastModifiedFieldName(specWithoutSystemModstamp)).toBe('LastModifiedDate');
  });

  it('requires the id plus the fields a create cannot do without', () => {
    // Name: non-nillable with no default. OwnerId is defaulted; Active__c is a checkbox Salesforce fills itself.
    expect((spec.schema as { required?: string[] }).required).toEqual(['Id', 'Name']);
  });
});

describe('salesforceFieldValueSchema', () => {
  it.each([
    ['boolean', { anyOf: [{ type: 'boolean' }, { type: 'null' }] }],
    ['int', { anyOf: [{ type: 'integer' }, { type: 'null' }] }],
    ['currency', { anyOf: [{ type: 'number' }, { type: 'null' }] }],
    ['date', { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] }],
    ['url', { anyOf: [{ type: 'string', format: 'uri' }, { type: 'null' }] }],
    ['multipicklist', { anyOf: [{ type: 'string' }, { type: 'null' }] }],
    ['reference', { anyOf: [{ type: 'string' }, { type: 'null' }] }],
  ])('types a %s field', (salesforceFieldType, expectedSchema) => {
    expect(asPlainJson(salesforceFieldValueSchema(salesforceField({ name: 'F', type: salesforceFieldType })))).toEqual(
      expectedSchema,
    );
  });

  it('types datetimes as plain strings, since their +0000 offset is not RFC 3339', () => {
    const datetimeSchema = asPlainJson(
      salesforceFieldValueSchema(salesforceField({ name: 'F', type: 'datetime' })),
    ) as {
      anyOf: { format?: string }[];
    };
    expect(datetimeSchema.anyOf.some((branch) => branch.format !== undefined)).toBe(false);
  });

  it('types a compound address as an open object', () => {
    const addressSchema = asPlainJson(salesforceFieldValueSchema(salesforceField({ name: 'F', type: 'address' }))) as {
      anyOf: { type: string; additionalProperties?: boolean; properties?: Record<string, unknown> }[];
    };
    expect(addressSchema.anyOf[0].type).toBe('object');
    expect(addressSchema.anyOf[0].additionalProperties).toBe(true);
    expect(Object.keys(addressSchema.anyOf[0].properties ?? {})).toEqual(
      expect.arrayContaining(['street', 'city', 'state', 'postalCode', 'country', 'latitude', 'longitude']),
    );
  });

  it('keeps a field type it does not know as a nullable string', () => {
    expect(asPlainJson(salesforceFieldValueSchema(salesforceField({ name: 'F', type: 'someFutureType' })))).toEqual({
      anyOf: [{ type: 'string' }, { type: 'null' }],
    });
  });
});
