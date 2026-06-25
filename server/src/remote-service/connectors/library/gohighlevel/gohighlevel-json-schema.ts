import { Type, type TSchema } from '@sinclair/typebox';
import {
  X_SCRATCH_AGENT_INSTRUCTIONS,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_READONLY,
  type TablePropertyType,
  type TableView,
  type TableViewBannerGroup,
  type TableViewCol,
} from '@spinner/shared-types';
import { BaseJsonTableSpec, EntityId, dotPath } from '../../types';
import { GenericFieldType, GoHighLevelGenericEntityField } from './gohighlevel-entities';
import {
  GoHighLevelCustomFieldDefinition,
  GoHighLevelObjectDefinition,
  GoHighLevelObjectField,
} from './gohighlevel-types';

// --- Shared field helpers -------------------------------------------------

/**
 * Optional, nullable string field. HighLevel returns absent optional fields as an
 * explicit `null` (not omitted), so the value schema must permit `null` — a plain
 * `Type.String()` makes a fresh pull fail with `null is not of type "string"`.
 */
const optionalString = (description?: string): TSchema =>
  Type.Optional(Type.Union([Type.String(), Type.Null()], description ? { description } : {}));

/** Optional, nullable string field that HighLevel computes and we must not write back. */
const readonlyOptionalString = (description?: string): TSchema =>
  Type.Optional(
    Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true, ...(description ? { description } : {}) }),
  );

/** Optional, nullable number field that HighLevel computes and we must not write back. */
const readonlyOptionalNumber = (description?: string): TSchema =>
  Type.Optional(
    Type.Union([Type.Number(), Type.Null()], { [X_SCRATCH_READONLY]: true, ...(description ? { description } : {}) }),
  );

/**
 * Build a one-paragraph, agent-readable description of a model's custom fields.
 * Values are reshaped on pull into a keyed `custom_fields` object (short key →
 * value), so this mapping documents each short key's meaning, type, and options
 * for an agent (or a human reading schema.json) without a separate API call.
 */
function buildCustomFieldsAgentInstructions(definitions: GoHighLevelCustomFieldDefinition[]): string {
  if (definitions.length === 0) {
    return "Custom field values are stored under the `custom_fields` object, keyed by each field's short key. This location has no custom fields defined for this object.";
  }
  const fieldLines = definitions.map((definition) => {
    const optionsSuffix =
      definition.picklistOptions && definition.picklistOptions.length > 0
        ? `, options: ${definition.picklistOptions.join(' | ')}`
        : '';
    const shortKey = definition.fieldKey ? customFieldShortKey(definition.fieldKey) : '?';
    return `- ${definition.name ?? '(unnamed)'} (custom_fields key: ${shortKey}, id: ${definition.id}, fieldKey: ${definition.fieldKey ?? '?'}, type: ${definition.dataType ?? '?'}${optionsSuffix})`;
  });
  return (
    "Custom field values are stored under the `custom_fields` object, keyed by each field's short key (the part of its fieldKey after the first `.`). " +
    'Each short key maps to one of the location custom-field definitions below; the value shape depends on the field type. ' +
    'Custom-field definitions for this location:\n' +
    fieldLines.join('\n')
  );
}

/**
 * The short key used inside a record's `custom_fields` object: the part of the
 * HighLevel `fieldKey` after the first `.` (e.g. `contact.scratch_text` →
 * `scratch_text`). Returns the whole string when there is no dot.
 */
function customFieldShortKey(fieldKey: string): string {
  const dotIndex = fieldKey.indexOf('.');
  return dotIndex === -1 ? fieldKey : fieldKey.slice(dotIndex + 1);
}

/**
 * Build the `custom_fields` property: a keyed object with one typed sub-property
 * per discovered custom-field definition (keyed by its short key), so the client
 * auto-expands each into its own column. No x-scratch-* extension on this object
 * → the column builder expands the sub-properties; `additionalProperties: true`
 * keeps any field the definitions omitted. Definitions without a `fieldKey` are
 * skipped (no short key to derive).
 */
