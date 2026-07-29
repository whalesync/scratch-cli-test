import { Type, type TSchema } from '@sinclair/typebox';
import {
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_CUSTOM_FIELD,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_LAST_MODIFIED_FIELD,
  X_SCRATCH_MAX_LENGTH,
  X_SCRATCH_READONLY,
  X_SCRATCH_REMOTE_FIELD_ID,
} from '@spinner/shared-types';
import { WSLogger } from 'src/logger';
import { ReadonlyFieldEditError, readonlyFieldEditErrorMessage } from '../../error';
import { BaseJsonTableSpec, EntityId, dotPath } from '../../types';
import { ZohoFieldMetadata } from './zoho-types';

const LOG_SOURCE = 'ZohoJsonSchema';

/** Zoho's server-computed, never-writable field types. */
const COMPUTED_READONLY_DATA_TYPES = new Set(['formula', 'rollup_summary', 'aggregation', 'autonumber']);

/** File/image field types — deferred to v2; stored verbatim, read-only for now. */
const ASSET_DATA_TYPES = new Set(['fileupload', 'imageupload', 'profileimage']);

/**
 * Field `api_name`s that round-trip on **read** but cannot be written through the
 * standard create/update record API, so we mark them read-only for now.
 *
 * `Tag`: Zoho returns it as a `[{name, id}]` array on read, but tags can only be
 * mutated via the dedicated `/{module}/actions/add_tags` & `remove_tags` endpoints.
 * Including `Tag` in a normal record write makes Zoho reject the **whole** record, so
 * keeping it read-only blocks edits in the grid and excludes it from publish (the same
 * path audit/computed fields already take). As of DEV-10597, a user who edits `Tag`
 * and publishes gets a clear "read-only" error rather than having the edit silently
 * dropped — the sparse update path throws on a changed read-only field.
 *
 * TODO(zoho-tags): make `Tag` writable by routing Tag diffs to add_tags/remove_tags
 * (creating tags as needed), then remove it from this set. See PLAN.md → "Make the
 * Zoho `Tag` field writable".
 */
export const ZOHO_TAG_FIELD_API_NAME = 'Tag';
const READONLY_FIELD_API_NAMES = new Set([ZOHO_TAG_FIELD_API_NAME]);

/** The system last-modified field Zoho exposes on every record module. */
export const ZOHO_MODIFIED_TIME_FIELD = 'Modified_Time';

/**
 * A field is read-only on write when Zoho computes it, locks it, or its
 * per-operation flags forbid update. `read_only` alone is insufficient — Zoho
 * reports `read_only: false` for audit fields like `Created_Time`/`Modified_Time`
 * while setting `operation_type.api_update: false`, so the operation flag is the
 * authoritative signal (verified live against the Leads module).
 */
export function isReadonlyZohoField(field: ZohoFieldMetadata): boolean {
  if (READONLY_FIELD_API_NAMES.has(field.api_name)) return true;
  if (field.read_only === true || field.field_read_only === true) return true;
  if (field.operation_type && field.operation_type.api_update === false) return true;
  if (COMPUTED_READONLY_DATA_TYPES.has(field.data_type)) return true;
  if (ASSET_DATA_TYPES.has(field.data_type)) return true;
  return false;
}

const STRING_OR_NULL = (extra?: Record<string, unknown>): TSchema => Type.Union([Type.String(), Type.Null()], extra);
const NUMBER_OR_NULL = (extra?: Record<string, unknown>): TSchema => Type.Union([Type.Number(), Type.Null()], extra);

/**
 * Map one Zoho field's `data_type` to a TypeBox schema. Stores values verbatim
 * (the connector never reshapes the record); annotations like the foreign key
 * are attached here. The `default` branch keeps unknown/custom data types
 * permissive and logs once, rather than breaking discovery for an org that uses
 * a type we haven't enumerated.
 */
