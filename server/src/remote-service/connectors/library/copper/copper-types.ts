/**
 * Types for the Copper CRM connector.
 *
 * Copper is a sales CRM. We support six writable record entities in v1:
 * People, Companies, Opportunities, Leads, Tasks, Projects. (Activities are
 * deferred — they have a read-only "system" category and no `date_modified`.)
 *
 * Copper has no system-field metadata endpoint, so each entity's system fields
 * are declared statically in `copper-json-schema.ts`. User-defined custom fields
 * ARE discoverable via `GET /custom_field_definitions` and are stored verbatim
 * on each record as `custom_fields: [{ custom_field_definition_id, value }]`.
 *
 * API docs: https://developer.copper.com/
 */

/** Supported Copper entity types (the six v1 writable record entities). */
export type CopperEntityType = 'people' | 'companies' | 'opportunities' | 'leads' | 'tasks' | 'projects';

/** All supported entity types, in display order. */
export const COPPER_ENTITY_TYPES: CopperEntityType[] = [
  'people',
  'companies',
  'opportunities',
  'leads',
  'tasks',
  'projects',
];

/** Per-entity configuration. */
export interface CopperEntityConfig {
  /** Human-readable plural name shown in the table picker. */
  displayName: string;
  /** REST path segment, e.g. `people` → `/people`, `/people/search`. */
  endpoint: string;
  /** Field used as the record's display title / suggested filename. */
  titleField: string;
  /**
   * Whether Copper offers bulk create/update for this entity. Bulk is a beta
   * feature capped at ~10 records and not offered for every entity; there is no
   * bulk delete anywhere. Entities without bulk fall back to one request each.
   */
  supportsBulkWrite: boolean;
}

export const COPPER_ENTITY_CONFIG: Record<CopperEntityType, CopperEntityConfig> = {
  people: { displayName: 'People', endpoint: 'people', titleField: 'name', supportsBulkWrite: true },
  companies: { displayName: 'Companies', endpoint: 'companies', titleField: 'name', supportsBulkWrite: true },
  opportunities: {
    displayName: 'Opportunities',
    endpoint: 'opportunities',
    titleField: 'name',
    supportsBulkWrite: true,
  },
  leads: { displayName: 'Leads', endpoint: 'leads', titleField: 'name', supportsBulkWrite: true },
  // Tasks/Projects have no bulk endpoints.
  tasks: { displayName: 'Tasks', endpoint: 'tasks', titleField: 'name', supportsBulkWrite: false },
  projects: { displayName: 'Projects', endpoint: 'projects', titleField: 'name', supportsBulkWrite: false },
};

/**
 * A custom field definition from `GET /custom_field_definitions`. Drives the
 * dynamic portion of each entity's schema and resolves
 * `custom_field_definition_id` → name/type/options.
 */
export interface CopperCustomFieldDefinition {
  id: number;
  name: string;
  /**
   * Copper data type, e.g. `String`, `Text`, `Dropdown`, `MultiSelect`, `Date`,
   * `Checkbox`, `Float`, `URL`, `Connect`, `Currency`, `Percentage`. `Connect`
   * and computed fields are read-only.
   */
  data_type: string;
  /** Whether the value is server-computed (read-only). */
  is_computed?: boolean;
  /** Options for `Dropdown` / `MultiSelect` types. */
  available_options?: { id: number; name: string }[] | null;
  currency?: string | null;
}

/**
 * Resumable pull progress. Copper search is offset-based (`page_number`), so we
 * checkpoint the next page to fetch — a stalled job resumes mid-table instead of
 * re-paging from page 1.
 */
export interface CopperDownloadProgress {
  [key: string]: string | number | undefined;
  nextPage?: number;
}

/** Decrypted credentials: Copper auth needs both the API token and the account email. */
export interface CopperCredentials {
  apiKey: string;
  email: string;
}