function buildCustomFieldsObjectProperty(definitions: GoHighLevelCustomFieldDefinition[]): TSchema {
  const fieldProperties: Record<string, TSchema> = {};
  for (const definition of definitions) {
    if (!definition.fieldKey) continue;
    const optionsDescription =
      definition.picklistOptions && definition.picklistOptions.length > 0
        ? `${definition.name ?? definition.fieldKey} (options: ${definition.picklistOptions.join(' | ')})`
        : definition.name;
    fieldProperties[customFieldShortKey(definition.fieldKey)] = schemaForObjectFieldDataType({
      dataType: definition.dataType,
      name: definition.name,
      description: optionsDescription,
    });
  }
  return Type.Optional(
    Type.Object(fieldProperties, {
      additionalProperties: true,
      description: "Custom field values, keyed by each field's short key (see agent instructions for definitions).",
    }),
  );
}

/**
 * Default view for a standard entity (Contacts / Opportunities): one column per
 * top-level schema property (derived from the schema keys, never hardcoded),
 * EXCLUDING `custom_fields`, followed by a "Custom Fields" banner group that
 * gathers one column per discovered custom-field definition
 * (`custom_fields.<shortKey>`). Each column's `readonly` is propagated from the
 * property's `x-scratch-readonly` flag, so the UI blocks edits to server-computed
 * fields (id, timestamps, locationId) that publish would drop anyway.
 */
function buildStandardEntityDefaultView(
  properties: Record<string, TSchema>,
  definitions: GoHighLevelCustomFieldDefinition[],
): TableView {
  const cols: (TableViewCol | TableViewBannerGroup)[] = [];
  for (const key of Object.keys(properties)) {
    if (key === 'custom_fields') continue;
    const propertySchema = properties[key] as Record<string, unknown>;
    const title = typeof propertySchema.title === 'string' ? propertySchema.title : key;
    cols.push({
      kind: 'col',
      path: key,
      name: title,
      type: tablePropertyTypeForObjectField(
        typeof propertySchema.dataType === 'string' ? propertySchema.dataType : undefined,
      ),
      // Propagate the schema's read-only flag so the UI blocks edits to
      // server-computed fields (id, dateAdded/dateUpdated, locationId, …); they're
      // dropped on publish, so an edit would just be silently lost.
      readonly: propertySchema[X_SCRATCH_READONLY] === true,
    });
  }

  const customFieldCols: TableViewCol[] = [];
  for (const definition of definitions) {
    if (!definition.fieldKey) continue;
    customFieldCols.push({
      kind: 'col',
      path: `custom_fields.${customFieldShortKey(definition.fieldKey)}`,
      name: definition.name ?? customFieldShortKey(definition.fieldKey),
      type: tablePropertyTypeForObjectField(definition.dataType),
    });
  }
  if (customFieldCols.length > 0) {
    cols.push({ kind: 'banner-group', name: 'Custom Fields', cols: customFieldCols });
  }

  return { name: 'Default', cols };
}

// --- Contacts -------------------------------------------------------------

/**
 * Build the Contacts JSON table spec.
 *
 * System fields are enumerated and typed; `additionalProperties: true` keeps any
 * field we did not enumerate (so the stored record stays a faithful copy of the
 * API response). Custom fields are discovered dynamically from the Locations
 * customFields API and reshaped on pull into a keyed `custom_fields` object (one
 * typed sub-property per definition) so each renders as its own column.
 */
