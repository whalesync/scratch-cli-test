import type { CreateFieldKind, CreateFieldSpec, CreateSchemaTablesDto } from './create-schema.dto';

/**
 * Responses and connector-capability descriptors for the create-schema API
 * (DEV-10378). Per the shared-types convention these are plain interfaces — the
 * server constructs them; nobody validates them as untrusted input.
 */

/** A link into a connector's own documentation. */
export interface SchemaDocsLink {
  /** Link text, e.g. "Learn about primary fields". */
  label: string;
  url: string;
}

/**
 * Everything about a connector's mandatory primary/title field, grouped into one
 * object so these details don't sprawl across the capability/prerequisite shapes.
 * The WHOLE object is `null` when the connector requires no primary field (see
 * `SchemaCreationCapabilities.primaryField` and `CreateSchemaPrerequisites.primaryField`).
 */
export interface PrimaryFieldRequirement {
  /** The service's user-facing name for the field: Airtable's "Primary field", Notion's "Title". */
  displayName: string;
  /**
   * Connector-worded explanation of the requirement, shown as helper text next to
   * the field picker (e.g. "Airtable requires a primary field. It's the first
   * column and describes each record, usually its name or title.").
   */
  description: string;
  /** The field kinds allowed for the primary field (e.g. Notion's `['text', 'longText']`). */
  kinds: CreateFieldKind[];
  /** Link to the connector's own docs explaining the primary field, when one exists. */
  docsLink?: SchemaDocsLink;
}

/**
 * Declarative, connector-agnostic description of what a connector can create.
 * The generic validator consumes this to fail fast (without hardcoding connector
 * rules in the server or any frontend); a connector with a mandatory title field
 * (Airtable, Notion) provides `primaryField`, others set it to `null`.
 */
export interface SchemaCreationCapabilities {
  supportedFieldKinds: CreateFieldKind[];
  /** The connector's primary-field requirement, or `null` when no primary field is required. */
  primaryField: PrimaryFieldRequirement | null;
  maxTableNameLength?: number;
  maxFieldNameLength?: number;
  /**
   * The maximum number of fields a single table may contain, when the connector enforces one — e.g.
   * Airtable rejects a table with more than 500 fields. Counts the plan's FINAL field list (including
   * injected fields like the primary field and the source-record-id column), which is exactly what the
   * connector's createTable receives. A plan whose source is too wide (a HubSpot object with 400–600+
   * properties exported to Airtable) is rejected with a `TOO_MANY_FIELDS` issue rather than failing
   * opaquely at the remote createTable call. Absent ⇒ no field-count limit.
   */
  maxFieldsPerTable?: number;
  /**
   * Field names the connector RESERVES and will reject at create time — e.g. the Postgres connector
   * injects an auto-generated `id` primary key, so a source field named `id`/`ID` can't be created.
   * The plan generator treats these as already-taken names, so a colliding source field is renamed
   * (like a duplicate) instead of being silently dropped and then failing to resolve at apply.
   * Compared case-insensitively. Absent ⇒ no reserved names.
   */
  reservedFieldNames?: string[];
}

/**
 * Connector-level prerequisites a generated plan must satisfy before it can be
 * submitted to /schema/tables. Derived on the server from the destination
 * connector's SchemaCreationCapabilities and surfaced declaratively so no
 * frontend hardcodes which services need what — a client reads these and brings
 * the plan into compliance (e.g. designates a primary field) before offering
 * "Create". A single object so future connector prerequisites have a home without
 * another top-level response field. Always present on the plan.
 */
export interface CreateSchemaPrerequisites {
  /**
   * The destination connector's primary-field requirement, or `null` when no
   * primary field is required. When non-null, every table in the plan must
   * designate exactly one primary field (a `CreateTableSpec` field with
   * `isPrimary === true`) of an allowed `kinds`, or creation is rejected at
   * validation time.
   */
  primaryField: PrimaryFieldRequirement | null;
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
   * create field. `needs_target` is a recognized foreign key kept in the plan as an
   * AVAILABLE field with an unmet requirement: no destination table was chosen yet
   * (see `sourceLinkedTableId`), so its `fieldType.target` is
   * `{ unresolvedLinkedTableId }` and create is rejected until it is bound to a
   * destination. The next two are add-fields-only, when the destination already has
   * a field of that name: `adopted` means the existing field is a compatible kind,
   * so it's reused (mapped to, not recreated) — see `existingDestinationColumnId`;
   * `exists` means it can't be safely reused (a different kind, or a foreign key)
   * and was skipped.
   */
  status: 'mapped' | 'downgraded' | 'unsupported' | 'exists' | 'adopted' | 'needs_target';
  mappedKind?: CreateFieldKind;
  message?: string;
  /**
   * Set on a `needs_target` note: the SOURCE's linked-table id (e.g. a HubSpot
   * association type like `"contacts"`) the foreign key points at. The consumer
   * binds it to a destination table — co-create it as a sibling in the same plan,
   * or map it to an existing remote table — to enable the field.
   */
  sourceLinkedTableId?: string;
  /**
   * Set on an `adopted` note: the path id of the existing destination column the
   * source field maps to (the destination already has a compatible field, so it is
   * NOT recreated). The client builds a column mapping to this existing column
   * (`DraftColumnMapping.destination = { kind: 'existing', columnId }`).
   */
  existingDestinationColumnId?: string;
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
