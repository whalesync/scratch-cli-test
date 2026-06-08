/**
 * Types for the Pipedrive API connector.
 *
 * Pipedrive is a sales CRM. We support two families of object types:
 *
 * - **v2 entities** (deals, persons, organizations, products, activities): served
 *   by the modern `https://api.pipedrive.com/api/v2` API — cursor pagination,
 *   custom fields nested under a `custom_fields` object, `PATCH` updates, integer
 *   ids, and fully dynamic schemas discovered from a per-entity `*Fields` endpoint.
 * - **v2 config entities** (pipelines, stages): also on the v2 API (cursor
 *   pagination, integer ids, `PATCH`) but with no Fields endpoint (static schema,
 *   no custom fields) and no `updated_since` filter, so they are full-pull only.
 * - **v1 entities** (leads, notes): only available on the legacy
 *   `https://api.pipedrive.com/v1` API — offset pagination
 *   (`additional_data.pagination`), custom fields as **top-level hash keys**
 *   (flat) rather than nested, and per-object quirks (leads use a UUID id and
 *   `PATCH`; notes use `PUT`, have no Fields endpoint and no custom fields).
 *
 * Each v2 entity (and leads, which shares deals' custom fields) can have
 * user-defined custom fields discovered via the v2 Fields API.
 */

/**
 * Supported Pipedrive entity types.
 */
export type PipedriveEntityType =
  | 'deals'
  | 'persons'
  | 'organizations'
  | 'products'
  | 'activities'
  | 'leads'
  | 'notes'
  | 'pipelines'
  | 'stages';

/**
 * All supported entity types.
 */
export const ENTITY_TYPES: PipedriveEntityType[] = [
  'deals',
  'persons',
  'organizations',
  'products',
  'activities',
  'leads',
  'notes',
  'pipelines',
  'stages',
];

/** Which Pipedrive REST API version an entity is served by. */
export type PipedriveApiVersion = 'v1' | 'v2';

/**
 * Where custom fields live in a record's JSON shape:
 * - `nested`: under a `custom_fields` object (v2 entities)
 * - `flat`: as top-level 40-char hash keys directly on the record (v1 entities, e.g. leads)
 * - `none`: the entity has no custom fields (notes)
 */
export type PipedriveCustomFieldPlacement = 'nested' | 'flat' | 'none';

/** Pagination mechanism of an entity's list endpoint. */
export type PipedrivePaginationStyle = 'cursor' | 'offset';

/** Whether the entity's `id` is an integer (most objects) or a UUID string (leads). */
export type PipedriveIdType = 'integer' | 'uuid';

/**
 * Per-entity configuration metadata. This single table drives the API client
 * (paths, verbs, pagination), the schema builder (dynamic vs static fields,
 * custom-field placement), and the connector (id handling).
 */
export interface PipedriveEntityConfig {
  displayName: string;
  /** Field used to suggest a record filename. Omitted when the entity has no natural title (notes). */
  titleField?: string;
  idField: string;
  apiVersion: PipedriveApiVersion;
  /** Collection segment of the REST path, e.g. `deals` → `/api/v2/deals`, `leads` → `/v1/leads`. */
  collectionPath: string;
  /**
   * The v2 `*Fields` endpoint segment used to discover fields, or `null` when the
   * entity has no Fields endpoint (notes). Always read from the v2 API even for
   * v1 entities — leads share deals' custom fields, so leads point at `dealFields`.
   */
  fieldsCollectionPath: string | null;
  /**
   * Whether the entity's **system** fields come from the Fields endpoint (true:
   * deals/persons/organizations/products/activities) or from a hardcoded static
   * schema (false: leads/notes/pipelines/stages, whose system shape isn't
   * introspectable). Custom fields are still taken dynamically from
   * `fieldsCollectionPath` regardless.
   */
  useDynamicSystemFields: boolean;
  customFieldPlacement: PipedriveCustomFieldPlacement;
  paginationStyle: PipedrivePaginationStyle;
  idType: PipedriveIdType;
  /** HTTP verb for updates: v2 entities and leads use PATCH; notes use PUT. */
  updateVerb: 'PATCH' | 'PUT';
  /**
   * Whether the entity's list endpoint accepts the `updated_since` filter for
   * incremental pulls. True for every object with an indexed `update_time`; false
   * for the pipeline/stage config endpoints, which reject `updated_since` (HTTP
   * 400) and so are always full-pulled.
   */
  supportsIncremental: boolean;
}

/**
 * Config for each entity type.
 */