export function buildContactsJsonTableSpec(
  id: EntityId,
  contactCustomFieldDefinitions: GoHighLevelCustomFieldDefinition[],
): BaseJsonTableSpec {
  const properties: Record<string, TSchema> = {
    id: Type.String({ [X_SCRATCH_READONLY]: true, description: 'HighLevel contact ID' }),
    locationId: readonlyOptionalString('Sub-account (Location) this contact belongs to'),
    // HighLevel exposes the full name as `contactName` on search responses and
    // `name` on get-by-id — keep both so the title column resolves either way.
    contactName: optionalString('Full contact name (search responses)'),
    name: optionalString('Full contact name'),
    firstName: optionalString(),
    lastName: optionalString(),
    email: optionalString(),
    phone: optionalString(),
    companyName: optionalString(),
    address1: optionalString(),
    city: optionalString(),
    state: optionalString(),
    country: optionalString(),
    postalCode: optionalString(),
    website: optionalString(),
    timezone: optionalString(),
    source: optionalString(),
    type: optionalString(),
    assignedTo: optionalString('User ID this contact is assigned to'),
    dateOfBirth: optionalString(),
    businessId: optionalString(),
    dnd: Type.Optional(Type.Boolean({ description: 'Do-not-disturb flag' })),
    tags: Type.Optional(Type.Array(Type.String())),
    dateAdded: readonlyOptionalString('ISO 8601 creation timestamp'),
    dateUpdated: readonlyOptionalString('ISO 8601 last-updated timestamp'),
    custom_fields: buildCustomFieldsObjectProperty(contactCustomFieldDefinitions),
  };

  const schema = Type.Object(properties, {
    $id: 'gohighlevel/contacts',
    title: 'Contacts',
    additionalProperties: true,
    // Field short-key→name/type/options reference for agents, kept at the schema
    // ROOT so it does not turn `custom_fields` into an opaque leaf column.
    [X_SCRATCH_AGENT_INSTRUCTIONS]: buildCustomFieldsAgentInstructions(contactCustomFieldDefinitions),
  });

  return {
    id,
    slug: id.wsId,
    name: 'Contacts',
    schema,
    idPath: dotPath('id'),
    titlePath: dotPath('contactName'),
    basePath: ['Standard Objects'],
    defaultView: buildStandardEntityDefaultView(properties, contactCustomFieldDefinitions),
    generatedAt: new Date().toISOString(),
  };
}

// --- Opportunities --------------------------------------------------------

/**
 * Build the Opportunities JSON table spec. Custom fields are discovered from the
 * Locations customFields API (the `opportunity` model) and reshaped on pull into
 * a keyed `custom_fields` object (one typed sub-property per definition).
 * `pipelineId`/`contactId` are annotated as foreign keys into the
 * Pipelines/Contacts tables.
 */
export function buildOpportunitiesJsonTableSpec(
  id: EntityId,
  opportunityCustomFieldDefinitions: GoHighLevelCustomFieldDefinition[],
): BaseJsonTableSpec {
  const properties: Record<string, TSchema> = {
    id: Type.String({ [X_SCRATCH_READONLY]: true, description: 'HighLevel opportunity ID' }),
    name: optionalString('Opportunity name'),
    monetaryValue: Type.Optional(Type.Number({ description: 'Monetary value' })),
    status: optionalString('Status: open | won | lost | abandoned'),
    pipelineId: Type.Optional(
      Type.String({
        description: 'Pipeline this opportunity belongs to',
        [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'pipelines' },
      }),
    ),
    pipelineStageId: optionalString('Stage within the pipeline'),
    contactId: Type.Optional(
      Type.String({
        description: 'Associated contact',
        [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'contacts' },
      }),
    ),
    assignedTo: optionalString('User ID this opportunity is assigned to'),
    source: optionalString(),
    lostReasonId: optionalString(),
    externalObjectId: optionalString(),
    locationId: readonlyOptionalString('Sub-account (Location)'),
    createdAt: readonlyOptionalString('ISO 8601 creation timestamp'),
    updatedAt: readonlyOptionalString('ISO 8601 last-updated timestamp'),
    lastStatusChangeAt: readonlyOptionalString(),
    lastStageChangeAt: readonlyOptionalString(),
    lastActionDate: readonlyOptionalString(),
    // HighLevel returns indexVersion as an integer (e.g. 1, 2), not a string.
    indexVersion: readonlyOptionalNumber(),
    // Hydrated read-only snapshots / sub-resources (only present when requested).
    contact: Type.Optional(
      Type.Object(
        {},
        {
          additionalProperties: true,
          [X_SCRATCH_READONLY]: true,
          description: 'Hydrated snapshot of the associated contact (read-only).',
        },
      ),
    ),
    followers: Type.Optional(Type.Array(Type.Unknown())),
    notes: Type.Optional(Type.Array(Type.Unknown(), { [X_SCRATCH_READONLY]: true })),
    tasks: Type.Optional(Type.Array(Type.Unknown(), { [X_SCRATCH_READONLY]: true })),
    calendarEvents: Type.Optional(Type.Array(Type.Unknown(), { [X_SCRATCH_READONLY]: true })),
    custom_fields: buildCustomFieldsObjectProperty(opportunityCustomFieldDefinitions),
  };

  const schema = Type.Object(properties, {
    $id: 'gohighlevel/opportunities',
    title: 'Opportunities',
    additionalProperties: true,
    // Field short-key→name/type/options reference for agents, kept at the schema
    // ROOT so it does not turn `custom_fields` into an opaque leaf column.
    [X_SCRATCH_AGENT_INSTRUCTIONS]: buildCustomFieldsAgentInstructions(opportunityCustomFieldDefinitions),
  });

  return {
    id,
    slug: id.wsId,
    name: 'Opportunities',
    schema,
    idPath: dotPath('id'),
    titlePath: dotPath('name'),
    basePath: ['Standard Objects'],
    defaultView: buildStandardEntityDefaultView(properties, opportunityCustomFieldDefinitions),
    generatedAt: new Date().toISOString(),
  };
}

