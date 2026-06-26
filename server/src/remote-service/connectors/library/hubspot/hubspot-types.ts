/**
 * Types for the HubSpot CRM API connector.
 *
 * HubSpot is a CRM platform with standard objects (contacts, companies, deals, etc.)
 * and user-defined custom objects. All property values are returned as strings from the API.
 */

/**
 * Standard HubSpot CRM object types.
 * Custom objects use their fullyQualifiedName (e.g. 'p12345_MyObject').
 */
export const STANDARD_OBJECT_TYPES = [
  'contacts',
  'companies',
  'deals',
  'tickets',
  'line_items',
  'products',
  'quotes',
  'notes',
  'tasks',
  'emails',
  'calls',
  'meetings',
  'communications',
  '0-421', // Appointments — HubSpot uses this internal code
  'services',
  'leads',
] as const;

/**
 * Per-object display and metadata configuration.
 */
export interface HubspotObjectConfig {
  displayName: string;
  /** Dot-path into the record for the title field (used for filenames). */
  titleFieldPath: string;
  /** Property names to show first in the default view (after the title field). */
  priorityFields?: string[];
  /** Whether creates are disabled for this object type. */
  disabledCreates?: boolean;
  /**
   * When true, the default view blanket-hides `hs_`-prefixed (HubSpot-managed)
   * properties as analytics/scoring/system noise. This is correct ONLY for the
   * analytics-heavy CRM record objects (contacts, companies, deals), whose
   * editable content lives in plain-named properties and which otherwise bury it
   * under dozens of `hs_analytics_*` / scoring fields.
   *
   * It must stay OFF for every other object type — activity/engagement objects
   * (calls, meetings, notes, tasks, emails, communications, appointments) and
   * commerce objects (products, quotes, line items, services) keep their ENTIRE
   * primary payload under `hs_`-prefixed properties (e.g. `hs_call_body`,
   * `hs_note_body`, `hs_task_subject`). Blanket-hiding those leaves the table with
   * only a handful of generic owner/system fields, and makes the real content
   * uncopyable in the create-table flow (which drops hidden columns).
   */
  hideHubspotManagedPropertiesByDefault?: boolean;
}

export const OBJECT_CONFIG: Record<string, HubspotObjectConfig> = {
  contacts: {
    displayName: 'Contacts',
    titleFieldPath: 'properties.email',
    priorityFields: ['firstname', 'lastname'],
    hideHubspotManagedPropertiesByDefault: true,
  },
  companies: {
    displayName: 'Companies',
    titleFieldPath: 'properties.name',
    priorityFields: ['domain', 'industry'],
    hideHubspotManagedPropertiesByDefault: true,
  },
  deals: {
    displayName: 'Deals',
    titleFieldPath: 'properties.dealname',
    priorityFields: ['dealstage', 'amount'],
    hideHubspotManagedPropertiesByDefault: true,
  },
  tickets: {
    displayName: 'Tickets',
    titleFieldPath: 'properties.subject',
    priorityFields: ['hs_ticket_priority', 'hs_pipeline_stage'],
  },
  line_items: { displayName: 'Line Items', titleFieldPath: 'properties.name' },
  products: { displayName: 'Products', titleFieldPath: 'properties.name' },
  quotes: { displayName: 'Quotes', titleFieldPath: 'properties.hs_title' },
  notes: { displayName: 'Notes', titleFieldPath: 'properties.hs_note_body' },
  tasks: { displayName: 'Tasks', titleFieldPath: 'properties.hs_task_subject' },
  emails: { displayName: 'Emails', titleFieldPath: 'properties.hs_email_subject', disabledCreates: true },
  calls: { displayName: 'Calls', titleFieldPath: 'properties.hs_call_title', disabledCreates: true },
  meetings: { displayName: 'Meetings', titleFieldPath: 'properties.hs_meeting_title' },
  communications: {
    displayName: 'Communications',
    titleFieldPath: 'properties.hs_communication_channel_type',
    disabledCreates: true,
  },
  '0-421': { displayName: 'Appointments', titleFieldPath: 'properties.hs_title' },
  services: { displayName: 'Services', titleFieldPath: 'properties.name' },
  leads: { displayName: 'Leads', titleFieldPath: 'properties.hs_lead_name' },
};