export const ENTITY_CONFIG: Record<PipedriveEntityType, PipedriveEntityConfig> = {
  deals: {
    displayName: 'Deals',
    titleField: 'title',
    idField: 'id',
    apiVersion: 'v2',
    collectionPath: 'deals',
    fieldsCollectionPath: 'dealFields',
    useDynamicSystemFields: true,
    customFieldPlacement: 'nested',
    paginationStyle: 'cursor',
    idType: 'integer',
    updateVerb: 'PATCH',
    supportsIncremental: true,
  },
  persons: {
    displayName: 'Persons',
    titleField: 'name',
    idField: 'id',
    apiVersion: 'v2',
    collectionPath: 'persons',
    fieldsCollectionPath: 'personFields',
    useDynamicSystemFields: true,
    customFieldPlacement: 'nested',
    paginationStyle: 'cursor',
    idType: 'integer',
    updateVerb: 'PATCH',
    supportsIncremental: true,
  },
  organizations: {
    displayName: 'Organizations',
    titleField: 'name',
    idField: 'id',
    apiVersion: 'v2',
    collectionPath: 'organizations',
    fieldsCollectionPath: 'organizationFields',
    useDynamicSystemFields: true,
    customFieldPlacement: 'nested',
    paginationStyle: 'cursor',
    idType: 'integer',
    updateVerb: 'PATCH',
    supportsIncremental: true,
  },
  products: {
    displayName: 'Products',
    titleField: 'name',
    idField: 'id',
    apiVersion: 'v2',
    collectionPath: 'products',
    fieldsCollectionPath: 'productFields',
    useDynamicSystemFields: true,
    customFieldPlacement: 'nested',
    paginationStyle: 'cursor',
    idType: 'integer',
    updateVerb: 'PATCH',
    supportsIncremental: true,
  },
  activities: {
    displayName: 'Activities',
    titleField: 'subject',
    idField: 'id',
    apiVersion: 'v2',
    collectionPath: 'activities',
    fieldsCollectionPath: 'activityFields',
    useDynamicSystemFields: true,
    customFieldPlacement: 'nested',
    paginationStyle: 'cursor',
    idType: 'integer',
    updateVerb: 'PATCH',
    supportsIncremental: true,
  },
  leads: {
    displayName: 'Leads',
    titleField: 'title',
    idField: 'id',
    apiVersion: 'v1',
    collectionPath: 'leads',
    // Leads have no dedicated Fields endpoint; they SHARE deals' custom fields, so
    // we discover custom fields from `dealFields`. Their system shape differs from
    // deals (UUID id, value:{amount,currency}, label_ids, …) and isn't
    // introspectable, so system fields come from a static schema.
    fieldsCollectionPath: 'dealFields',
    useDynamicSystemFields: false,
    // v1 records carry custom fields as top-level hash keys, not nested.
    customFieldPlacement: 'flat',
    paginationStyle: 'offset',
    idType: 'uuid',
    updateVerb: 'PATCH',
    supportsIncremental: true,
  },
  notes: {
    displayName: 'Notes',
    // Notes have no natural title (their body is free-form HTML); fall back to id.
    idField: 'id',
    apiVersion: 'v1',
    collectionPath: 'notes',
    // No noteFields endpoint and notes don't support custom fields.
    fieldsCollectionPath: null,
    useDynamicSystemFields: false,
    customFieldPlacement: 'none',
    paginationStyle: 'offset',
    idType: 'integer',
    updateVerb: 'PUT',
    supportsIncremental: true,
  },
  pipelines: {
    displayName: 'Pipelines',
    titleField: 'name',
    idField: 'id',
    apiVersion: 'v2',
    collectionPath: 'pipelines',
    // No pipelineFields endpoint and pipelines have no custom fields.
    fieldsCollectionPath: null,
    useDynamicSystemFields: false,
    customFieldPlacement: 'none',
    paginationStyle: 'cursor',
    idType: 'integer',
    updateVerb: 'PATCH',
    // The v2 pipelines endpoint rejects `updated_since` (HTTP 400) — full pull only.
    supportsIncremental: false,
  },
  stages: {
    displayName: 'Stages',
    titleField: 'name',
    idField: 'id',
    apiVersion: 'v2',
    collectionPath: 'stages',
    // No stageFields endpoint and stages have no custom fields.
    fieldsCollectionPath: null,
    useDynamicSystemFields: false,
    customFieldPlacement: 'none',
    paginationStyle: 'cursor',
    idType: 'integer',
    updateVerb: 'PATCH',
    // The v2 stages endpoint rejects `updated_since` (HTTP 400) — full pull only.
    supportsIncremental: false,
  },
};

/**
 * Display names for entity types.
 */
export const ENTITY_DISPLAY_NAMES: Record<PipedriveEntityType, string> = {
  deals: 'Deals',
  persons: 'Persons',
  organizations: 'Organizations',
  products: 'Products',
  activities: 'Activities',
  leads: 'Leads',
  notes: 'Notes',
  pipelines: 'Pipelines',
  stages: 'Stages',
};

/**
 * A field definition from the Pipedrive Fields API (v2).
 */
export interface PipedriveField {
  field_name: string;
  field_code: string;
  field_type: string;
  is_custom_field: boolean;
  options?: { id?: number; label?: string }[] | null;
  subfields?: { field_code?: string; field_name?: string; field_type?: string }[] | null;
}

/**
 * Download progress for resumable pulls. Cursor-paginated entities (v2) resume
 * from `nextCursor`; offset-paginated entities (v1 leads/notes) resume from
 * `nextStart` (the `additional_data.pagination.next_start` index).
 */
export interface PipedriveDownloadProgress {
  [key: string]: string | number | undefined;
  nextCursor?: string;
  nextStart?: number;
}

/**
 * Coerce a record's `id` into the type Pipedrive expects on the wire for the
 * given entity: a trimmed UUID string for leads, a parsed integer for everything
 * else. Returns `null` when the id is missing or (for integer entities)
 * non-numeric, so callers can warn-and-skip rather than send a malformed request.
 */
export function coercePipedriveEntityId(entityType: PipedriveEntityType, rawId: unknown): string | number | null {
  if (ENTITY_CONFIG[entityType].idType === 'uuid') {
    if (typeof rawId === 'number') return String(rawId);
    if (typeof rawId !== 'string') return null;
    const trimmed = rawId.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof rawId === 'number') return Number.isNaN(rawId) ? null : Math.trunc(rawId);
  if (typeof rawId !== 'string') return null;
  const asNumber = parseInt(rawId, 10);
  return Number.isNaN(asNumber) ? null : asNumber;
}