// --- Pipelines ------------------------------------------------------------

/**
 * Build the Pipelines JSON table spec. Pipelines are read-only reference data
 * (their IDs/stage IDs are inputs when writing Opportunities), so the schema is
 * static — no dynamic discovery needed.
 */
export function buildPipelinesJsonTableSpec(id: EntityId): BaseJsonTableSpec {
  const stageSchema = Type.Object(
    {
      id: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
      position: Type.Optional(Type.Number()),
    },
    { additionalProperties: true },
  );

  const properties: Record<string, TSchema> = {
    id: Type.String({ [X_SCRATCH_READONLY]: true, description: 'Pipeline ID' }),
    name: optionalString('Pipeline name'),
    stages: Type.Optional(Type.Array(stageSchema, { description: 'Ordered stages in this pipeline' })),
    showInFunnel: Type.Optional(Type.Boolean()),
    showInPieChart: Type.Optional(Type.Boolean()),
    colorRenderMode: optionalString('How pipeline/stage colors are rendered'),
    locationId: readonlyOptionalString('Sub-account (Location)'),
  };

  const schema = Type.Object(properties, {
    $id: 'gohighlevel/pipelines',
    title: 'Pipelines',
    additionalProperties: true,
  });

  return {
    id,
    slug: id.wsId,
    name: 'Pipelines',
    schema,
    idPath: dotPath('id'),
    titlePath: dotPath('name'),
    basePath: ['Standard Objects'],
    generatedAt: new Date().toISOString(),
  };
}

// --- Custom / standard objects --------------------------------------------

/**
 * Agent-readable description of an object's fields. Record values live in the
 * keyed `properties` bag, so this documents each `fieldKey` → name/type/options.
 */
function buildObjectFieldsAgentInstructions(fields: GoHighLevelObjectField[]): string {
  if (fields.length === 0) {
    return "Record field values are stored verbatim under the `properties` object, keyed by each field's key. This object has no field definitions.";
  }
  const fieldLines = fields.map((field) => {
    const optionsSuffix =
      field.options && field.options.length > 0
        ? `, options: ${field.options.map((option) => option.label ?? option.key ?? '').join(' | ')}`
        : '';
    return `- ${field.name ?? '(unnamed)'} (key: ${field.fieldKey ?? '?'}, type: ${field.dataType ?? '?'}${optionsSuffix})`;
  });
  return (
    'Record field values are stored verbatim under the `properties` object, keyed by each field key, exactly as the HighLevel API returns them. ' +
    'Field definitions for this object:\n' +
    fieldLines.join('\n')
  );
}

