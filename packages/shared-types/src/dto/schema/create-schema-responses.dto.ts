import type { CreateFieldKind, CreateSchemaTablesDto } from './create-schema.dto';

/**
 * Responses and connector-capability descriptors for the create-schema API
 * (DEV-10378). Per the shared-types convention these are plain interfaces — the
 * server constructs them; nobody validates them as untrusted input.
 */

/**
 * Declarative, connector-agnostic description of what a connector can create.
 * The generic validator consumes this to fail fast (without hardcoding connector
 * rules in the server or any frontend); a connector with a mandatory title field
 * (Notion, Webflow) sets `requiresPrimaryField`.
 */
export interface SchemaCreationCapabilities {
  supportedFieldKinds: CreateFieldKind[];
  /** The connector requires the table to designate a primary/title field. */
  requiresPrimaryField: boolean;
  /** Allowed field kinds for the primary field, if constrained (e.g. ['text']). */
  primaryFieldKinds?: CreateFieldKind[];
  maxTableNameLength?: number;
  maxFieldNameLength?: number;
}

/** Per-field outcome of a create operation. */
export interface CreateFieldResult {
  name: string;
  status: 'created' | 'failed' | 'skipped';
  /** Connector-assigned remote field id on success (e.g. Airtable fldXXX). */
  remoteFieldId?: string;
  /**
   * True when the connector auto-added this field to satisfy a minimum
   * requirement (e.g. a title field the request omitted). Rare — the default
   * policy is to fail validation, not auto-inject.
   */
  autoAdded?: boolean;
  error?: string;
}

/** Per-table outcome of a create-tables operation. */
export interface CreateTableResult {
  /** Echoes the CreateTableSpec.ref from the request. */
  ref: string;
  name: string;
  status: 'created' | 'failed' | 'partial' | 'skipped';
  /** New remote table id on success; feeds materializeLocally + FK resolution. */
  remoteTableId?: string[];
  fields: CreateFieldResult[];
  /** Set when materializeLocally succeeded. */
  dataFolderId?: string;
  /** Set when the remote table was created but the local folder failed. */
  materializeError?: string;
  error?: string;
}

export type CreateSchemaStatus = 'ok' | 'partial' | 'failed' | 'not_supported';

/** Marker present only when status === 'not_supported'. */
export interface SchemaCreationUnsupported {
  service: string;
  message: string;
}

export interface CreateSchemaTablesResponse {
  status: CreateSchemaStatus;
  tables: CreateTableResult[];
  unsupported?: SchemaCreationUnsupported;
}

export interface CreateSchemaFieldsResponse {
  status: CreateSchemaStatus;
  remoteTableId: string[];
  fields: CreateFieldResult[];
  unsupported?: SchemaCreationUnsupported;
}

/** A single validation problem found by the dry-run /validate endpoint. */
export interface ValidateSchemaIssue {
  /** Dot/index path to the offending element, e.g. "tables[0].fields[2].name". */
  path: string;
  /** Machine-readable code, e.g. 'DUPLICATE_FIELD_NAME', 'UNSUPPORTED_FIELD_KIND'. */
  code: string;
  message: string;
}

export interface ValidateSchemaResponse {
  valid: boolean;
  issues: ValidateSchemaIssue[];
  /** Whether the resolved connector supports schema creation at all. */
  schemaCreationSupported: boolean;
  service: string;
}

/** Outcome of mapping one source field into a generated plan. */
export interface FieldMappingNote {
  /** Which source folder this field came from. */
  sourceDataFolderId: string;
  sourceFieldPath: string;
  fieldName: string;
  status: 'mapped' | 'downgraded' | 'unsupported';
  mappedKind?: CreateFieldKind;
  message?: string;
}

export interface GenerateCreatePlanResponse {
  /** One CreateTableSpec per source; ready to review/edit, then POST to /schema/tables. */
  plan: CreateSchemaTablesDto;
  /** Per-field mapping outcome — nothing is dropped silently. */
  notes: FieldMappingNote[];
  destinationSupportsCreation: boolean;
}