export function zohoFieldToJsonSchema(field: ZohoFieldMetadata): TSchema {
  // Zoho's `Tag` field is a metadata liar: `/settings/fields` reports it as
  // `data_type: 'text'`, but the value Zoho returns on EVERY record is always an
  // array — `[]` untagged, `[{ name, id }, …]` tagged — never a string. Declaring
  // it `string` (trusting the metadata) makes the transform picker skip its
  // array/object→text coercion, so the raw array reaches string-typed destinations
  // (Notion, Airtable) and rejects every record (DEV-11100). Declare it per its
  // real array shape so the schema matches the on-disk value and the picker joins
  // it for string slots. The default view flattens it to tag names for display.
  if (field.api_name === ZOHO_TAG_FIELD_API_NAME) return zohoTagArraySchema();
  switch (field.data_type) {
    case 'text':
    case 'textarea':
    case 'phone':
      return STRING_OR_NULL();
    case 'email':
      return Type.Union([Type.String({ format: 'email' }), Type.Null()]);
    case 'website':
      return Type.Union([Type.String({ format: 'uri' }), Type.Null()]);

    case 'picklist':
      return buildPicklistSchema(field) ?? STRING_OR_NULL();
    case 'multiselectpicklist': {
      const enumSchema = buildPicklistMemberSchema(field);
      return Type.Array(enumSchema ?? Type.String());
    }

    case 'boolean':
      return Type.Union([Type.Boolean(), Type.Null()]);
    case 'integer':
      return Type.Union([Type.Integer(), Type.Null()]);
    // bigint can exceed 2^53 (record ids, big counters) — keep as string to preserve precision.
    case 'bigint':
      return STRING_OR_NULL();
    case 'double':
    case 'currency':
    case 'percent':
      return NUMBER_OR_NULL();

    case 'date':
      return Type.Union([Type.String({ format: 'date' }), Type.Null()]);
    case 'datetime':
      return Type.Union([Type.String({ format: 'date-time' }), Type.Null()]);

    case 'lookup': {
      const linkedTableId = field.lookup?.module?.api_name;
      const annotations = linkedTableId ? { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId } } : undefined;
      return lookupObjectSchema(annotations);
    }
    case 'ownerlookup':
    case 'userlookup':
      return lookupObjectSchema({ [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'users' } });

    // Multi-valued and polymorphic references are stored verbatim with NO foreign
    // key (Scratch FKs are single-target; see Decision #2 in the plan). They are
    // also only returned on single-record fetch, so they're typically absent in v1.
    case 'multiselectlookup':
      return Type.Union([Type.Array(Type.Unknown()), Type.Null()]);
    // Polymorphic/opaque references and activity metadata, stored verbatim.
    // NOTE: Zoho's live data_type strings are underscored (`multi_module_lookup`),
    // confirmed against the Notes module — the un-underscored aliases are kept
    // only for safety. ALARM/RRULE are the reminder/recurrence fields on
    // Tasks/Events. All have no write path in v1.
    case 'multi_module_lookup':
    case 'multimodulelookup':
    case 'consent_lookup':
    case 'ALARM':
    case 'RRULE':
    case 'multireminder':
      return Type.Union([Type.Unknown(), Type.Null()]);

    case 'subform':
    case 'subformfield':
      return Type.Union([Type.Array(Type.Unknown()), Type.Null()]);

    case 'formula':
      // json_type tells us the computed result's primitive.
      return field.json_type === 'double' ? NUMBER_OR_NULL() : STRING_OR_NULL();
    case 'rollup_summary':
    case 'aggregation':
      return NUMBER_OR_NULL();
    case 'autonumber':
      return STRING_OR_NULL();

    case 'fileupload':
    case 'imageupload':
    case 'profileimage':
      // Verbatim token/ids; asset download/upload deferred to v2.
      return Type.Union([Type.Unknown(), Type.Null()]);

    default:
      WSLogger.warn({
        source: LOG_SOURCE,
        message: `Unrecognized Zoho data_type "${field.data_type}" on field "${field.api_name}" — storing verbatim`,
      });
      return Type.Union([Type.Unknown(), Type.Null()]);
  }
}

