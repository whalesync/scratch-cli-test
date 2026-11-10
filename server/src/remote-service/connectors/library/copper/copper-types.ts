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

import { ConnectorAuthTokenOrProvider } from '../../connector-auth-token';

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
 * Read-only reference entities (pull-only; no CRUD). Unlike the six writable
 * entities (which list via `POST /{entity}/search` with offset pagination), these
 * are small config collections fetched whole via `GET /{endpoint}`. They're the FK
 * targets that Opportunities link to (`pipeline_id` → pipelines,
 * `pipeline_stage_id` → pipeline_stages).
 */
export type CopperReferenceEntityType = 'pipelines' | 'pipeline_stages';

/** All read-only reference entity types, in display order. */
export const COPPER_REFERENCE_ENTITY_TYPES: CopperReferenceEntityType[] = ['pipelines', 'pipeline_stages'];

export interface CopperReferenceEntityConfig {
  /** Human-readable plural name shown in the table picker. */
  displayName: string;
  /** REST path segment for the GET-all list, e.g. `pipelines` → `GET /pipelines`. */
  endpoint: string;
  /** Field used as the record's display title / suggested filename. */
  titleField: string;
}

export const COPPER_REFERENCE_ENTITY_CONFIG: Record<CopperReferenceEntityType, CopperReferenceEntityConfig> = {
  pipelines: { displayName: 'Pipelines', endpoint: 'pipelines', titleField: 'name' },
  pipeline_stages: { displayName: 'Pipeline Stages', endpoint: 'pipeline_stages', titleField: 'name' },
};

/** True when `wsId` is one of the read-only reference tables (pipelines / pipeline_stages). */
export function isCopperReferenceEntityType(wsId: string): wsId is CopperReferenceEntityType {
  return (COPPER_REFERENCE_ENTITY_TYPES as string[]).includes(wsId);
}

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

/**
 * Copper OAuth (authorization code, through Whalesync's Copper partner app). Access tokens do not expire and come
 * with no refresh token. https://developer.copper.com/introduction/authentication.html
 */
export const COPPER_OAUTH_AUTHORIZE_URL = 'https://app.copper.com/oauth/authorize';
export const COPPER_OAUTH_TOKEN_URL = 'https://app.copper.com/oauth/token';
/** The only scope Copper offers: the same access as an API key. */
export const COPPER_OAUTH_SCOPE = 'developer/v1/all';

/**
 * How a connection authenticates. A pasted API key needs the account email too (sent as `X-PW-UserEmail`, the user
 * the key belongs to); a signed-in connection sends its OAuth access token as a bearer token. The OAuth token is a
 * provider, so a reconnect that replaces the token is picked up on the next request.
 */
export type CopperCredentials =
  | { kind: 'api_key'; apiKey: string; email: string }
  | { kind: 'oauth'; accessToken: ConnectorAuthTokenOrProvider };
