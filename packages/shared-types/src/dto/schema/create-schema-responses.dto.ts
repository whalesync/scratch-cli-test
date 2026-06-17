import type { CreateFieldKind, CreateFieldSpec, CreateSchemaTablesDto } from './create-schema.dto';

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
  /**
   * The service's own user-facing name for the primary field, so a frontend can
   * label it the way the service does instead of hardcoding "Name" — Airtable's
   * "Primary field", Notion's "Title", etc. Set only when `requiresPrimaryField`
   * is true.
   */
  primaryFieldDisplayName?: string;
  maxTableNameLength?: number;
  maxFieldNameLength?: number;
}

/**
 * Connector-level prerequisites a generated plan must satisfy before it can be
 * submitted to /schema/tables. Derived on the server from the destination
 * connector's SchemaCreationCapabilities and surfaced declaratively so no
 * frontend hardcodes which services need what — a client reads these and brings
 * the plan into compliance (e.g. designates a primary field) before offering
 * "Create". Grouped into one object so future connector prerequisites have a
 * home without another top-level response field.
 *
 * Always present on the plan; a connector with no special needs yields
 * all-permissive defaults (`requiresPrimaryField === false`) so the client can
 * treat the object uniformly.
 */
export interface CreateSchemaPrerequisites {
  /**
   * Each table in the plan must designate exactly one primary/title field (a
   * `CreateTableSpec` field with `isPrimary === true`). True for connectors with
   * a mandatory title column (e.g. Airtable, Notion); creation is rejected at
   * validation time otherwise.
   */
  requiresPrimaryField: boolean;
  /**
   * When `requiresPrimaryField` is true, the field kinds allowed for that primary
   * field if the connector constrains them (e.g. Notion's `['text', 'longText']`).
   * Omitted when any supported kind may be the primary field.
   */
  primaryFieldKinds?: CreateFieldKind[];
  /**
   * The user-facing name to label the primary field with — the service's own term
   * when it has one (Airtable's "Primary field", Notion's "Title"), otherwise a
   * generic default ("Name field"). Always present when `requiresPrimaryField` is
   * true and omitted otherwise, so the client never has to supply its own fallback.
   */
  primaryFieldDisplayName?: string;
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
  /** The field's FINAL name in the plan — already suffixed if it was renamed to deduplicate. */
  fieldName: string;
  /**
   * `mapped`/`downgraded`/`unsupported` describe how the source field maps to a
   * create field; `exists` means the field was skipped because the existing
   * destination table already has a field of that name (add-fields diff only).
   */
  status: 'mapped' | 'downgraded' | 'unsupported' | 'exists';
  mappedKind?: CreateFieldKind;
  message?: string;
  /**
   * Set when the field was renamed to keep field names unique within the table
   * (a numeric suffix was appended): the original, pre-suffix name. `fieldName`
   * holds the final name actually used in the plan.
   */
  renamedFromName?: string;
}

/**
 * Outcome of resolving a generated table's name. Emitted ONLY when a new table
 * had to be renamed (a numeric suffix appended) to avoid a collision — either
 * with another new table in the same plan, or with a table that already exists
 * on the destination (scoped to the create parent). `tableName` is the final
 * name used in the plan; nothing is renamed silently.
 */
export interface TableMappingNote {
  /** Which source folder this table was generated from. */
  sourceDataFolderId: string;
  /** The table's correlation ref in the plan (unchanged by the rename). */
  ref: string;
  /** The final table name actually used in the plan (post-suffix). */
  tableName: string;
  /** The original, pre-suffix name. */
  renamedFromName: string;
  /**
   * `duplicate_in_plan` — collided with another table being created in this plan;
   * `conflicts_with_existing_table` — collided with a table already on the destination.
   */
  reason: 'duplicate_in_plan' | 'conflicts_with_existing_table';
  message: string;
}

/**
 * Add-fields plan for one source whose destination table already exists: the
 * source's fields diffed against the destination's current fields, so only the
 * missing ones remain. The client edits these, then POSTs them to /schema/fields.
 */
export interface CreateSchemaFieldsPlan {
  /** Echoes the source folder this plan was generated from. */
  sourceDataFolderId: string;
  /** The existing, materialized destination folder these fields are added to. */
  destinationDataFolderId: string;
  connectorAccountId: string;
  /** The destination folder's remote table id (target of the /schema/fields POST). */
  remoteTableId: string[];
  /**
   * The missing fields to create. MAY be empty when the destination already has
   * every source field — that's a meaningful "nothing to add" result, surfaced
   * rather than dropped (see `notes` for the skipped fields).
   */
  fields: CreateFieldSpec[];
}

export interface GenerateCreatePlanResponse {
  /**
   * Create-tables plan for sources whose destination table doesn't yet exist; one
   * CreateTableSpec per such source, ready to review/edit then POST to /schema/tables.
   * `tables` is empty when every source targets an existing destination table.
   */
  plan: CreateSchemaTablesDto;
  /**
   * Add-fields plans, one per source that targets an existing destination table.
   * Empty when every source is a new table.
   */
  fieldPlans: CreateSchemaFieldsPlan[];
  /** Per-field mapping outcome — nothing is dropped silently. */
  notes: FieldMappingNote[];
  /**
   * Per-table rename outcome — one entry for each new table whose name had to be
   * suffixed to avoid a collision (in-plan or with an existing destination table).
   * Empty when no table was renamed.
   */
  tableNotes: TableMappingNote[];
  /**
   * Connector prerequisites the plan must satisfy before it can be created (e.g.
   * Airtable/Notion require each table to designate a primary field). Always
   * present; all-permissive when the destination connector has no special needs.
   */
  prerequisites: CreateSchemaPrerequisites;
  destinationSupportsCreation: boolean;
}
