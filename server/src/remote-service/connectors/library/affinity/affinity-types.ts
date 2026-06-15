/**
 * Types for the Affinity v2 API connector.
 *
 * Affinity is a relationship-intelligence CRM organized around Lists. Each List
 * holds entries (rows) of one entity type (`company`, `person`, or `opportunity`)
 * and exposes its own list-specific fields plus the entity's enriched / global /
 * relationship-intelligence fields. The connector models each Affinity list as a
 * Scratch table whose records are the list entries.
 *
 * v2 API docs: https://developer.affinity.co/
 */

/** The four field categories Affinity v2 supports. */
export type AffinityFieldType = 'enriched' | 'global' | 'list' | 'relationship-intelligence';

/** All field categories — passed to the list-entries endpoint to embed field data inline. */
export const FIELD_TYPES: readonly AffinityFieldType[] = ['list', 'enriched', 'global', 'relationship-intelligence'];

/**
 * Field categories valid on the tenant-wide `/v2/persons` and `/v2/companies`
 * endpoints. Note the absence of `'list'` — Affinity rejects it with HTTP 400
 * because tenant-wide records have no list context, so list-specific fields
 * don't apply. Empirically verified against `api.affinity.co` 2026-04-11; the
 * error message is `value at `/fieldTypes` is not one of:
 * ['enriched', 'global', 'relationship-intelligence']`.
 */
export const TENANT_FIELD_TYPES: readonly AffinityFieldType[] = ['enriched', 'global', 'relationship-intelligence'];

/** The entity types an Affinity list can hold. */
export type AffinityEntityType = 'company' | 'person' | 'opportunity';

/** A list, as returned by `GET /v2/lists`. */
export interface AffinityList {
  id: number;
  name: string;
  type: AffinityEntityType;
  isPublic: boolean;
  ownerId: number;
  creatorId: number;
}

/** Possible inner value types — see Affinity v2 OpenAPI `FieldMetadata.valueType`. */
export type AffinityValueType =
  | 'person'
  | 'person-multi'
  | 'company'
  | 'company-multi'
  | 'filterable-text'
  | 'filterable-text-multi'
  | 'number'
  | 'number-multi'
  | 'datetime'
  | 'location'
  | 'location-multi'
  | 'text'
  | 'ranked-dropdown'
  | 'dropdown'
  | 'dropdown-multi'
  | 'formula-number'
  | 'interaction';

/** Field metadata, as returned by `GET /v2/lists/{listId}/fields`. */
export interface AffinityFieldMetadata {
  id: string;
  name: string;
  type: AffinityFieldType;
  enrichmentSource: string | null;
  valueType: AffinityValueType;
}

/**
 * Pagination wrapper used by every paged response. The connector follows
 * `nextUrl` and extracts its `cursor` query parameter for the next page.
 */
export interface AffinityPagination {
  prevUrl?: string | null;
  nextUrl?: string | null;
}

export interface AffinityPagedResponse<T> {
  data: T[] | null;
  pagination: AffinityPagination;
}

/**
 * A single entry on a list. The shape is whatever the API returns — we treat
 * the entity sub-object as opaque so company/person/opportunity payloads pass
 * through untouched.
 */
export interface AffinityListEntry {
  id: number;
  type: AffinityEntityType;
  listId: number;
  createdAt: string;
  creatorId: number | null;
  entity: Record<string, unknown>;
}

/**
 * Discriminated union over the kinds of "tables" the connector exposes:
 * tenant-wide endpoints (persons, companies, opportunities, notes), entity
 * files (v1), plus user-created lists. Produced by `parseAffinityTableId`
 * and used to dispatch in `fetchJsonTableSpec`, `pullRecordFiles`, and
 * `pullRecordFilesByIds`.
 */
export type AffinityTableKind =
  | { kind: 'list'; listId: number }
  | { kind: 'tenant-persons' }
  | { kind: 'tenant-companies' }
  | { kind: 'tenant-opportunities' }
  | { kind: 'tenant-notes' }
  | { kind: 'tenant-entity-files' }
  | { kind: 'tenant-users' };

/**
 * A single record from `GET /v2/persons` — flat shape, no `entity` wrapper
 * (unlike list-entries). When `fieldTypes=…` is passed, `fields` is populated
 * with the same array shape that list-entry `entity.fields` has.
 */
export interface AffinityPerson {
  id: number;
  firstName: string | null;
  lastName: string | null;
  primaryEmailAddress: string | null;
  emailAddresses: string[];
  type: string | null;
  fields?: unknown;
}

