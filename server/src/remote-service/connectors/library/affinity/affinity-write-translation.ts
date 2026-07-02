/**
 * Pure translation helpers for Affinity v2 publishing (DEV-10298).
 *
 * Records are stored verbatim in their READ shape, where reference-type field
 * values embed display decoration — e.g. a `person` value reads as
 * `{ id, firstName, lastName, primaryEmailAddress, type }` and a `dropdown`
 * value reads as `{ dropdownOptionId, text, rank?, color? }`. The v2 write
 * endpoints (`update-fields` batch operations) accept ONLY the reference keys
 * (`additionalProperties: false`): `{ id }` for person/company, and
 * `{ dropdownOptionId }` for dropdown/ranked-dropdown. These helpers narrow a
 * stored read-shaped value into the write payload the API accepts.
 *
 * Source of the write shapes: developer.affinity.co OpenAPI — the
 * `FieldValueUpdate` discriminated union on the batch-operations endpoints.
 */

import { X_SCRATCH_CONNECTOR_DATA_TYPE, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { AffinityError } from './affinity-api-client';
import { getAffinityFieldSchemasById } from './affinity-fields';
import {
  AffinityFieldValueUpdate,
  AffinityFieldValueWritePayload,
  AffinityNoteCreateRequest,
  AffinityV1OpportunityCreate,
  AffinityV1OpportunityWrite,
  AffinityV1OrganizationWrite,
  AffinityV1PersonWrite,
  AffinityValueType,
} from './affinity-types';

// `isReadOnlyAffinityField` and the read-only category / value-type sets moved
// to ./affinity-fields (shared with the schema builder and default view). Kept
// re-exported here for the connector + existing importers/tests.
export {
  isReadOnlyAffinityField,
  READ_ONLY_AFFINITY_FIELD_CATEGORIES,
  READ_ONLY_AFFINITY_VALUE_TYPES,
} from './affinity-fields';

// The record *basics* (top-level scalar identity fields) that the v1 API can
// write, by table. Everything else top-level is read-only or server-derived
// (`id`, `primaryEmailAddress`, `domains`, `isGlobal`, `type`, `listId`); a
// changed top-level key outside these (and outside `fields`) is refused.
export const PERSON_WRITABLE_BASIC_KEYS: ReadonlySet<string> = new Set(['firstName', 'lastName', 'emailAddresses']);
export const COMPANY_WRITABLE_BASIC_KEYS: ReadonlySet<string> = new Set(['name', 'domain']);
export const OPPORTUNITY_WRITABLE_BASIC_KEYS: ReadonlySet<string> = new Set(['name']);

/** The only keys the v2 `Location` write schema accepts. */
const LOCATION_WRITE_KEYS = ['streetAddress', 'city', 'state', 'country', 'continent'] as const;

/**
 * Narrow a stored read-shaped field value into the `{ type, data }` write
 * payload for an `update-fields` batch operation.
 *
 * @param valueType - the field's `valueType` from its metadata (the stored
 *   value object may be null, so the type cannot always be read off it).
 * @param storedValueObject - the field's `value` as stored in the record file
 *   (read shape: `{ type, data, totalCount? }`), or null when the field is empty.
 * @throws AffinityError for read-only value types, malformed reference data,
 *   or a truncated multi-value read (writing it back would drop values).
 */
export function translateStoredFieldValueToWritePayload(
  valueType: AffinityValueType,
  storedValueObject: { type?: string; data?: unknown; totalCount?: number } | null | undefined,
): AffinityFieldValueWritePayload {
  const storedData = storedValueObject?.data ?? null;

  // A multi-value read can be truncated: when `totalCount` exceeds the length
  // of `data`, Affinity only returned the first page of values. Writing the
  // truncated array back would silently DELETE the values beyond the page —
  // refuse instead of destroying data the user never saw.
  const storedTotalCount = storedValueObject?.totalCount;
  if (
    typeof storedTotalCount === 'number' &&
    Array.isArray(storedData) &&
    storedTotalCount > (storedData as unknown[]).length
  ) {
    throw new AffinityError(
      `Refusing to write a truncated multi-value field (totalCount ${storedTotalCount} > ${(storedData as unknown[]).length} values present) — publishing it would delete the values Affinity did not return.`,
    );
  }

  switch (valueType) {
    case 'text':
    case 'filterable-text':
    case 'number':
    case 'datetime':
      return { type: valueType, data: storedData };

    case 'filterable-text-multi':
    case 'number-multi':
      return { type: valueType, data: storedData };

    case 'dropdown':
    case 'ranked-dropdown':
      return { type: valueType, data: storedData === null ? null : narrowToDropdownReference(storedData, valueType) };

    case 'dropdown-multi':
      return {
        type: valueType,
        data: storedData === null ? null : narrowArray(storedData, valueType, narrowToDropdownReference),
      };

    case 'person':
    case 'company':
      return { type: valueType, data: storedData === null ? null : narrowToEntityReference(storedData, valueType) };

    case 'person-multi':
    case 'company-multi':
      return {
        type: valueType,
        data: storedData === null ? null : narrowArray(storedData, valueType, narrowToEntityReference),
      };

    case 'location':
      return { type: valueType, data: storedData === null ? null : narrowToLocationWriteKeys(storedData, valueType) };

    case 'location-multi':
      return {
        type: valueType,
        data: storedData === null ? null : narrowArray(storedData, valueType, narrowToLocationWriteKeys),
      };

    case 'interaction':
    case 'formula-number':
      throw new AffinityError(`Affinity "${valueType}" fields are computed and cannot be written.`);

    default: {
      // A future valueType the connector doesn't know yet — refuse loudly
      // rather than guessing a write shape the API may misinterpret.
      const unknownType: string = valueType;
      throw new AffinityError(`Unknown Affinity field value type "${unknownType}" — write not attempted.`);
    }
  }
}

/** Narrow a read-shaped person/company reference (`{id, name, …}`) to the write shape `{id}`. */
function narrowToEntityReference(readShapedData: unknown, valueType: string): { id: number } {
  const id = (readShapedData as { id?: unknown })?.id;
  if (typeof id !== 'number') {
    throw new AffinityError(`Affinity "${valueType}" value is missing a numeric "id" — cannot build a write payload.`);
  }
  return { id };
}

/** Narrow a read-shaped dropdown value (`{dropdownOptionId, text, …}`) to the write shape `{dropdownOptionId}`. */
function narrowToDropdownReference(readShapedData: unknown, valueType: string): { dropdownOptionId: number } {
  const dropdownOptionId = (readShapedData as { dropdownOptionId?: unknown })?.dropdownOptionId;
  if (typeof dropdownOptionId !== 'number') {
    throw new AffinityError(
      `Affinity "${valueType}" value is missing a numeric "dropdownOptionId" — cannot build a write payload.`,
    );
  }
  return { dropdownOptionId };
}

/** Keep only the keys the v2 `Location` write schema accepts (it rejects unknown keys). */
function narrowToLocationWriteKeys(readShapedData: unknown, valueType: string): Record<string, unknown> {
  if (typeof readShapedData !== 'object' || readShapedData === null) {
    throw new AffinityError(`Affinity "${valueType}" value is not an object — cannot build a write payload.`);
  }
  const locationWritePayload: Record<string, unknown> = {};
  for (const key of LOCATION_WRITE_KEYS) {
    locationWritePayload[key] = (readShapedData as Record<string, unknown>)[key] ?? null;
  }
  return locationWritePayload;
}

/** Map every element of a multi-value array through a reference-narrowing function. */
function narrowArray<T>(
  storedData: unknown,
  valueType: string,
  narrowElement: (element: unknown, valueType: string) => T,
): T[] {
  if (!Array.isArray(storedData)) {
    throw new AffinityError(`Affinity "${valueType}" value is not an array — cannot build a write payload.`);
  }
  return storedData.map((element) => narrowElement(element, valueType));
}

// ---------------------------------------------------------------------------
// Record-level update assembly
// ---------------------------------------------------------------------------

/**
 * Pull the per-field-id metadata (each field's `valueType` +
 * `x-scratch-readonly`) out of a table spec's JSON schema. The verbatim `fields`
 * array carries this as the {@link X_SCRATCH_AFFINITY_FIELDS_BY_ID} map (there is
 * no longer a per-field object schema, since the array is stored verbatim). List
 * entries nest the array under `entity.fields`; tenant tables (persons /
 * companies) carry it at top-level `fields`.
 */
export function extractDynamicFieldSchemasByFieldId(
  tableSpecSchema: Record<string, unknown>,
  recordHasEntityWrapper: boolean,
): Record<string, Record<string, unknown>> {
  const topLevelProperties = (tableSpecSchema as { properties?: Record<string, unknown> }).properties ?? {};
  const fieldsParent = recordHasEntityWrapper
    ? ((topLevelProperties['entity'] as { properties?: Record<string, unknown> } | undefined)?.properties ?? {})
    : topLevelProperties;
  const fieldsArraySchema = fieldsParent['fields'];
  return getAffinityFieldSchemasById(fieldsArraySchema) ?? {};
}

/**
 * Build the `update-fields` batch payload for one changed record.
 *
 * The sparse `changedFields` object is used only to learn WHICH field ids
 * changed — the value sent is always read whole from the full record file, so
 * a deep-sparse diff that touched only `value.data` still produces a complete
 * `{ type, data }` payload.
 *
 * Anything changed outside the dynamic fields container (record basics like
 * `firstName` / `name` / `domain`, system keys) has no v2 write endpoint and
 * throws — the edit is refused loudly, never silently dropped. Changed fields
 * labeled read-only in the schema (enriched / relationship-intelligence /
 * computed) also throw.
 *
 * When `changedRecordSparseObject` is undefined (caller couldn't compute a
 * diff), every writable field present on the record is re-sent — a converging,
 * idempotent fallback.
 */
export function buildFieldValueUpdatesForChangedRecord(params: {
  changedRecordSparseObject: Record<string, unknown> | undefined;
  fullRecordFile: Record<string, unknown>;
  tableSpecSchema: Record<string, unknown>;
  recordHasEntityWrapper: boolean;
}): AffinityFieldValueUpdate[] {
  const { changedRecordSparseObject, fullRecordFile, tableSpecSchema, recordHasEntityWrapper } = params;

  const fieldSchemasByFieldId = extractDynamicFieldSchemasByFieldId(tableSpecSchema, recordHasEntityWrapper);
  // The verbatim `fields` array; each element is `{ id, name, type, value, … }`.
  // Index it by id so a changed element resolves to its full stored value.
  const storedFieldEntriesByFieldId = indexFieldsArrayById(readFieldsArray(fullRecordFile, recordHasEntityWrapper));

  let changedFieldIds: string[];
  if (changedRecordSparseObject === undefined) {
    // No diff available — re-send every writable field present on the record.
    changedFieldIds = [...storedFieldEntriesByFieldId.keys()].filter((fieldId) => {
      const fieldSchema = fieldSchemasByFieldId[fieldId];
      return fieldSchema !== undefined && fieldSchema[X_SCRATCH_READONLY] !== true;
    });
  } else {
    const unsupportedChangedPaths = collectChangedPathsOutsideFieldsContainer(
      changedRecordSparseObject,
      recordHasEntityWrapper,
    );
    if (unsupportedChangedPaths.length > 0) {
      throw new AffinityError(
        `These edited fields cannot be written via the Affinity v2 API and were not published: ${unsupportedChangedPaths.join(
          ', ',
        )}. Record basics (names, domains, emails) and system fields require the v1 API, which the connector does not write through yet — only Affinity field values are publishable.`,
      );
    }
    // The sparse diff's `fields` is the keyed-array-aware element diff: a sparse
    // list of the changed elements, each identified by its `id`.
    const changedFieldElements = readFieldsArray(changedRecordSparseObject, recordHasEntityWrapper);
    changedFieldIds = changedFieldElements
      .filter((element): element is Record<string, unknown> => isPlainObject(element))
      .map((element) => String(element['id']))
      .filter((fieldId) => fieldId !== 'undefined');
  }

  const updates: AffinityFieldValueUpdate[] = [];
  for (const fieldId of changedFieldIds) {
    const fieldSchema = fieldSchemasByFieldId[fieldId];
    if (fieldSchema === undefined) {
      throw new AffinityError(
        `Field "${fieldId}" is not in the table schema — re-pull the table to refresh the schema, then retry.`,
      );
    }
    if (fieldSchema[X_SCRATCH_READONLY] === true) {
      throw new AffinityError(
        `Field "${describeField(fieldSchema, fieldId)}" is computed by Affinity (enriched / relationship intelligence) and cannot be edited.`,
      );
    }

    const storedFieldEntry = storedFieldEntriesByFieldId.get(fieldId) as
      | { value?: { type?: string; data?: unknown; totalCount?: number } | null }
      | undefined;
    const valueTypeFromSchema = fieldSchema[X_SCRATCH_CONNECTOR_DATA_TYPE] as AffinityValueType | undefined;
    const valueType = valueTypeFromSchema ?? (storedFieldEntry?.value?.type as AffinityValueType | undefined);
    if (valueType === undefined) {
      throw new AffinityError(`Cannot determine the value type of field "${fieldId}" — write not attempted.`);
    }

    updates.push({
      id: fieldId,
      value: translateStoredFieldValueToWritePayload(valueType, storedFieldEntry?.value ?? null),
    });
  }
  return updates;
}

/** Whether a value is a plain (non-array, non-null) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the verbatim dynamic-fields **array** off a record (or its sparse diff).
 * Returns `[]` when absent or not an array (the field is stored verbatim as
 * `fields: [{ id, … }]`, top-level or under `entity`).
 */
function readFieldsArray(recordShapedObject: Record<string, unknown>, recordHasEntityWrapper: boolean): unknown[] {
  const fieldsParent = recordHasEntityWrapper
    ? (recordShapedObject['entity'] as Record<string, unknown> | undefined)
    : recordShapedObject;
  const fieldsArray = fieldsParent?.['fields'];
  return Array.isArray(fieldsArray) ? fieldsArray : [];
}

/** Index a verbatim `fields` array by each element's `id`. */
function indexFieldsArrayById(fieldsArray: unknown[]): Map<string, Record<string, unknown>> {
  const fieldEntriesByFieldId = new Map<string, Record<string, unknown>>();
  for (const element of fieldsArray) {
    if (!isPlainObject(element)) continue;
    // Match the keyed-array grammar: a field is addressed by a scalar `id`,
    // compared stringwise. Skip elements whose id is missing or non-scalar.
    const elementId = element['id'];
    if (typeof elementId === 'string' || typeof elementId === 'number') {
      fieldEntriesByFieldId.set(String(elementId), element);
    }
  }
  return fieldEntriesByFieldId;
}

/**
 * List the dotted paths in a sparse changed-fields object that fall OUTSIDE
 * the writable dynamic-fields container (`fields.*` / `entity.fields.*`).
 */
function collectChangedPathsOutsideFieldsContainer(
  changedRecordSparseObject: Record<string, unknown>,
  recordHasEntityWrapper: boolean,
): string[] {
  const unsupportedPaths: string[] = [];
  for (const topLevelKey of Object.keys(changedRecordSparseObject)) {
    if (!recordHasEntityWrapper) {
      if (topLevelKey !== 'fields') unsupportedPaths.push(topLevelKey);
      continue;
    }
    if (topLevelKey !== 'entity') {
      unsupportedPaths.push(topLevelKey);
      continue;
    }
    const changedEntity = changedRecordSparseObject['entity'];
    if (typeof changedEntity === 'object' && changedEntity !== null) {
      for (const entityKey of Object.keys(changedEntity)) {
        if (entityKey !== 'fields') unsupportedPaths.push(`entity.${entityKey}`);
      }
    }
  }
  return unsupportedPaths;
}

/** Human-readable field label for error messages: the field's display name when known, else its id. */
function describeField(fieldSchema: Record<string, unknown>, fieldId: string): string {
  const description = fieldSchema['description'];
  return typeof description === 'string' && description.length > 0 ? `${description} (${fieldId})` : fieldId;
}

// ---------------------------------------------------------------------------
// Note create assembly
// ---------------------------------------------------------------------------

/**
 * Build a `POST /v2/notes` request from a locally-created note record file.
 * The file supplies `content.html` and references its associations the same
 * way a pulled note does — preview objects with `data[].id`.
 */
export function buildNoteCreateRequestFromRecordFile(
  noteRecordFile: Record<string, unknown>,
): AffinityNoteCreateRequest {
  const contentHtml = (noteRecordFile['content'] as { html?: unknown } | undefined)?.html;
  if (typeof contentHtml !== 'string' || contentHtml.length === 0) {
    throw new AffinityError('A new note needs "content.html" (a non-empty HTML string).');
  }

  const personReferences = readAssociationIdsFromPreview(noteRecordFile['personsPreview']);
  const companyReferences = readAssociationIdsFromPreview(noteRecordFile['companiesPreview']);
  const opportunityReferences = readAssociationIdsFromPreview(noteRecordFile['opportunitiesPreview']);

  if (personReferences.length === 0 && companyReferences.length === 0 && opportunityReferences.length === 0) {
    throw new AffinityError(
      'A new note must be attached to at least one person, company, or opportunity — set "personsPreview", "companiesPreview", or "opportunitiesPreview" to { "data": [{ "id": <entity id> }] }.',
    );
  }

  return {
    type: 'entities',
    content: { html: contentHtml },
    ...(personReferences.length > 0 ? { persons: personReferences } : {}),
    ...(companyReferences.length > 0 ? { companies: companyReferences } : {}),
    ...(opportunityReferences.length > 0 ? { opportunities: opportunityReferences } : {}),
  };
}

/** Extract `{id}` references from a note preview object (`{ data: [{ id, … }] }`). */
function readAssociationIdsFromPreview(previewObject: unknown): Array<{ id: number }> {
  const previewData = (previewObject as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(previewData)) return [];
  const references: Array<{ id: number }> = [];
  for (const previewEntry of previewData) {
    const id = (previewEntry as { id?: unknown })?.id;
    if (typeof id === 'number') references.push({ id });
  }
  return references;
}

// ---------------------------------------------------------------------------
// v1 record-lifecycle payload builders (DEV-10298 phase 2)
//
// Records are stored v2-shaped; the v1 create/update endpoints take snake_case
// *basics* only. Field VALUES are never built here — the connector sets them
// through the v2 field-update path after the record exists.
// ---------------------------------------------------------------------------

/** Read a nullable string off a record, treating empty string as null. */
function readNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The email list to send to v1: the `emailAddresses` array, else the single `primaryEmailAddress`, else []. */
function readEmailsForWrite(personRecordFile: Record<string, unknown>): string[] {
  const emailAddresses = personRecordFile['emailAddresses'];
  if (Array.isArray(emailAddresses)) {
    return emailAddresses.filter((email): email is string => typeof email === 'string' && email.length > 0);
  }
  const primary = readNullableString(personRecordFile['primaryEmailAddress']);
  return primary ? [primary] : [];
}

/** Build the `POST /persons` body from a locally-created person record file. */
export function buildPersonCreatePayload(personRecordFile: Record<string, unknown>): AffinityV1PersonWrite {
  const firstName = readNullableString(personRecordFile['firstName']);
  const lastName = readNullableString(personRecordFile['lastName']);
  const emails = readEmailsForWrite(personRecordFile);
  if (firstName === null && lastName === null && emails.length === 0) {
    throw new AffinityError('A new person needs at least a first/last name or an email address.');
  }
  return { first_name: firstName, last_name: lastName, emails };
}

/** Build the `POST /organizations` body from a locally-created company record file. */
export function buildCompanyCreatePayload(companyRecordFile: Record<string, unknown>): AffinityV1OrganizationWrite {
  const name = readNullableString(companyRecordFile['name']);
  if (name === null) {
    throw new AffinityError('A new company needs a "name".');
  }
  return { name, domain: readNullableString(companyRecordFile['domain']) };
}

/** Build the `POST /opportunities` body — requires a `listId` (which opportunity-type list to create it in). */
export function buildOpportunityCreatePayload(
  opportunityRecordFile: Record<string, unknown>,
): AffinityV1OpportunityCreate {
  const name = readNullableString(opportunityRecordFile['name']);
  if (name === null) {
    throw new AffinityError('A new opportunity needs a "name".');
  }
  const listId = opportunityRecordFile['listId'];
  if (typeof listId !== 'number') {
    throw new AffinityError(
      'A new opportunity needs a numeric "listId" naming the opportunity-type list to create it in.',
    );
  }
  return { name, list_id: listId };
}

/**
 * Split a sparse changed-record object for a tenant person/company into the
 * **basics** that go to v1 and the **fields** that go to v2. Throws if a changed
 * top-level key is neither a writable basic nor `fields` (e.g. an edit to the
 * read-only `primaryEmailAddress` / `type` / `domains`) — refused, never dropped.
 */
export function splitChangedRecordIntoBasicsAndFields(
  changedRecordSparseObject: Record<string, unknown>,
  writableBasicKeys: ReadonlySet<string>,
): { basicsChanged: Record<string, unknown>; fieldsChangedSparse: Record<string, unknown> | undefined } {
  const basicsChanged: Record<string, unknown> = {};
  let fieldsChangedSparse: Record<string, unknown> | undefined;
  const unsupportedKeys: string[] = [];
  for (const key of Object.keys(changedRecordSparseObject)) {
    if (key === 'fields') {
      fieldsChangedSparse = { fields: changedRecordSparseObject['fields'] };
    } else if (writableBasicKeys.has(key)) {
      basicsChanged[key] = changedRecordSparseObject[key];
    } else {
      unsupportedKeys.push(key);
    }
  }
  if (unsupportedKeys.length > 0) {
    throw new AffinityError(
      `These edited fields are not writable on the Affinity API and were not published: ${unsupportedKeys.join(
        ', ',
      )}. Editable fields are the record's name/email basics and its Affinity field values.`,
    );
  }
  return { basicsChanged, fieldsChangedSparse };
}

/** Build a sparse `PUT /persons/{id}` basics body from the changed person basics (null = clear). */
export function buildPersonBasicsUpdatePayload(basicsChanged: Record<string, unknown>): AffinityV1PersonWrite | null {
  const body: AffinityV1PersonWrite = {};
  if ('firstName' in basicsChanged) body.first_name = readNullableString(basicsChanged['firstName']);
  if ('lastName' in basicsChanged) body.last_name = readNullableString(basicsChanged['lastName']);
  if ('emailAddresses' in basicsChanged) {
    const emails = basicsChanged['emailAddresses'];
    body.emails = Array.isArray(emails)
      ? emails.filter((email): email is string => typeof email === 'string' && email.length > 0)
      : [];
  }
  return Object.keys(body).length > 0 ? body : null;
}

/** Build a sparse `PUT /organizations/{id}` basics body from the changed company basics (null = clear). */
export function buildCompanyBasicsUpdatePayload(
  basicsChanged: Record<string, unknown>,
): AffinityV1OrganizationWrite | null {
  const body: AffinityV1OrganizationWrite = {};
  if ('name' in basicsChanged) body.name = readNullableString(basicsChanged['name']);
  if ('domain' in basicsChanged) body.domain = readNullableString(basicsChanged['domain']);
  return Object.keys(body).length > 0 ? body : null;
}

/** Build a `PUT /opportunities/{id}` body from the changed opportunity basics (name only). */
export function buildOpportunityBasicsUpdatePayload(
  basicsChanged: Record<string, unknown>,
): AffinityV1OpportunityWrite | null {
  if (!('name' in basicsChanged)) return null;
  const name = readNullableString(basicsChanged['name']);
  // Opportunity name is required by the service — refuse to clear it rather than send an invalid empty.
  if (name === null) {
    throw new AffinityError('An opportunity must have a name; clearing it is not allowed.');
  }
  return { name };
}

/**
 * Build v2 field-value updates for a **newly-created** record — every writable
 * field that has a non-empty value (a fresh record's empty fields aren't sent,
 * so we don't fire pointless null-clears at the service).
 */
export function buildNonEmptyFieldValueUpdatesForNewRecord(params: {
  fullRecordFile: Record<string, unknown>;
  tableSpecSchema: Record<string, unknown>;
  recordHasEntityWrapper: boolean;
}): AffinityFieldValueUpdate[] {
  const allWritableFieldUpdates = buildFieldValueUpdatesForChangedRecord({
    changedRecordSparseObject: undefined,
    ...params,
  });
  return allWritableFieldUpdates.filter((update) => {
    const data = update.value?.data;
    if (data === null || data === undefined) return false;
    if (Array.isArray(data) && data.length === 0) return false;
    return true;
  });
}