/**
 * Associations supported per object type.
 * Keys are the object type, values are the types it can be associated with.
 * Based on HubSpot's documented association support.
 */
export const ASSOCIATIONS_BY_OBJECT_TYPE: Record<string, string[]> = {
  contacts: [
    'notes',
    'tasks',
    'tickets',
    'deals',
    'companies',
    'contacts',
    'emails',
    'calls',
    'meetings',
    'communications',
    '0-421',
  ],
  deals: ['notes', 'tasks', 'tickets', 'contacts', 'companies', 'deals'],
  companies: ['notes', 'tasks', 'tickets', 'deals', 'contacts', 'companies'],
  notes: ['tasks', 'tickets', 'deals', 'companies', 'contacts'],
  tasks: ['notes', 'deals', 'tickets', 'contacts', 'companies'],
  tickets: ['companies', 'deals', 'tasks', 'contacts', 'notes'],
  quotes: ['deals', 'companies', 'contacts'],
  line_items: ['quotes', 'deals'],
  emails: ['contacts'],
  calls: ['contacts'],
  meetings: ['tasks', 'tickets', 'deals', 'companies', 'contacts', 'emails', 'calls', '0-421'],
  communications: ['contacts'],
  leads: ['contacts', 'deals', 'companies', 'tickets'],
  '0-421': ['contacts', 'deals', 'companies', 'tickets'],
  services: ['contacts', 'deals', 'companies', 'tickets', 'services'],
};

// --- API response types ---

export interface HubspotProperty {
  name: string;
  label: string;
  type: string;
  fieldType: string;
  description: string;
  hidden: boolean;
  modificationMetadata?: {
    archivable: boolean;
    readOnlyDefinition: boolean;
    readOnlyValue: boolean;
  };
  referencedObjectType?: string;
  externalOptions?: boolean;
  options?: HubspotPropertyOption[];
}

export interface HubspotPropertyOption {
  label: string;
  value: string;
}

export interface HubspotRecord {
  id: string;
  properties: Record<string, string | null>;
  associations?: Record<string, HubspotAssociationResult>;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface HubspotAssociationResult {
  results: HubspotAssociation[];
}

export interface HubspotAssociation {
  id: string;
  type: string;
}

export interface HubspotListResponse {
  results: HubspotRecord[];
  paging?: {
    next?: {
      after: string;
    };
  };
}

export interface HubspotCustomObjectSchema {
  fullyQualifiedName: string;
  labels: { plural: string; singular: string };
  properties: HubspotProperty[];
}

export interface HubspotCustomObjectSchemasResponse {
  results: HubspotCustomObjectSchema[];
}

export interface HubspotPropertiesResponse {
  results: HubspotProperty[];
}

export interface HubspotBatchReadResponse {
  status: string;
  results: HubspotRecord[];
}

/**
 * Request body for the CRM Search API (`POST /crm/v3/objects/{type}/search`),
 * used by incremental pulls to filter records by their modified-date property.
 */
export interface HubspotSearchRequestBody {
  filterGroups: { filters: { propertyName: string; operator: string; value: string }[] }[];
  sorts: { propertyName: string; direction: 'ASCENDING' | 'DESCENDING' }[];
  properties: string[];
  limit: number;
  after?: string;
}

/**
 * Response envelope for the CRM Search API. Mirrors the list response's paging
 * shape but, unlike the list endpoint, never includes `associations` on the
 * returned records (a documented incremental-pull limitation).
 */
export interface HubspotSearchResponse {
  total: number;
  results: HubspotRecord[];
  paging?: {
    next?: {
      after: string;
    };
  };
}

export interface HubspotRemoteError {
  status: string;
  message: string;
  correlationId: string;
  category: string;
}

/**
 * Download progress for resumable pulls.
 */
export interface HubspotDownloadProgress {
  [key: string]: string | undefined;
  afterCursor?: string;
}
