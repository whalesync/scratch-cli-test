import { Type, type TSchema } from '@sinclair/typebox';
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
import { sanitizeForTableWsId } from '../../ids';
import { BaseJsonTableSpec, dotPath, EntityId } from '../../types';
import { SalesforceFieldDescribe, SalesforceSObjectDescribe } from './salesforce-types';

/** The record id field every Salesforce object has. */
export const SALESFORCE_RECORD_ID_FIELD = 'Id';

/** The per-record `{ type, url }` block Salesforce puts first in every record it returns. */
export const SALESFORCE_RECORD_ATTRIBUTES_KEY = 'attributes';

/**
 * Last-modified fields, in order of preference, for the incremental pull. `SystemModstamp` is indexed and moves on
 * system-driven changes too; `LastModifiedDate` only moves on user changes.
 */
const SALESFORCE_LAST_MODIFIED_FIELD_PREFERENCE = ['SystemModstamp', 'LastModifiedDate'];

/** Field types whose value is a text string and whose describe `length` is a real character limit. */
const SALESFORCE_TEXT_FIELD_TYPES = new Set([
  'string',
  'textarea',
  'email',
  'url',
  'phone',
  'picklist',
  'multipicklist',
  'combobox',
  'encryptedstring',
]);

/**
 * The `x-scratch-connector-data-type` for a field: `salesforce/<describe type>`, except a rich text area (type
 * `textarea`, `extraTypeInfo: richtextarea`), which Salesforce presents as its own field type and whose value is
 * HTML rather than plain text.
 */
export function salesforceConnectorDataType(field: SalesforceFieldDescribe): string {
  if (field.type === 'textarea' && field.extraTypeInfo === 'richtextarea') {
    return 'salesforce/richtextarea';
  }
  return `salesforce/${field.type}`;
}

const stringOrNull = (): TSchema => Type.Union([Type.String(), Type.Null()]);
const numberOrNull = (): TSchema => Type.Union([Type.Number(), Type.Null()]);

/**
 * The value schema for one Salesforce field, by its describe `type`. Values are stored exactly as SOQL returns
 * them; this only describes them.
 *
 * `datetime` values are typed as plain strings: Salesforce writes the offset without a colon
 * (`2026-10-27T09:15:00.000+0000`), which isn't RFC 3339, so `format: 'date-time'` would flag every value. The
 * default view declares those columns' `logicalType: 'datetime'` instead, so exports still get a real timestamp.
 */
export function salesforceFieldValueSchema(field: SalesforceFieldDescribe): TSchema {
  switch (field.type) {
    case 'id':
      return Type.String();
    case 'boolean':
      return Type.Union([Type.Boolean(), Type.Null()]);
    case 'int':
    case 'long':
      return Type.Union([Type.Integer(), Type.Null()]);
    case 'double':
    case 'currency':
    case 'percent':
      return numberOrNull();
    case 'date':
      return Type.Union([Type.String({ format: 'date' }), Type.Null()]);
    case 'email':
      return Type.Union([Type.String({ format: 'email' }), Type.Null()]);
    case 'url':
      return Type.Union([Type.String({ format: 'uri' }), Type.Null()]);
    case 'address':
      // Compound address: read-only, mirrored by the writable `<Prefix>Street`/`City`/… component fields.
      return Type.Union([
        Type.Object(
          {
            street: Type.Optional(stringOrNull()),
            city: Type.Optional(stringOrNull()),
            state: Type.Optional(stringOrNull()),
            stateCode: Type.Optional(stringOrNull()),
            postalCode: Type.Optional(stringOrNull()),
            country: Type.Optional(stringOrNull()),
            countryCode: Type.Optional(stringOrNull()),
            latitude: Type.Optional(numberOrNull()),
            longitude: Type.Optional(numberOrNull()),
            geocodeAccuracy: Type.Optional(stringOrNull()),
          },
          { additionalProperties: true },
        ),
        Type.Null(),
      ]);
    case 'location':
      // Compound geolocation: read-only, mirrored by the writable `__Latitude__s` / `__Longitude__s` components.
      return Type.Union([
        Type.Object(
          { latitude: Type.Optional(numberOrNull()), longitude: Type.Optional(numberOrNull()) },
          { additionalProperties: true },
        ),
        Type.Null(),
      ]);
    case 'anyType':
    case 'complexvalue':
      return Type.Unknown();
    // string, textarea, phone, picklist, multipicklist (`;`-separated), combobox, encryptedstring, reference,
    // datetime, time, base64 (a URL to the blob) — and any type Salesforce adds later — are strings or null.
    default:
      return stringOrNull();
  }
}

/** A field the API never accepts on create or update: system, audit, formula, roll-up and compound fields. */
function isNeverWritableSalesforceField(field: SalesforceFieldDescribe): boolean {
  return !field.createable && !field.updateable;
}

/** Settable when a record is created, rejected afterwards (e.g. a master-detail parent that can't be reparented). */
function isSetOnCreateOnlySalesforceField(field: SalesforceFieldDescribe): boolean {
  return field.createable && !field.updateable;
}

/**
 * Required to create a record: no default, can't be null, and settable on create. Checkboxes are excluded because
 * Salesforce reports them non-nillable but fills `false` itself.
 */
export function isRequiredToCreateSalesforceRecord(field: SalesforceFieldDescribe): boolean {
  return field.createable && !field.nillable && !field.defaultedOnCreate && field.type !== 'boolean';
}

/**
 * The foreign-key annotation for a lookup. Only a single-target lookup gets one: a polymorphic lookup (`OwnerId`
 * → User or Group, `WhoId` → Contact or Lead) can't name one linked table, so it stays a plain id string.
 */
