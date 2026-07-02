/**
 * Types for the HighLevel (GoHighLevel) v2 API connector.
 *
 * Covers the three read-only tables: Contacts, Opportunities, Pipelines.
 */

/**
 * A contact custom-field DEFINITION, as returned by
 * `GET /locations/{locationId}/customFields`. This describes the field (its
 * name, key, type, options) — it is NOT the per-contact value. The value lives
 * on each contact under `customFields` as a `{ id, value }` pair keyed by the
 * definition's `id`.
 *
 * The same endpoint returns definitions for both the `contact` and
 * `opportunity` models; the Contacts table filters to `model === 'contact'`.
 */
export interface GoHighLevelCustomFieldDefinition {
  id: string;
  name?: string;
  fieldKey?: string;
  placeholder?: string;
  /** e.g. TEXT, LARGE_TEXT, NUMERICAL, PHONE, MONETORY, SINGLE_OPTIONS, MULTIPLE_OPTIONS, DATE, CHECKBOX, FILE_UPLOAD, ... */
  dataType?: string;
  position?: number;
  picklistOptions?: string[];
  model?: 'contact' | 'opportunity';
}

/** Response of `GET /locations/{locationId}/customFields`. */
export interface GoHighLevelCustomFieldsListResponse {
  customFields?: GoHighLevelCustomFieldDefinition[];
}

/**
 * A contact record, stored verbatim as the HighLevel API returns it. We only
 * type the fields we reference; everything else is preserved (the JSON table
 * spec sets `additionalProperties: true`).
 *
 * NOTE: search responses also carry a `searchAfter` cursor on each contact —
 * that is pagination transport, not contact data, and is stripped before the
 * record is stored (see the connector's `pullRecordFiles`).
 */
export type GoHighLevelContact = Record<string, unknown> & {
  id?: string;
  /** Elasticsearch sort cursor present on search-response items; stripped before storage. */
  searchAfter?: unknown[];
};

/** Response of `POST /contacts/search`. */
export interface GoHighLevelContactsSearchResponse {
  contacts?: GoHighLevelContact[];
  /** Total matching contacts. Some API/doc versions label this `count`. */
  total?: number;
  count?: number;
}

/** Response of `GET /contacts/{contactId}`. */
export interface GoHighLevelContactByIdResponse {
  contact?: GoHighLevelContact;
}

/**
 * Resumable-pull progress for Contacts. `searchAfter` is the cursor of the last
 * contact returned by the previous page; passing it back resumes the scan.
 */
export interface GoHighLevelContactsDownloadProgress {
  searchAfter?: (string | number)[];
}

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

/**
 * An opportunity record, stored verbatim. Only referenced fields are typed;
 * everything else is preserved (`additionalProperties: true`).
 *
 * NOTE: opportunity custom-field values use the key `fieldValue` (contacts use
 * `value`).
 */
export type GoHighLevelOpportunity = Record<string, unknown> & {
  id?: string;
};

/** The `meta` block on `GET /opportunities/search`. */
export interface GoHighLevelOpportunitiesSearchMeta {
  total?: number;
  nextPageUrl?: string;
  /** Cursor: createdAt-derived timestamp of the last record. */
  startAfter?: number;
  /** Cursor: id of the last record. */
  startAfterId?: string;
  currentPage?: number;
  nextPage?: number;
  prevPage?: number;
}

/** Response of `GET /opportunities/search`. */
export interface GoHighLevelOpportunitiesSearchResponse {
  opportunities?: GoHighLevelOpportunity[];
  meta?: GoHighLevelOpportunitiesSearchMeta;
}

/** Response of `GET /opportunities/{id}`. */
export interface GoHighLevelOpportunityByIdResponse {
  opportunity?: GoHighLevelOpportunity;
}

/**
 * Resumable-pull progress for Opportunities. The `GET /opportunities/search`
 * endpoint paginates with a `startAfter` (timestamp) + `startAfterId` (id) pair
 * carried in the response `meta` — NOT the contacts `searchAfter` array.
 */
export interface GoHighLevelOpportunitiesDownloadProgress {
  startAfter?: number;
  startAfterId?: string;
}

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

/** A pipeline record (with its stages), stored verbatim. Read-only. */
export type GoHighLevelPipeline = Record<string, unknown> & {
  id?: string;
};

/** Response of `GET /opportunities/pipelines`. */
export interface GoHighLevelPipelinesResponse {
  pipelines?: GoHighLevelPipeline[];
}

// ---------------------------------------------------------------------------
// Custom / standard objects (the "Objects" API)
// ---------------------------------------------------------------------------

/**
 * An object DEFINITION from `GET /objects/`. Covers both custom objects
 * (`standard: false`, key prefixed `custom_objects.`) and standard objects
 * (`standard: true`, e.g. `contact`, `opportunity`, `business`).
 */
export interface GoHighLevelObjectDefinition {
  id?: string;
  /** false for custom objects, true for standard ones (contacts/opportunities/business). */
  standard?: boolean;
  /** Internal key used in record/search URLs, e.g. `custom_objects.pet`. */
  key?: string;
  labels?: { singular?: string; plural?: string };
  description?: string;
  locationId?: string;
  /** e.g. `custom_objects.pet.name` — the field used as the record's display title. */
  primaryDisplayProperty?: string;
}

/** Response of `GET /objects/`. */
export interface GoHighLevelObjectsListResponse {
  objects?: GoHighLevelObjectDefinition[];
}

/** A single option for a SINGLE_OPTIONS / MULTIPLE_OPTIONS / RADIO / CHECKBOX field. */
export interface GoHighLevelObjectFieldOption {
  key?: string;
  label?: string;
}

/**
 * A field DEFINITION for an object, from `GET /objects/{key}?fetchProperties=true`.
 * Record values live under the record's `properties` bag keyed by `fieldKey`.
 */
export interface GoHighLevelObjectField {
  id?: string;
  name?: string;
  /** The key used inside a record's `properties` object. */
  fieldKey?: string;
  /** e.g. TEXT, LARGE_TEXT, NUMERICAL, PHONE, MONETORY, SINGLE_OPTIONS, MULTIPLE_OPTIONS, ... */
  dataType?: string;
  /** `true` = a built-in/standard object field (e.g. `business.name`); `false` = a user-defined custom field. */
  standard?: boolean;
  description?: string;
  options?: GoHighLevelObjectFieldOption[];
}

/** Response of `GET /objects/{key}?fetchProperties=true`. */
export interface GoHighLevelObjectSchemaResponse {
  object?: GoHighLevelObjectDefinition;
  fields?: GoHighLevelObjectField[];
}

/**
 * An object record, stored verbatim. Custom-field values live in the keyed
 * `properties` bag (keyed by field — unlike contacts' `{ id, value }` array).
 */
export type GoHighLevelObjectRecord = Record<string, unknown> & {
  id?: string;
};

/** Response of `POST /objects/{schemaKey}/records/search`. */
export interface GoHighLevelObjectRecordsSearchResponse {
  records?: GoHighLevelObjectRecord[];
  total?: number;
}

/** Response of `GET /objects/{schemaKey}/records/{id}`. */
export interface GoHighLevelObjectRecordByIdResponse {
  record?: GoHighLevelObjectRecord;
}

/**
 * Resumable-pull progress for object records. The records-search endpoint
 * paginates by `page`; we checkpoint the next page to fetch.
 */
export interface GoHighLevelObjectRecordsDownloadProgress {
  page?: number;
}