/**
 * A Zoho `Tag` value is stored verbatim as an array of `{ name, id }` objects
 * (`[]` when untagged). Kept permissive (`additionalProperties`) so any extra keys
 * Zoho attaches to a tag are preserved on disk per the Connector Prime Directive.
 */
function zohoTagArraySchema(): TSchema {
  return Type.Array(
    Type.Object(
      { name: Type.Optional(Type.String()), id: Type.Optional(Type.String()) },
      { additionalProperties: true },
    ),
  );
}

/** A lookup value is stored verbatim as `{ id, name, ... }` (or null). */
function lookupObjectSchema(extra?: Record<string, unknown>): TSchema {
  return Type.Union(
    [
      Type.Object(
        { id: Type.Optional(Type.String()), name: Type.Optional(Type.String()) },
        { additionalProperties: true },
      ),
      Type.Null(),
    ],
    extra,
  );
}

/** Build a `Type.Union` of the active picklist values plus null. */
function buildPicklistSchema(field: ZohoFieldMetadata): TSchema | null {
  const member = buildPicklistMemberSchema(field);
  if (!member) return null;
  return Type.Union([member, Type.Null()]);
}

function buildPicklistMemberSchema(field: ZohoFieldMetadata): TSchema | null {
  const values = (field.pick_list_values ?? [])
    .filter((value) => value.type === undefined || value.type === 'used')
    .slice()
    .sort((a, b) => (a.sequence_number ?? 0) - (b.sequence_number ?? 0));
  if (values.length === 0) return null;
  const literals = values
    .map((value) => value.actual_value ?? value.display_value)
    .filter((value): value is string => typeof value === 'string')
    .map((value) => Type.Literal(value));
  if (literals.length === 0) return null;
  return literals.length === 1 ? literals[0] : Type.Union(literals);
}

/** Common per-module title fields, preferred when present. */
const PREFERRED_TITLE_FIELDS = [
  'Deal_Name',
  'Account_Name',
  'Product_Name',
  'Vendor_Name',
  'Campaign_Name',
  'Price_Book_Name',
  'Solution_Title',
  'Subject',
  'Last_Name',
  'Name',
  'Full_Name',
];

/** Lookup-typed fields render as reference objects — never a good title. */
const TITLE_EXCLUDED_DATA_TYPES = new Set([
  'lookup',
  'ownerlookup',
  'userlookup',
  'multimodulelookup',
  'multiselectlookup',
]);

function pickTitleField(fields: ZohoFieldMetadata[]): string | undefined {
  const byName = new Map(fields.map((field) => [field.api_name, field]));
  for (const preferred of PREFERRED_TITLE_FIELDS) {
    const field = byName.get(preferred);
    if (field && !TITLE_EXCLUDED_DATA_TYPES.has(field.data_type)) return preferred;
  }
  const firstText = fields.find((field) => field.data_type === 'text');
  return firstText?.api_name;
}

/**
 * Build a {@link BaseJsonTableSpec} for a Zoho module from its field metadata.
 * The implicit `id` field (not returned by `/settings/fields`) is added
 * explicitly, and `Modified_Time` is annotated so incremental pulls can detect
 * the last-modified column.
 */
