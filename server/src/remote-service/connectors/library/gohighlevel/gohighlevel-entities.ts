/**
 * Registry of HighLevel location-scoped list entities that are exposed as
 * read-only tables via a single generic schema builder + generic paginated
 * pull (see the connector). Each entity here has a clean location-level list
 * endpoint that needs no extra required params beyond `locationId` (+ paging).
 *
 * Contacts / Opportunities / Pipelines / Custom Objects are NOT here — they
 * have their own dedicated, richer handling. Contact-scoped entities (Tasks,
 * Notes, Appointments) are intentionally excluded: they have no location-wide
 * list endpoint, so a table would require an N+1 fan-out over every contact.
 */
export interface GoHighLevelLocationListEntityConfig {
  /** Stable, path-safe table id. */
  wsId: string;
  displayName: string;
  description: string;
  /** Location-level list endpoint path, e.g. `/products/`. */
  listPath: string;
  /** Key under which the records array sits in the response, e.g. `products`. */
  responseArrayKey: string;
  /** The record's id field — most use `id`, some (`products`, `proposals`, blogs) use `_id`. */
  idField: 'id' | '_id';
  /**
   * How the endpoint paginates:
   * - `none`     — single unpaginated call
   * - `skip`     — `limit` + `skip` (skip = running record count)
   * - `offset`   — `limit` + `offset` (offset = running record count)
   * - `conversations` — `limit` + `startAfterDate`/`id` cursor (Conversations only)
   */
  pagination: 'none' | 'skip' | 'offset' | 'conversations';
  /**
   * Max records per page this endpoint accepts. HighLevel caps `limit` per
   * endpoint and the cap is NOT consistent — and the OpenAPI descriptions lie
   * (forms says "max 50" but accepts 100). Empirically verified: proposals=20,
   * surveys/blogs=50; everything else accepts our 100 default. Sending more
   * returns a 422 ("limit must not be greater than N") that silently fails the
   * whole folder pull. Omit to use the 100 default.
   */
  pageLimit?: number;
  /** Optional grouping in the table picker. */
  parentPath?: string;
}

export const GOHIGHLEVEL_LOCATION_LIST_ENTITIES: GoHighLevelLocationListEntityConfig[] = [
  {
    wsId: 'calendars',
    displayName: 'Calendars',
    description: 'Calendars in your HighLevel sub-account',
    listPath: '/calendars/',
    responseArrayKey: 'calendars',
    idField: 'id',
    pagination: 'none',
  },
  {
    wsId: 'calendar_groups',
    displayName: 'Calendar Groups',
    description: 'Calendar groups',
    listPath: '/calendars/groups',
    responseArrayKey: 'groups',
    idField: 'id',
    pagination: 'none',
    parentPath: 'Calendars',
  },
  {
    wsId: 'campaigns',
    displayName: 'Campaigns',
    description: 'Marketing campaigns',
    listPath: '/campaigns/',
    responseArrayKey: 'campaigns',
    idField: 'id',
    pagination: 'none',
  },
  {
    wsId: 'conversations',
    displayName: 'Conversations',
    description: 'Conversations in your HighLevel sub-account',
    listPath: '/conversations/search',
    responseArrayKey: 'conversations',
    idField: 'id',
    pagination: 'conversations',
  },
  {
    wsId: 'forms',
    displayName: 'Forms',
    description: 'Forms in your HighLevel sub-account',
    listPath: '/forms/',
    responseArrayKey: 'forms',
    idField: 'id',
    pagination: 'skip',
  },
  {
    wsId: 'trigger_links',
    displayName: 'Trigger Links',
    description: 'Trigger links',
    listPath: '/links/',
    responseArrayKey: 'links',
    idField: 'id',
    pagination: 'none',
  },
  {
    wsId: 'products',
    displayName: 'Products',
    description: 'Products in your HighLevel sub-account',
    listPath: '/products/',
    responseArrayKey: 'products',
    idField: '_id',
    pagination: 'offset',
  },
  {
    wsId: 'proposals',
    displayName: 'Proposals',
    description: 'Proposal & estimate documents',
    listPath: '/proposals/document',
    responseArrayKey: 'documents',
    idField: '_id',
    pagination: 'skip',
    pageLimit: 20, // endpoint caps at 20 ("limit must not be greater than 21")
  },
  {
    wsId: 'surveys',
    displayName: 'Surveys',
    description: 'Surveys in your HighLevel sub-account',
    listPath: '/surveys/',
    responseArrayKey: 'surveys',
    idField: 'id',
    pagination: 'skip',
    pageLimit: 50, // endpoint caps at 50
  },
  {
    wsId: 'users',
    displayName: 'Users',
    description: 'Users in your HighLevel sub-account (reference data)',
    listPath: '/users/',
    responseArrayKey: 'users',
    idField: 'id',
    pagination: 'none',
  },
  {
    wsId: 'workflows',
    displayName: 'Workflows',
    description: 'Workflows in your HighLevel sub-account',
    listPath: '/workflows/',
    responseArrayKey: 'workflows',
    idField: 'id',
    pagination: 'none',
  },
  {
    wsId: 'blog_authors',
    displayName: 'Blog Authors',
    description: 'Blog authors',
    listPath: '/blogs/authors',
    responseArrayKey: 'authors',
    idField: '_id',
    pagination: 'offset',
    pageLimit: 50, // endpoint caps at 50
    parentPath: 'Blog',
  },
  {
    wsId: 'blog_categories',
    displayName: 'Blog Categories',
    description: 'Blog categories',
    listPath: '/blogs/categories',
    responseArrayKey: 'categories',
    idField: '_id',
    pagination: 'offset',
    pageLimit: 50, // endpoint caps at 50
    parentPath: 'Blog',
  },
];

/** wsId → config lookup for dispatch in the connector. */
export const GOHIGHLEVEL_LOCATION_LIST_ENTITY_BY_WS_ID: ReadonlyMap<string, GoHighLevelLocationListEntityConfig> =
  new Map(GOHIGHLEVEL_LOCATION_LIST_ENTITIES.map((entity) => [entity.wsId, entity]));