function salesforceForeignKeyAnnotation(
  field: SalesforceFieldDescribe,
): { linkedTableId: string; linkedTableRemoteId: string[]; isSingleValued: true } | undefined {
  if (field.type !== 'reference' || field.referenceTo.length !== 1) {
    return undefined;
  }
  const linkedObjectApiName = field.referenceTo[0];
  return {
    linkedTableId: salesforceTableWsId(linkedObjectApiName),
    linkedTableRemoteId: [linkedObjectApiName],
    isSingleValued: true,
  };
}

/** The `wsId` of the table for an object API name. Salesforce API names are case-insensitively unique. */
export function salesforceTableWsId(objectApiName: string): string {
  return sanitizeForTableWsId(objectApiName);
}

function salesforceFieldSchemaWithAnnotations(
  field: SalesforceFieldDescribe,
  lastModifiedFieldApiName: string | undefined,
): TSchema {
  const annotations: Record<string, unknown> = {
    description: field.label,
    [X_SCRATCH_CONNECTOR_DATA_TYPE]: salesforceConnectorDataType(field),
    [X_SCRATCH_REMOTE_FIELD_ID]: field.name,
  };
  if (isNeverWritableSalesforceField(field)) {
    annotations[X_SCRATCH_READONLY] = true;
  } else if (isSetOnCreateOnlySalesforceField(field)) {
    annotations[X_SCRATCH_WRITE_ONCE] = true;
  }
  if (field.custom) {
    annotations[X_SCRATCH_CUSTOM_FIELD] = true;
  }
  if (SALESFORCE_TEXT_FIELD_TYPES.has(field.type) && field.length > 0) {
    annotations[X_SCRATCH_MAX_LENGTH] = field.length;
  }
  const foreignKeyAnnotation = salesforceForeignKeyAnnotation(field);
  if (foreignKeyAnnotation) {
    annotations[X_SCRATCH_FOREIGN_KEY_OPTIONS] = foreignKeyAnnotation;
  }
  if (field.name === lastModifiedFieldApiName) {
    annotations[X_SCRATCH_LAST_MODIFIED_FIELD] = true;
  }
  return { ...salesforceFieldValueSchema(field), ...annotations };
}

function findLastModifiedFieldApiName(fields: SalesforceFieldDescribe[]): string | undefined {
  const datetimeFieldApiNames = new Set(fields.filter((field) => field.type === 'datetime').map((field) => field.name));
  return SALESFORCE_LAST_MODIFIED_FIELD_PREFERENCE.find((fieldApiName) => datetimeFieldApiNames.has(fieldApiName));
}

/** The object's name field (`Name`, `CaseNumber`, `Subject`, …), which Salesforce shows as each record's title. */
function findTitleFieldApiName(fields: SalesforceFieldDescribe[]): string | undefined {
  return fields.find((field) => field.nameField)?.name ?? fields.find((field) => field.name === 'Name')?.name;
}

/**
 * The fields selected when pulling an object: every describe field, in describe order. That is what makes a
 * pulled record match Salesforce's single-record read field for field.
 */
export function salesforcePullFieldApiNames(describe: SalesforceSObjectDescribe): string[] {
  return describe.fields.map((field) => field.name);
}

/**
 * Build the table spec for one Salesforce object from its live describe. Every describe field becomes a
 * top-level property, in describe order, after the `attributes` block Salesforce puts first in each record.
 */
export function buildSalesforceJsonTableSpec(
  id: EntityId,
  describe: SalesforceSObjectDescribe,
  instanceUrl: string,
): BaseJsonTableSpec {
  const lastModifiedFieldApiName = findLastModifiedFieldApiName(describe.fields);
  const properties: Record<string, TSchema> = {
    [SALESFORCE_RECORD_ATTRIBUTES_KEY]: Type.Optional(
      Type.Object(
        { type: Type.String(), url: Type.Optional(Type.String()) },
        {
          additionalProperties: true,
          description: 'Record attributes',
          [X_SCRATCH_READONLY]: true,
          [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'salesforce/attributes',
        },
      ),
    ),
  };

  for (const field of describe.fields) {
    const fieldSchema = salesforceFieldSchemaWithAnnotations(field, lastModifiedFieldApiName);
    // A record always carries its id; any other field is required only when a create can't succeed without it.
    const isRequiredProperty = field.name === SALESFORCE_RECORD_ID_FIELD || isRequiredToCreateSalesforceRecord(field);
    properties[field.name] = isRequiredProperty ? fieldSchema : Type.Optional(fieldSchema);
  }

  const titleFieldApiName = findTitleFieldApiName(describe.fields);
  return {
    id,
    slug: id.wsId,
    name: describe.labelPlural || describe.label || describe.name,
    schema: Type.Object(properties, { $id: `salesforce/${describe.name}`, title: describe.label }),
    idPath: dotPath(SALESFORCE_RECORD_ID_FIELD),
    titlePath: titleFieldApiName ? dotPath(titleFieldApiName) : undefined,
    remoteWebUrl: `${instanceUrl}/lightning/o/${encodeURIComponent(describe.name)}/list`,
    generatedAt: new Date().toISOString(),
  };
}

type SchemaPropertyAnnotations = Record<string, unknown>;

/** A property's schema and annotations, read off a built spec. */
export function salesforceSchemaPropertyAnnotations(
  tableSpec: BaseJsonTableSpec,
  fieldApiName: string,
): SchemaPropertyAnnotations | undefined {
  const properties = (tableSpec.schema as unknown as { properties?: Record<string, SchemaPropertyAnnotations> })
    .properties;
  return properties?.[fieldApiName];
}