/** Short key used inside a record's `properties` bag (the field key without the object-key prefix). */
function objectFieldShortKey(fieldKey: string, objectKey: string): string {
  const prefix = `${objectKey}.`;
  return fieldKey.startsWith(prefix) ? fieldKey.slice(prefix.length) : fieldKey;
}

/**
 * Permissive (nullable) schema for one HighLevel field, typed from its dataType.
 * Structurally typed on the only three properties it reads, so both
 * `GoHighLevelObjectField` (custom objects) and `GoHighLevelCustomFieldDefinition`
 * (contact/opportunity custom fields) satisfy it.
 */
function schemaForObjectFieldDataType(field: { dataType?: string; name?: string; description?: string }): TSchema {
  const annotations: Record<string, unknown> = {};
  if (field.name) annotations.title = field.name;
  if (field.description) annotations.description = field.description;
  switch ((field.dataType ?? '').toUpperCase()) {
    case 'NUMERICAL':
    case 'FLOAT':
    case 'MONETORY':
      return Type.Union([Type.Number(), Type.Null()], annotations);
    case 'CHECKBOX':
    case 'MULTIPLE_OPTIONS':
      return Type.Union([Type.Array(Type.Unknown()), Type.Null()], annotations);
    default:
      // Custom-field values are stored verbatim and HighLevel's typing is loose for
      // the long tail of field types (e.g. a TIME field returns minutes as a number,
      // 1410). Accept any scalar so a fresh pull never errors on its own data; the
      // column's display type still comes from the view's per-field dataType hint.
      return Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()], annotations);
  }
}

/**
 * Build the `properties` sub-schema for an object: one typed sub-property per
 * discovered field (keyed by the record's short key), so the client renders each
 * as its own column. No x-scratch-* extension on this object → the column builder
 * auto-expands the sub-properties; `additionalProperties: true` keeps any field
 * the definition omitted. Values are still stored verbatim from the API.
 */
function buildObjectPropertiesSchema(fields: GoHighLevelObjectField[], objectKey: string): TSchema {
  const fieldProperties: Record<string, TSchema> = {};
  for (const field of fields) {
    if (!field.fieldKey) continue;
    fieldProperties[objectFieldShortKey(field.fieldKey, objectKey)] = schemaForObjectFieldDataType(field);
  }
  return Type.Object(fieldProperties, {
    additionalProperties: true,
    description:
      'Custom-object field values, stored verbatim from the HighLevel API (one sub-property per object field).',
  });
}

/** Map a HighLevel object-field dataType to a table-view column type hint. */
function tablePropertyTypeForObjectField(dataType: string | undefined): TablePropertyType {
  switch ((dataType ?? '').toUpperCase()) {
    case 'NUMERICAL':
    case 'FLOAT':
    case 'MONETORY':
      return 'number';
    case 'DATE':
      return 'date';
    case 'CHECKBOX':
    case 'MULTIPLE_OPTIONS':
      return 'object';
    default:
      return 'string';
  }
}

/**
 * Default view for an object table. Fields are split by GHL's `standard` flag:
 * **standard** fields (the built-in schema of a standard object, e.g. the
 * Businesses object's `name`/`phone`/`email`) render as plain columns, while
 * **custom** fields (`standard: false`, the user-defined ones) are gathered under
 * a "Custom Fields" banner group (GHL's own term). System columns (id,
 * owner/followers, location, timestamps) sit around them. Columns come from the
 * schema; this view only orders + groups them.
 */