export function buildZohoJsonTableSpec(
  id: EntityId,
  moduleApiName: string,
  displayName: string,
  fields: ZohoFieldMetadata[],
): BaseJsonTableSpec {
  const properties: Record<string, TSchema> = {
    // Zoho record id is a bigint returned as a string; never writable.
    id: Type.String({
      [X_SCRATCH_READONLY]: true,
      [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'zoho/bigint',
      [X_SCRATCH_REMOTE_FIELD_ID]: 'id',
      description: 'Record ID',
    }),
  };

  for (const field of fields) {
    if (field.api_name === 'id') continue;
    const base = zohoFieldToJsonSchema(field);
    const annotations: Record<string, unknown> = {
      description: field.field_label ?? field.api_name,
      [X_SCRATCH_CONNECTOR_DATA_TYPE]: `zoho/${field.data_type}`,
      [X_SCRATCH_REMOTE_FIELD_ID]: field.api_name,
    };
    if (isReadonlyZohoField(field)) {
      annotations[X_SCRATCH_READONLY] = true;
    }
    if (field.custom_field === true) {
      // Faithful provenance from Zoho's field metadata; the default-view builder
      // reads it to gather custom fields under a "Custom Fields" banner group.
      annotations[X_SCRATCH_CUSTOM_FIELD] = true;
    }
    if (typeof field.length === 'number' && field.length > 0 && isTextLikeType(field.data_type)) {
      annotations[X_SCRATCH_MAX_LENGTH] = field.length;
    }
    if (field.api_name === ZOHO_MODIFIED_TIME_FIELD) {
      annotations[X_SCRATCH_LAST_MODIFIED_FIELD] = true;
    }
    properties[field.api_name] = { ...base, ...annotations };
  }

  const schema = Type.Object(properties, { $id: `zoho/${moduleApiName}`, title: displayName });
  const titleField = pickTitleField(fields);

  return {
    id,
    slug: id.wsId,
    name: displayName,
    schema,
    idPath: dotPath('id'),
    titlePath: titleField ? dotPath(titleField) : undefined,
    generatedAt: new Date().toISOString(),
  };
}

function isTextLikeType(dataType: string): boolean {
  return dataType === 'text' || dataType === 'textarea' || dataType === 'email' || dataType === 'website';
}

/** The synthetic table id for the org users reference table (FK target of ownerlookup/userlookup). */
export const ZOHO_USERS_TABLE_ID = 'users';

/**
 * Build the table spec for the synthetic read-only `users` table. Org users come
 * from the dedicated `/users` endpoint, which — unlike record modules — has **no
 * `/settings/fields` metadata**. Per the "hardcode a schema only when the API
 * offers no introspection" rule, we curate the common user fields and keep the
 * object **permissive** (`additionalProperties`) so any extra keys Zoho returns
 * are stored verbatim. Every field is read-only; the table is never written. We
 * deliberately omit `Modified_Time` from the defined properties so the connector
 * reports incremental pull as unsupported (this small reference table full-pulls).
 */
export function buildZohoUsersTableSpec(id: EntityId): BaseJsonTableSpec {
  const readonly = (base: TSchema, remoteId: string, label: string, connectorType: string): TSchema => ({
    ...base,
    [X_SCRATCH_READONLY]: true,
    [X_SCRATCH_REMOTE_FIELD_ID]: remoteId,
    [X_SCRATCH_CONNECTOR_DATA_TYPE]: `zoho/${connectorType}`,
    description: label,
  });
  const stringOrNull = Type.Union([Type.String(), Type.Null()]);
  const referenceObjectOrNull = Type.Union([
    Type.Object(
      { id: Type.Optional(Type.String()), name: Type.Optional(Type.String()) },
      { additionalProperties: true },
    ),
    Type.Null(),
  ]);

  const properties: Record<string, TSchema> = {
    id: readonly(Type.String(), 'id', 'User ID', 'bigint'),
    full_name: readonly(stringOrNull, 'full_name', 'Full Name', 'text'),
    first_name: readonly(stringOrNull, 'first_name', 'First Name', 'text'),
    last_name: readonly(stringOrNull, 'last_name', 'Last Name', 'text'),
    email: readonly(Type.Union([Type.String({ format: 'email' }), Type.Null()]), 'email', 'Email', 'email'),
    role: readonly(referenceObjectOrNull, 'role', 'Role', 'lookup'),
    profile: readonly(referenceObjectOrNull, 'profile', 'Profile', 'lookup'),
    status: readonly(stringOrNull, 'status', 'Status', 'text'),
    phone: readonly(stringOrNull, 'phone', 'Phone', 'phone'),
    mobile: readonly(stringOrNull, 'mobile', 'Mobile', 'phone'),
    zuid: readonly(stringOrNull, 'zuid', 'Zoho UID', 'bigint'),
    Created_Time: readonly(
      Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
      'Created_Time',
      'Created Time',
      'datetime',
    ),
  };

  const schema = Type.Object(properties, { $id: 'zoho/users', title: 'Users', additionalProperties: true });
  return {
    id,
    slug: id.wsId,
    name: 'Users',
    schema,
    idPath: dotPath('id'),
    titlePath: dotPath('full_name'),
    generatedAt: new Date().toISOString(),
  };
}

/** Read the `x-scratch-readonly` flag for a field straight off the built schema. */
export function isReadonlyFieldInSchema(tableSpec: BaseJsonTableSpec, fieldName: string): boolean {
  const properties = (tableSpec.schema as unknown as { properties?: Record<string, Record<string, unknown>> })
    .properties;
  return properties?.[fieldName]?.[X_SCRATCH_READONLY] === true;
}

/** Whether a field carries a foreign-key annotation (so its value is a lookup object). */
function isForeignKeyFieldInSchema(tableSpec: BaseJsonTableSpec, fieldName: string): boolean {
  const properties = (tableSpec.schema as unknown as { properties?: Record<string, Record<string, unknown>> })
    .properties;
  return properties?.[fieldName]?.[X_SCRATCH_FOREIGN_KEY_OPTIONS] !== undefined;
}

/**
 * Build the write payload for create/update: drop the id and every read-only
 * field, and reduce single-lookup objects to `{ id }` (Zoho's accepted write
 * shape). Multi-valued/polymorphic lookups and subforms are not written in v1.
 */
export function sanitizeZohoWritePayload(
  record: Record<string, unknown>,
  tableSpec: BaseJsonTableSpec,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'id') continue;
    if (isReadonlyFieldInSchema(tableSpec, key)) continue;

    if (isForeignKeyFieldInSchema(tableSpec, key) && value && typeof value === 'object' && !Array.isArray(value)) {
      const lookupId = (value as Record<string, unknown>).id;
      payload[key] = typeof lookupId === 'string' || typeof lookupId === 'number' ? { id: String(lookupId) } : null;
      continue;
    }

    payload[key] = value;
  }
  return payload;
}

