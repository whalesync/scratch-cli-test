/**
 * Types for the Pipedrive v2 API connector.
 *
 * Pipedrive is a sales CRM with entity types: deals, persons, and organizations.
 * Each entity type can have user-defined custom fields discovered via the Fields API.
 */

/**
 * Supported Pipedrive entity types.
 */
export type PipedriveEntityType = 'deals' | 'persons' | 'organizations';

/**
 * All supported entity types.
 */
export const ENTITY_TYPES: PipedriveEntityType[] = ['deals', 'persons', 'organizations'];

/**
 * Per-entity configuration metadata.
 */
export interface PipedriveEntityConfig {
  displayName: string;
  titleField: string;
  idField: string;
}

/**
 * Config for each entity type.
 */
export const ENTITY_CONFIG: Record<PipedriveEntityType, PipedriveEntityConfig> = {
  deals: {
    displayName: 'Deals',
    titleField: 'title',
    idField: 'id',
  },
  persons: {
    displayName: 'Persons',
    titleField: 'name',
    idField: 'id',
  },
  organizations: {
    displayName: 'Organizations',
    titleField: 'name',
    idField: 'id',
  },
};

/**
 * Display names for entity types.
 */
export const ENTITY_DISPLAY_NAMES: Record<PipedriveEntityType, string> = {
  deals: 'Deals',
  persons: 'Persons',
  organizations: 'Organizations',
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
 * Download progress for resumable pulls.
 */
export interface PipedriveDownloadProgress {
  [key: string]: string | undefined;
  nextCursor?: string;
}