/**
 * A single record from `GET /v2/companies` — flat shape, no `entity` wrapper.
 * When `fieldTypes=…` is passed, `fields` is populated with the same array
 * shape that list-entry `entity.fields` has.
 */
export interface AffinityCompany {
  id: number;
  name: string | null;
  domain: string | null;
  domains: string[];
  isGlobal: boolean;
  fields?: unknown;
}

/**
 * A single record from `GET /v2/opportunities`. The endpoint is intentionally
 * thin — Affinity v2 returns only `id`, `name`, `listId` here, with no field
 * data and no `/v2/opportunities/fields` metadata endpoint. Per-list custom
 * field data only exists via `GET /v2/lists/{listId}/list-entries`.
 */
export interface AffinityOpportunity {
  id: number;
  name: string | null;
  listId: number;
}

/**
 * A workspace teammate, from `GET /v2/users`. A read-only reference entity (the
 * people who have Affinity accounts in this org — distinct from `persons`, the
 * CRM contacts). Fixed shape, no custom fields.
 */
export interface AffinityUser {
  id: number;
  firstName: string | null;
  lastName: string | null;
  photoUrl: string | null;
  primaryEmailAddress: string | null;
  status: string;
  emailAddresses: string[];
  role: string;
}

// ---------------------------------------------------------------------------
// Interaction types — Calls, Chat Messages, Meetings, Notes
// ---------------------------------------------------------------------------

/** Person data embedded in interaction attendees/participants/creators. */
export interface AffinityPersonData {
  id: number;
  firstName: string | null;
  lastName: string | null;
  primaryEmailAddress: string | null;
  type: string | null;
}

/** A single record from `GET /v2/notes`. */
export interface AffinityNote {
  id: number;
  type: string;
  content: { html: string | null };
  creator: AffinityPersonData | null;
  mentions: Array<{ id: number; type: string; person: AffinityPersonData }>;
  createdAt: string;
  updatedAt: string | null;
  // Optional fields populated via `includes` query parameter:
  companiesPreview?: { data: Array<{ id: number; name: string; domain: string | null }>; totalCount: number };
  personsPreview?: { data: AffinityPersonData[]; totalCount: number };
  opportunitiesPreview?: { data: Array<{ id: number; name: string; listId: number }>; totalCount: number };
  repliesCount?: number;
  // Discriminated fields — present on interaction / ai-notetaker types:
  interaction?: { id: number; type: string };
  transcriptId?: number;
  parent?: { id: number };
}

// ---------------------------------------------------------------------------
// Entity Files (v1 API)
// ---------------------------------------------------------------------------

/** A single record from `GET /entity-files` (v1 API). */
export interface AffinityEntityFile {
  id: number;
  name: string;
  size: number;
  person_id: number | null;
  organization_id: number | null;
  opportunity_id: number | null;
  uploader_id: number;
  created_at: string;
}

/** Pagination wrapper for v1 entity-files responses. */
export interface AffinityV1PagedResponse<T> {
  entity_files: T[];
  next_page_token: string | null;
}

/** Resumable pull progress: just the cursor of the next page. */
export interface AffinityDownloadProgress {
  [key: string]: string | undefined;
  cursor?: string;
}

// ---------------------------------------------------------------------------
// Write types — Affinity v2 publishing (DEV-10298)
//
// The v2 API writes FIELD VALUES (not whole records) through batch endpoints:
//   PATCH /v2/persons/{id}/fields · PATCH /v2/companies/{id}/fields ·
//   PATCH /v2/lists/{listId}/list-entries/{entryId}/fields
// with body `{ operation: 'update-fields', updates: [{ id, value }] }` (≤100
// updates per request). Notes have full CRUD on /v2/notes. Whole-record
// create/delete (persons, companies, opportunities) and record basics
// (firstName, name, domain, …) are v1-API-only and not implemented yet.
// ---------------------------------------------------------------------------

/**
 * The write shape of a field value — `{ type, data }` where `data` carries
 * only the reference keys the API accepts on write (`{id}` for person/company,
 * `{dropdownOptionId}` for dropdowns), unlike the read shape which embeds
 * display decoration (name, domain, text, rank, color, totalCount, …).
 */
export interface AffinityFieldValueWritePayload {
  type: string;
  data: unknown;
}

/** One item in a v2 `update-fields` batch operation. */
export interface AffinityFieldValueUpdate {
  id: string;
  value: AffinityFieldValueWritePayload;
}