/**
 * Build the write payload for an UPDATE from the user's sparse changed fields,
 * throwing if any changed field is read-only. The keys here are only what the
 * user actually changed, so a read-only key is a genuine read-only edit that
 * must be surfaced rather than silently dropped (DEV-10597) — the old behavior
 * sent an id-only no-op PUT and reported success. Contrast
 * {@link sanitizeZohoWritePayload}, used for create and the full-record fallback,
 * where read-only fields are always present and are simply stripped.
 */
export function buildZohoUpdatePayloadOrThrowOnReadonly(
  changedRecord: Record<string, unknown>,
  tableSpec: BaseJsonTableSpec,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const readonlyChangedFieldNames: string[] = [];
  for (const [key, value] of Object.entries(changedRecord)) {
    if (key === 'id') continue;
    if (isReadonlyFieldInSchema(tableSpec, key)) {
      readonlyChangedFieldNames.push(key);
      continue;
    }

    if (isForeignKeyFieldInSchema(tableSpec, key) && value && typeof value === 'object' && !Array.isArray(value)) {
      const lookupId = (value as Record<string, unknown>).id;
      payload[key] = typeof lookupId === 'string' || typeof lookupId === 'number' ? { id: String(lookupId) } : null;
      continue;
    }

    payload[key] = value;
  }
  if (readonlyChangedFieldNames.length > 0) {
    throw new ReadonlyFieldEditError(readonlyFieldEditErrorMessage(readonlyChangedFieldNames));
  }
  return payload;
}