function buildCustomObjectDefaultView(objectKey: string, fields: GoHighLevelObjectField[]): TableView {
  const standardCols: TableViewCol[] = [];
  const customFieldCols: TableViewCol[] = [];
  for (const field of fields) {
    if (!field.fieldKey) continue;
    const key = objectFieldShortKey(field.fieldKey, objectKey);
    const col: TableViewCol = {
      kind: 'col',
      path: `properties.${key}`,
      name: field.name ?? key,
      type: tablePropertyTypeForObjectField(field.dataType),
    };
    // `standard === true` → built-in object field (flat); otherwise a custom field.
    (field.standard === true ? standardCols : customFieldCols).push(col);
  }

  const cols: (TableViewCol | TableViewBannerGroup)[] = [{ kind: 'col', path: 'id', readonly: true }, ...standardCols];
  if (customFieldCols.length > 0) {
    cols.push({ kind: 'banner-group', name: 'Custom Fields', cols: customFieldCols });
  }
  cols.push(
    { kind: 'col', path: 'owner' },
    { kind: 'col', path: 'followers' },
    { kind: 'col', path: 'locationId', readonly: true },
    { kind: 'col', path: 'createdAt', readonly: true },
    { kind: 'col', path: 'updatedAt', readonly: true },
    { kind: 'col', path: 'dateAdded', readonly: true },
    { kind: 'col', path: 'dateUpdated', readonly: true },
  );
  return { name: 'Default', cols };
}

/**
 * Build the JSON table spec for a custom/standard object discovered via the
 * Objects API. The schema is permissive (`additionalProperties: true`) and the
 * record's `properties` bag is documented from the object's field definitions —
 * faithful to the raw record, since values are keyed dynamically per object.
 */
export function buildCustomObjectJsonTableSpec(
  id: EntityId,
  objectDefinition: GoHighLevelObjectDefinition,
  fields: GoHighLevelObjectField[],
): BaseJsonTableSpec {
  const displayName = objectDefinition.labels?.plural ?? objectDefinition.labels?.singular ?? id.wsId;
  const objectKey = objectDefinition.key ?? id.remoteId[0] ?? '';

  const properties: Record<string, TSchema> = {
    id: Type.String({ [X_SCRATCH_READONLY]: true, description: 'Record ID' }),
    // Each discovered object field becomes a typed sub-property of `properties`,
    // so the client renders one column per field (see buildObjectPropertiesSchema).
    properties: buildObjectPropertiesSchema(fields, objectKey),
    owner: Type.Optional(Type.Array(Type.String(), { description: 'Owner user IDs' })),
    followers: Type.Optional(Type.Array(Type.String(), { description: 'Follower user IDs' })),
    locationId: readonlyOptionalString('Sub-account (Location)'),
    // Search responses use createdAt/updatedAt; get-by-id uses dateAdded/dateUpdated.
    createdAt: readonlyOptionalString('ISO 8601 creation timestamp (search responses)'),
    updatedAt: readonlyOptionalString('ISO 8601 last-updated timestamp (search responses)'),
    dateAdded: readonlyOptionalString('ISO 8601 creation timestamp (get-by-id responses)'),
    dateUpdated: readonlyOptionalString('ISO 8601 last-updated timestamp (get-by-id responses)'),
  };

  const schema = Type.Object(properties, {
    $id: `gohighlevel/${id.wsId}`,
    title: displayName,
    additionalProperties: true,
    // Field id→name/type/options reference for agents, kept at the schema ROOT so
    // it does not turn `properties` into an opaque leaf column.
    [X_SCRATCH_AGENT_INSTRUCTIONS]: buildObjectFieldsAgentInstructions(fields),
  });

  return {
    id,
    slug: id.wsId,
    name: displayName,
    schema,
    idPath: dotPath('id'),
    // Human-defined custom objects (`custom_objects.*`) → /Custom Objects/; the
    // standard objects-API objects (the built-in `business`/Companies) → /Standard
    // Objects/ with the other built-ins.
    basePath: objectKey.startsWith('custom_objects.') ? ['Custom Objects'] : ['Standard Objects'],
    // View layer: standard fields stay flat; custom fields group under "Custom Fields".
    defaultView: buildCustomObjectDefaultView(objectKey, fields),
    generatedAt: new Date().toISOString(),
  };
}

// --- Generic location-scoped list entities --------------------------------

/**
 * Map a generic entity field's OpenAPI primitive class to a permissive schema.
 * Every field is **Optional** (and nullable): these tables are stored verbatim and
 * HighLevel omits or nulls most fields per record — a required field would make a
 * fresh pull fail with "required but missing or null". `readonly` adds the
 * `x-scratch-readonly` flag: true for every field of a pull-only table, and true
 * only for the non-writable fields (id, locationId) of a writable one.
 * `foreignKeyTableId`, when set, annotates the column as a foreign key into that
 * Scratch table (the target entity's wsId) — e.g. Calendars `formId` → `forms`.
 */
