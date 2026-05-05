/**
 * Types for the Attio v2 API connector.
 *
 * Attio is a CRM organized around three layers:
 *   - **Objects** — typed entity collections. Standard objects are `companies`,
 *     `people`, `deals`, `users`, `workspaces`, etc. Workspaces can also define
 *     custom objects, but custom objects are out of scope for v1.
 *   - **Attributes** — typed fields on an object (`text`, `select`, `status`,
 *     `record-reference`, `personal-name`, etc.). Custom fields are added by
 *     the user and surface alongside built-ins through the same endpoint.
 *   - **Lists** — first-class containers built on top of objects. A list holds
 *     entries (each wrapping a parent object record) and can define its own
 *     list-scoped attributes (e.g. a deal's *stage in this pipeline*) in
 *     addition to the parent object's attributes. List-scoped attributes are
 *     where Karst's deal stages live; the connector must round-trip them.
 *
 * v2 API docs: https://docs.attio.com/rest-api/overview
 */

/** A standard object slug we ship as a fixed table in v1. */
export type AttioStandardObject = 'companies' | 'people' | 'deals';

/** The three standard objects exposed in v1. Custom objects are deferred to v2. */
export const STANDARD_OBJECTS: readonly AttioStandardObject[] = ['companies', 'people', 'deals'];

/** Display labels for the standard objects, in the order they appear in the picker. */
export const STANDARD_OBJECT_DISPLAY: Record<AttioStandardObject, { singular: string; plural: string }> = {
  companies: { singular: 'Company', plural: 'Companies' },
  people: { singular: 'Person', plural: 'People' },
  deals: { singular: 'Deal', plural: 'Deals' },
};

/**
 * A response wrapper used by every Attio v2 endpoint:
 *   `{ "data": <T> }` or `{ "data": [<T>] }`.
 */
export interface AttioEnvelope<T> {
  data: T;
}

/**
 * The id object Attio attaches to records, lists, attributes, and entries.
 * Attio identifies things by a (workspace_id, object_id, record_id) tuple — we
 * carry the whole thing through verbatim so round-trip writes can address them.
 */
export interface AttioRecordId {
  workspace_id: string;
  object_id: string;
  record_id: string;
}

export interface AttioListId {
  workspace_id: string;
  list_id: string;
}

export interface AttioListEntryId {
  workspace_id: string;
  list_id: string;
  entry_id: string;
}

export interface AttioAttributeId {
  workspace_id: string;
  object_id: string;
  attribute_id: string;
}

/**
 * One Attio object (`GET /v2/objects` / `GET /v2/objects/{slug}`). The shape is
 * passed through verbatim — the connector keys off `api_slug` for routing.
 */
export interface AttioObject {
  id: { workspace_id: string; object_id: string };
  api_slug: string;
  singular_noun: string;
  plural_noun: string;
  created_at: string;
}

/**
 * One Attio list (`GET /v2/lists`). Lists are scoped to a single object type
 * (`parent_object`) and have their own per-entry attributes addressable via the
 * lists-attributes endpoint.
 */
export interface AttioList {
  id: AttioListId;
  api_slug: string;
  name: string;
  parent_object: string[]; // array of api_slugs, typically a single entry
  workspace_access: string | null;
  created_at: string;
}

/**
 * One attribute definition (`GET /v2/objects/{slug}/attributes` or
 * `GET /v2/lists/{slug}/attributes`). The `type` discriminates the value shape
 * stored under `record.values[api_slug]`.
 *
 * The `is_archived`, `is_required`, and `is_unique` flags drive read-only and
 * validation semantics in the schema we generate.
 */
export interface AttioAttribute {
  id: AttioAttributeId | { workspace_id: string; list_id: string; attribute_id: string };
  api_slug: string;
  title: string;
  description: string | null;
  type: AttioAttributeType;
  is_system_attribute: boolean;
  is_archived: boolean;
  is_required: boolean;
  is_unique: boolean;
  is_multiselect: boolean;
  /** Present on list-scoped attributes when the attribute exists on the parent object. */
  is_writable?: boolean;
  default_value: unknown;
  config: Record<string, unknown> | null;
  created_at: string;
}

/**
 * The set of attribute types the v2 API exposes. We don't try to model every
 * inner-value shape — those are passed through verbatim in `record.values` so
 * the on-disk file is a faithful copy of the API response.
 */
export type AttioAttributeType =
  | 'text'
  | 'number'
  | 'checkbox'
  | 'currency'
  | 'date'
  | 'timestamp'
  | 'rating'
  | 'status'
  | 'select'
  | 'record-reference'
  | 'actor-reference'
  | 'location'
  | 'domain'
  | 'email-address'
  | 'phone-number'
  | 'personal-name'
  | 'interaction'
  | 'record-id';

/**
 * One Attio record (`POST /v2/objects/{slug}/records/query` or
 * `GET /v2/objects/{slug}/records/{id}`).
 *
 * Note: Attio names the field bag `values`, not `fields` — and every value is
 * an *array* of typed objects (multi-value support). The connector preserves
 * both quirks on disk so writes can replay verbatim.
 */
export interface AttioRecord {
  id: AttioRecordId;
  values: Record<string, AttioFieldValue[]>;
  created_at: string;
  web_url?: string;
}

/**
 * One Attio list entry (`POST /v2/lists/{slug}/entries/query`).
 *
 * Entries point to a parent record under `parent_record_id` / `parent_object`
 * and carry list-scoped attribute values under `entry_values`. The parent's
 * own attribute values are intentionally *not* embedded — companies/people/
 * deals are first-class tables in the same workbook, so duplicating their
 * data inside every list entry would just churn diffs and confuse readers.
 * Joins happen at read time via `parent_record_id`.
 */
export interface AttioListEntry {
  id: AttioListEntryId;
  parent_record_id: string;
  parent_object: string;
  created_at: string;
  entry_values: Record<string, AttioFieldValue[]>;
}

/**
 * The opaque-ish shape of one entry in `record.values[api_slug]`. The API
 * always returns objects with `attribute_type`, `active_from`, `active_until`,
 * `created_by_actor`, plus a type-specific value payload (e.g. `value`, `option`,
 * `target_record_id`, etc.). We keep this permissive so the on-disk record
 * preserves whatever shape the API returned, and round-trip writes can replay
 * it verbatim.
 */
export interface AttioFieldValue {
  attribute_type: AttioAttributeType;
  active_from: string | null;
  active_until: string | null;
  created_by_actor?: { type: string; id: string | null } | null;
  [key: string]: unknown;
}

/**
 * Discriminated union over the kinds of "tables" the Attio connector exposes.
 * The dispatch function (`parseAttioTableId`) checks for the fixed standard-
 * object slugs first, then falls through to list-id parsing.
 */
export type AttioTableKind = { kind: 'object'; objectSlug: AttioStandardObject } | { kind: 'list'; listSlug: string };

/**
 * Resumable pull progress: the `offset` of the next page (Attio uses
 * limit+offset on POST `/records/query` and POST `/entries/query`).
 */
export interface AttioDownloadProgress {
  [key: string]: string | number | undefined;
  offset?: number;
}
