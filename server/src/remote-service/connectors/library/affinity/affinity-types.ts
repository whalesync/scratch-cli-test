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

/** Resumable pull progress: just the cursor of the next page. */
export interface AffinityDownloadProgress {
  [key: string]: string | undefined;
  cursor?: string;
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