function genericFieldTypeToSchema(
  type: GenericFieldType,
  key: string,
  readonly: boolean,
  foreignKeyTableId?: string,
): TSchema {
  const annotations: Record<string, unknown> = { description: key };
  if (readonly) annotations[X_SCRATCH_READONLY] = true;
  if (foreignKeyTableId) annotations[X_SCRATCH_FOREIGN_KEY_OPTIONS] = { linkedTableId: foreignKeyTableId };
  switch (type) {
    case 'string':
      return Type.Optional(Type.Union([Type.String(), Type.Null()], annotations));
    case 'number':
      return Type.Optional(Type.Union([Type.Number(), Type.Null()], annotations));
    case 'boolean':
      return Type.Optional(Type.Union([Type.Boolean(), Type.Null()], annotations));
    case 'array':
      return Type.Optional(Type.Union([Type.Array(Type.Unknown()), Type.Null()], annotations));
    case 'object':
      return Type.Optional(Type.Union([Type.Object({}, { additionalProperties: true }), Type.Null()], annotations));
    default:
      return Type.Optional(Type.Union([Type.Unknown(), Type.Null()], annotations));
  }
}

/**
 * Build the JSON table spec for a generic location-scoped list entity
 * (Users, Conversations, Products, …). These entities have no field-metadata
 * endpoint, so columns come from a **static field list enumerated from the
 * HighLevel OpenAPI** (`GOHIGHLEVEL_ENTITY_FIELDS`, passed in as `fields`) — that
 * way the table view shows real fields, not just the id. The record is still
 * stored verbatim (`additionalProperties: true`) so anything the OpenAPI omitted
 * passes through. `idField` is `id` for most, `_id` for products/proposals/blogs.
 *
 * **Writability is controlled by the `readonlyFieldKeysWhenWritable` argument,
 * which does double duty:**
 * - **Omitted (`undefined`)** → the whole table is **read-only** (the default for
 *   the pull-only reference entities — they all call this with no set).
 * - **Provided (any set, even empty)** → the table is **writable**, and the set
 *   lists the field keys that must STAY read-only anyway. So the act of passing a
 *   set is the on/off switch; its contents are the read-only *exceptions*.
 *
 * The `id` field is always read-only regardless. Example: Calendars passes
 * `{'locationId'}` (the connection scope the connector injects on create), so
 * `locationId` and `id` stay read-only and every other field (name, slotDuration,
 * …) is editable.
 */
export function buildGenericEntityJsonTableSpec(
  id: EntityId,
  displayName: string,
  idField: string,
  fields?: ReadonlyArray<GoHighLevelGenericEntityField>,
  readonlyFieldKeysWhenWritable?: ReadonlySet<string>,
): BaseJsonTableSpec {
  // When the read-only set is provided the entity is WRITABLE: a field is read-only
  // only if it's the id field or its key is in the set. When omitted, every field is
  // read-only (the default for pull-only reference tables).
  const isWritable = readonlyFieldKeysWhenWritable !== undefined;
  const properties: Record<string, TSchema> = {
    [idField]: Type.String({ [X_SCRATCH_READONLY]: true, description: 'Record ID' }),
  };
  for (const field of fields ?? []) {
    if (field.key in properties) continue;
    const fieldIsReadonly = !isWritable || readonlyFieldKeysWhenWritable.has(field.key);
    properties[field.key] = genericFieldTypeToSchema(field.type, field.key, fieldIsReadonly, field.foreignKeyTableId);
  }

  const schema = Type.Object(properties, {
    $id: `gohighlevel/${id.wsId}`,
    title: displayName,
    additionalProperties: true,
  });

  return {
    id,
    slug: id.wsId,
    name: displayName,
    schema,
    idPath: dotPath(idField),
    titlePath: dotPath('name'),
    basePath: ['Standard Objects'],
    generatedAt: new Date().toISOString(),
  };
}
