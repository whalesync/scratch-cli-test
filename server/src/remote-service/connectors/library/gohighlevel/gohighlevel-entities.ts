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

/** Primitive class for a generic entity field (typed from the OpenAPI response DTO). */
export type GenericFieldType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'unknown';

/** One enumerated field of a generic entity: key + JSON type, optionally a foreign key. */
export interface GoHighLevelGenericEntityField {
  key: string;
  type: GenericFieldType;
  /**
   * When set, the column is annotated as a foreign key into this Scratch table
   * (the target entity's `wsId`), so it's recognized as a reference to another
   * table rather than a plain string. e.g. Calendars `formId` → `forms`,
   * `groupId` → `calendar_groups`.
   */
  foreignKeyTableId?: string;
}

/**
 * Static field list per generic read-only entity, enumerated from HighLevel's
 * published OpenAPI response DTOs. These entities have NO field-metadata endpoint
 * (see STATE.md → Endpoints), so their columns are hardcoded here rather
 * than discovered at runtime. Drives the table view (records show real fields, not
 * just the id); `additionalProperties` still passes through anything not listed.
 */
export const GOHIGHLEVEL_ENTITY_FIELDS: Record<string, ReadonlyArray<GoHighLevelGenericEntityField>> = {
  calendars: [
    { key: 'isActive', type: 'boolean' },
    { key: 'notifications', type: 'array' },
    { key: 'locationId', type: 'string' },
    { key: 'groupId', type: 'string', foreignKeyTableId: 'calendar_groups' },
    { key: 'teamMembers', type: 'array' },
    { key: 'eventType', type: 'string' },
    { key: 'name', type: 'string' },
    { key: 'description', type: 'string' },
    { key: 'slug', type: 'string' },
    { key: 'widgetSlug', type: 'string' },
    { key: 'calendarType', type: 'string' },
    { key: 'widgetType', type: 'string' },
    { key: 'eventTitle', type: 'string' },
    { key: 'eventColor', type: 'string' },
    { key: 'meetingLocation', type: 'string' },
    { key: 'locationConfigurations', type: 'array' },
    { key: 'slotDuration', type: 'number' },
    { key: 'slotDurationUnit', type: 'string' },
    { key: 'slotInterval', type: 'number' },
    { key: 'slotIntervalUnit', type: 'string' },
    { key: 'slotBuffer', type: 'number' },
    { key: 'slotBufferUnit', type: 'string' },
    { key: 'preBuffer', type: 'number' },
    { key: 'preBufferUnit', type: 'string' },
    { key: 'appoinmentPerSlot', type: 'number' },
    { key: 'appoinmentPerDay', type: 'number' },
    { key: 'allowBookingAfter', type: 'number' },
    { key: 'allowBookingAfterUnit', type: 'string' },
    { key: 'allowBookingFor', type: 'number' },
    { key: 'allowBookingForUnit', type: 'string' },
    // HighLevel returns openHours as an ARRAY of open-hour blocks when the calendar
    // has hours configured, but as an empty OBJECT `{}` when it doesn't — so neither
    // a pure array nor object schema fits. `unknown` accepts the verbatim value either
    // way (a fresh pull of an unconfigured calendar otherwise fails validation).
    { key: 'openHours', type: 'unknown' },
    { key: 'enableRecurring', type: 'boolean' },
    { key: 'recurring', type: 'object' },
    { key: 'formId', type: 'string', foreignKeyTableId: 'forms' },
    { key: 'stickyContact', type: 'boolean' },
    { key: 'isLivePaymentMode', type: 'boolean' },
    { key: 'autoConfirm', type: 'boolean' },
    { key: 'shouldSendAlertEmailsToAssignedMember', type: 'boolean' },
    { key: 'alertEmail', type: 'string' },
    { key: 'googleInvitationEmails', type: 'boolean' },
    { key: 'allowReschedule', type: 'boolean' },
    { key: 'allowCancellation', type: 'boolean' },
    { key: 'shouldAssignContactToTeamMember', type: 'boolean' },
    { key: 'shouldSkipAssigningContactForExisting', type: 'boolean' },
    { key: 'notes', type: 'string' },
    { key: 'pixelId', type: 'string' },
    { key: 'formSubmitType', type: 'string' },
    { key: 'formSubmitRedirectURL', type: 'string' },
    { key: 'formSubmitThanksMessage', type: 'string' },
    { key: 'availabilityType', type: 'number' },
    { key: 'availabilities', type: 'array' },
    { key: 'guestType', type: 'string' },
    { key: 'consentLabel', type: 'string' },
    { key: 'calendarCoverImage', type: 'string' },
    { key: 'lookBusyConfig', type: 'unknown' },
    { key: 'id', type: 'string' },
  ],
  calendar_groups: [
    { key: 'locationId', type: 'string' },
    { key: 'name', type: 'string' },
    { key: 'description', type: 'string' },
    { key: 'slug', type: 'string' },
    { key: 'isActive', type: 'boolean' },
    { key: 'id', type: 'string' },
  ],
  campaigns: [
    { key: 'id', type: 'string' },
    { key: 'name', type: 'string' },
    { key: 'status', type: 'string' },
    { key: 'locationId', type: 'string' },
  ],
  conversations: [
    { key: 'id', type: 'string' },
    { key: 'contactId', type: 'string' },
    { key: 'locationId', type: 'string' },
    { key: 'lastMessageBody', type: 'string' },
    { key: 'lastMessageType', type: 'string' },
    { key: 'type', type: 'string' },
    { key: 'unreadCount', type: 'number' },
    { key: 'fullName', type: 'string' },
    { key: 'contactName', type: 'string' },
    { key: 'email', type: 'string' },
    { key: 'phone', type: 'string' },
  ],
  forms: [
    { key: 'id', type: 'string' },
    { key: 'name', type: 'string' },
    { key: 'locationId', type: 'string' },
  ],
  trigger_links: [
    { key: 'id', type: 'string' },
    { key: 'name', type: 'string' },
    { key: 'redirectTo', type: 'string' },
    { key: 'fieldKey', type: 'string' },
    { key: 'locationId', type: 'string' },
  ],
  products: [
    { key: '_id', type: 'string' },
    { key: 'description', type: 'string' },
    { key: 'variants', type: 'array' },
    { key: 'locationId', type: 'string' },
    { key: 'name', type: 'string' },
    { key: 'productType', type: 'string' },
    { key: 'availableInStore', type: 'boolean' },
    { key: 'createdAt', type: 'string' },
    { key: 'updatedAt', type: 'string' },
    { key: 'statementDescriptor', type: 'string' },
    { key: 'image', type: 'string' },
    { key: 'collectionIds', type: 'array' },
    { key: 'isTaxesEnabled', type: 'boolean' },
    { key: 'taxes', type: 'array' },
    { key: 'automaticTaxCategoryId', type: 'string' },
    { key: 'label', type: 'unknown' },
    { key: 'slug', type: 'string' },
  ],
  proposals: [
    { key: 'locationId', type: 'string' },
    { key: 'documentId', type: 'string' },
    { key: '_id', type: 'string' },
    { key: 'name', type: 'string' },
    { key: 'type', type: 'string' },
    { key: 'deleted', type: 'boolean' },
    { key: 'isExpired', type: 'boolean' },
    { key: 'documentRevision', type: 'number' },
    { key: 'fillableFields', type: 'array' },
    { key: 'grandTotal', type: 'unknown' },
    { key: 'locale', type: 'string' },
    { key: 'status', type: 'array' },
    { key: 'paymentStatus', type: 'array' },
    { key: 'recipients', type: 'array' },
    { key: 'links', type: 'array' },
    { key: 'updatedAt', type: 'string' },
    { key: 'createdAt', type: 'string' },
  ],
  surveys: [
    { key: 'id', type: 'string' },
    { key: 'name', type: 'string' },
    { key: 'locationId', type: 'string' },
  ],
  users: [
    { key: 'id', type: 'string' },
    { key: 'name', type: 'string' },
    { key: 'firstName', type: 'string' },
    { key: 'lastName', type: 'string' },
    { key: 'email', type: 'string' },
    { key: 'phone', type: 'string' },
    { key: 'extension', type: 'string' },
    { key: 'permissions', type: 'object' },
    { key: 'scopes', type: 'array' },
    { key: 'roles', type: 'object' },
    { key: 'deleted', type: 'boolean' },
    { key: 'lcPhone', type: 'object' },
    { key: 'platformLanguage', type: 'string' },
  ],
  workflows: [
    { key: 'id', type: 'string' },
    { key: 'name', type: 'string' },
    { key: 'status', type: 'string' },
    { key: 'version', type: 'number' },
    { key: 'createdAt', type: 'string' },
    { key: 'updatedAt', type: 'string' },
    { key: 'locationId', type: 'string' },
  ],
  blog_authors: [
    { key: '_id', type: 'string' },
    { key: 'name', type: 'string' },
    { key: 'locationId', type: 'string' },
    { key: 'updatedAt', type: 'string' },
    { key: 'canonicalLink', type: 'string' },
  ],
  blog_categories: [
    { key: '_id', type: 'string' },
    { key: 'label', type: 'string' },
    { key: 'locationId', type: 'string' },
    { key: 'updatedAt', type: 'string' },
    { key: 'canonicalLink', type: 'string' },
    { key: 'urlSlug', type: 'string' },
  ],
};