/** Sparse body for `POST /v2/notes/{noteId}` — only supplied properties are mutated. */
export interface AffinityNoteUpdateRequest {
  content?: { html: string };
  persons?: Array<{ id: number }>;
  companies?: Array<{ id: number }>;
  opportunities?: Array<{ id: number }>;
}

/**
 * Body for `POST /v2/notes` creating a note attached directly to entities.
 * Requires `content` and at least one association (the service rejects an
 * unattached note). The other note types (`interaction`, `user-reply`) are
 * not built from Scratch records.
 */
export interface AffinityNoteCreateRequest {
  type: 'entities';
  content: { html: string };
  persons?: Array<{ id: number }>;
  companies?: Array<{ id: number }>;
  opportunities?: Array<{ id: number }>;
}

// ---------------------------------------------------------------------------
// v1 record-lifecycle types (DEV-10298 phase 2)
//
// The Affinity v2 API writes only field values + Notes. Whole-record
// create/delete, record *basics* (firstName/name/domain/emails), opportunity
// create, and list membership live ONLY on the v1 API. The same Bearer token
// authorizes v1 (verified 2026-06-12). v1 responses are snake_case and use a
// numeric `type` (person=0, organization=1, opportunity=8). The connector only
// needs the assigned `id` off these — it re-reads the canonical record via the
// v2 path for the on-disk shape — but the full shapes are typed for clarity.
//
// Field VALUES on a created/updated record still go through the v2 field-update
// path, so this layer never touches the v1 field-values endpoint (and sidesteps
// its one-row-per-element multi-value model).
// ---------------------------------------------------------------------------

/** v1 numeric entity-type discriminator. */
export const AFFINITY_V1_ENTITY_TYPE = { person: 0, organization: 1, opportunity: 8 } as const;

/** `POST /persons` response (v1, snake_case). */
export interface AffinityV1Person {
  id: number;
  type: number;
  first_name: string | null;
  last_name: string | null;
  primary_email: string | null;
  emails: string[];
  organization_ids: number[];
}

/** `POST /organizations` response (v1, snake_case). The Companies table maps to v1 "organizations". */
export interface AffinityV1Organization {
  id: number;
  name: string | null;
  domain: string | null;
  domains: string[];
  global: boolean;
  person_ids: number[];
}

/** `POST /opportunities` response (v1). */
export interface AffinityV1Opportunity {
  id: number;
  name: string | null;
  list_entries?: unknown[];
  person_ids?: number[];
  organization_ids?: number[];
}

/** `POST /lists/{listId}/list-entries` response (v1). */
export interface AffinityV1ListEntry {
  id: number;
  list_id: number;
  creator_id: number | null;
  entity_id: number;
  entity_type: number;
  created_at: string;
}

/** Create/update body for `POST /persons` / `PUT /persons/{id}` (sparse for update). */
export interface AffinityV1PersonWrite {
  first_name?: string | null;
  last_name?: string | null;
  emails?: string[];
}

/** Create/update body for `POST /organizations` / `PUT /organizations/{id}` (sparse for update). */
export interface AffinityV1OrganizationWrite {
  name?: string | null;
  domain?: string | null;
}

/** Create body for `POST /opportunities` — requires an opportunity-type `list_id`. */
export interface AffinityV1OpportunityCreate {
  name: string;
  list_id: number;
}

/** Update body for `PUT /opportunities/{id}`. */
export interface AffinityV1OpportunityWrite {
  name?: string;
}

/**
 * One bucket of the quota response from `GET /rate-limit`. Identical shape for
 * the per-minute user bucket and the monthly org bucket.
 */
export interface AffinityQuotaBucket {
  limit: number;
  remaining: number;
  used: number;
  /** Seconds until this bucket resets (per-minute window or end of month). */
  reset: number;
}

/**
 * Response body of `GET /rate-limit`. Note this endpoint lives at the root of
 * api.affinity.co (no `/v2` prefix) — it's a v1-era endpoint, but it accepts
 * the same v2 Bearer token. The headers attached to every other v2 response
 * carry the same `limit`/`remaining`/`reset` values; this endpoint adds the
 * `used` count and is the right call when you want a fresh snapshot without
 * piggy-backing on another request.
 */
export interface AffinityQuota {
  rate: {
    api_key_per_minute: AffinityQuotaBucket;
    org_monthly: AffinityQuotaBucket;
  };
}
