import { Kind, TSchema } from '@sinclair/typebox';
import {
  ArrayKeyedColumn,
  buildKeyedArrayColumnPath,
  ClientSafeTransformer,
  getArrayKeyedByOptions,
  JSONPathArrayHandling,
  TablePropertyType,
  TableView,
  TableViewBannerGroup,
  TableViewCol,
  TableViewSubfield,
  TransformerTypes,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import {
  affinityFieldValueTypeFromSchemasById,
  COMPANIES_TABLE_WS_ID,
  FIELD_KEY_FIELD,
  getAffinityFieldSchemasById,
  PEOPLE_TABLE_WS_ID,
  tablePropertyTypeForAffinityValueType,
} from './affinity-fields';

// ── Field-level subfields ──

// Each element of the verbatim `entity.fields` (or `fields`) array is an object
// `{ id, name, type, enrichmentSource, value: { type, data } }`. The whole
// element is the editable column (addressed by `[id=<id>]`), and the useful
// payload lives at `value.data`. We expose subfields so users can drill into the
// nested structure and see the actual data by default.

/** Build subfields for a dynamic Affinity field, with the data subfield type based on valueType. */
function buildFieldSubfields(connectorDataType: string | undefined): TableViewSubfield[] {
  return [
    { relativePath: 'value.data', name: 'Data', type: tablePropertyTypeForAffinityValueType(connectorDataType) },
    { relativePath: 'value.type', name: 'Value Type', type: 'string' },
    { relativePath: 'type', name: 'Field Type', type: 'string' },
    { relativePath: 'enrichmentSource', name: 'Enrichment Source', type: 'string' },
  ];
}

// ── Hidden fields ──

// Top-level fields that are system metadata and should be hidden by default.
const HIDDEN_TOP_LEVEL_FIELDS = new Set(['type', 'listId', 'creatorId']);

// Entity sub-fields that should be hidden by default.
const HIDDEN_ENTITY_FIELDS = new Set(['isGlobal']);

// ── Always-readonly top-level fields ──

const READONLY_TOP_LEVEL_FIELDS = new Set(['id', 'type', 'listId', 'createdAt', 'creatorId']);

// ── Always-readonly entity fields ──

const READONLY_ENTITY_FIELDS = new Set(['id', 'isGlobal', 'listId']);

// ── Notes-specific hidden fields ──

const HIDDEN_NOTES_FIELDS = new Set([
  'mentions',
  'interaction',
  'transcriptId',
  'parent',
  'companiesPreview',
  'personsPreview',
  'opportunitiesPreview',
  'repliesCount',
]);

// ── Entity Files-specific hidden fields ──

// The parent-entity foreign keys (`person_id` / `organization_id` /
// `opportunity_id`) are the connector's only clean scalar FK surface and are the
// Entity Files table's only relations — so they are shown by default (DEV-11065),
// their FK targets recovered from the schema's `x-scratch-foreign-key`. Only
// `uploader_id` (a bare Users id with no declared FK) stays hidden as noise.
const HIDDEN_ENTITY_FILES_FIELDS = new Set(['uploader_id']);

// ── Notes content subfields ──

const CONTENT_SUBFIELDS: TableViewSubfield[] = [{ relativePath: 'html', name: 'Html', type: 'richtext' }];

// ── Creator subfields (person data object on Notes) ──

const CREATOR_SUBFIELDS: TableViewSubfield[] = [
  { relativePath: 'firstName', name: 'First Name', type: 'string' },
  { relativePath: 'primaryEmailAddress', name: 'Email', type: 'string' },
];

/**
 * Build a default TableView for an Affinity table. Works for all Affinity table
 * shapes: list entries (with `entity` wrapper), tenant-wide tables (flat with
 * `fields`), opportunities (flat, no fields), notes, and entity files.
 *
 * The `titleFieldPath` is the dot-separated path to the title column (e.g.
 * `entity.name` or `firstName`). It is placed first, followed by `id`, then
 * remaining fields in a sensible order.
 */
export function buildAffinityDefaultView(schema: TSchema, titleFieldPath?: string): TableView {
  const topLevel: Record<string, TSchema> =
    (schema as TSchema & { properties?: Record<string, TSchema> }).properties ?? {};

  const cols: (TableViewCol | TableViewBannerGroup)[] = [];

  // Detect structural variants
  const hasEntity = 'entity' in topLevel;
  const entitySchema = topLevel['entity'];
  const entityProps: Record<string, TSchema> =
    (entitySchema as TSchema & { properties?: Record<string, TSchema> })?.properties ?? {};

  // The verbatim `fields` array lives under `entity.fields` (list entries) or at
  // the top level (flat tenant tables). Its `x-scratch-array-keyed-by` columns
  // drive one editable column per field, addressed by `[id=<id>]`.
  const fieldsPropertySchema = hasEntity
    ? entityProps['fields']
    : 'fields' in topLevel
      ? topLevel['fields']
      : undefined;

  // Determine if this is a notes or entity-files table
  const schemaId = (schema as TSchema & { $id?: string }).$id ?? '';
  const isNotes = schemaId === 'affinity/notes';
  const isEntityFiles = schemaId === 'affinity/entity-files';

  // ── 1. Title column ──
  if (titleFieldPath) {
    const col = buildColForPath(titleFieldPath, topLevel, entityProps);
    if (col) {
      cols.push(col);
    }
  }

  // ── 2. id field ──
  if (topLevel['id']) {
    cols.push(buildTopLevelCol('id', topLevel['id'], isNotes, isEntityFiles));
  }

  // ── 3. Entity fixed fields (non-fields, non-id, non-title) ──
  if (hasEntity) {
    const titleEntityField = titleFieldPath?.startsWith('entity.') ? titleFieldPath.replace('entity.', '') : undefined;
    for (const [fieldId, fieldSchema] of Object.entries(entityProps)) {
      if (fieldId === 'fields' || fieldId === 'id') continue;
      if (fieldId === titleEntityField) continue;
      cols.push(buildEntityCol(fieldId, fieldSchema));
    }
  }

  // ── 4. Flat table fixed fields (non-fields, non-id, non-title) ──
  if (!hasEntity) {
    const titleField = titleFieldPath;
    const fixedFieldIds = Object.keys(topLevel).filter((k) => k !== 'fields' && k !== 'id' && k !== titleField);

    // Priority: put meaningful fields before system/metadata fields
    for (const fieldId of fixedFieldIds) {
      cols.push(buildTopLevelCol(fieldId, topLevel[fieldId], isNotes, isEntityFiles));
    }
  }

  // ── 5. Dynamic fields (verbatim `fields` array → one column per keyed element) ──
  const fieldPathPrefix = hasEntity ? 'entity.fields' : 'fields';
  const keyedByOptions = getArrayKeyedByOptions(fieldsPropertySchema);
  const fieldSchemasById = getAffinityFieldSchemasById(fieldsPropertySchema);

  if (keyedByOptions) {
    for (const column of keyedByOptions.columns) {
      const fieldId = String(column.key);
      const valueType = affinityFieldValueTypeFromSchemasById(fieldSchemasById, fieldId);
      // The whole element is the column value: `entity.fields.[id=field-1]` /
      // `fields.[id=field-1]` — no valuePath.
      const fieldColumnPath = buildKeyedArrayColumnPath(fieldPathPrefix, FIELD_KEY_FIELD, fieldId);
      if (valueType === 'location') {
        cols.push(buildLocationBannerGroup(fieldId, column, fieldColumnPath));
      } else {
        cols.push(buildDynamicFieldCol(column, valueType, fieldColumnPath));
      }
    }
  }

  // ── 6. Remaining top-level fields for list entries (type, listId, createdAt, creatorId) ──
  if (hasEntity) {
    const entityRelatedKeys = new Set(['entity', 'id']);
    for (const [fieldId, fieldSchema] of Object.entries(topLevel)) {
      if (entityRelatedKeys.has(fieldId)) continue;
      cols.push(buildTopLevelCol(fieldId, fieldSchema, isNotes, isEntityFiles));
    }
  }

  return { name: 'Default', cols };
}

// ── Helpers ──

/** Build a column for a dot-path like `entity.name` or `firstName`. */
function buildColForPath(
  dotPath: string,
  topLevel: Record<string, TSchema>,
  entityProps: Record<string, TSchema>,
): TableViewCol | undefined {
  const parts = dotPath.split('.');

  if (parts.length === 2 && parts[0] === 'entity') {
    const fieldId = parts[1];
    const fieldSchema = entityProps[fieldId];
    if (!fieldSchema) return undefined;
    return {
      kind: 'col',
      path: dotPath,
      name: formatCamelCaseName(fieldId),
      type: mapType(fieldSchema),
      readonly: fieldSchema?.[X_SCRATCH_READONLY] === true || undefined,
    };
  }

  // Flat field (e.g. `firstName`, `name`)
  const fieldSchema = topLevel[parts[0]];
  if (!fieldSchema) return undefined;
  return {
    kind: 'col',
    path: dotPath,
    name: formatCamelCaseName(parts[0]),
    type: mapType(fieldSchema),
    readonly: fieldSchema?.[X_SCRATCH_READONLY] === true || undefined,
  };
}

/** Build a column for a top-level fixed field. */
function buildTopLevelCol(
  fieldId: string,
  fieldSchema: TSchema,
  isNotes: boolean,
  isEntityFiles: boolean,
): TableViewCol {
  const isReadonly = READONLY_TOP_LEVEL_FIELDS.has(fieldId) || fieldSchema?.[X_SCRATCH_READONLY] === true;
  const hidden =
    HIDDEN_TOP_LEVEL_FIELDS.has(fieldId) ||
    (isNotes && HIDDEN_NOTES_FIELDS.has(fieldId)) ||
    (isEntityFiles && HIDDEN_ENTITY_FILES_FIELDS.has(fieldId)) ||
    undefined;

  const col: TableViewCol = {
    kind: 'col',
    path: fieldId,
    name: isEntityFiles ? formatSnakeCaseName(fieldId) : formatCamelCaseName(fieldId),
    type: mapType(fieldSchema),
    readonly: isReadonly || undefined,
    hidden,
  };

  // Mirror a schema-declared foreign key onto the view column so the grid renders
  // it as a link and a sync/export links the record (Entity Files' parent-entity
  // FKs — person_id / organization_id / opportunity_id). Purely additive: only
  // fields carrying `x-scratch-foreign-key` get it.
  const foreignKeyTarget = linkedTableIdFromSchema(fieldSchema);
  if (foreignKeyTarget) {
    col.foreignKey = { linkedTableId: foreignKeyTarget };
  }

  // Notes: content field gets subfields for html
  if (isNotes && fieldId === 'content') {
    col.subfields = CONTENT_SUBFIELDS;
    col.selectedSubfield = 0;
  }

  // Notes: creator field gets subfields
  if (isNotes && fieldId === 'creator') {
    col.subfields = CREATOR_SUBFIELDS;
    col.selectedSubfield = 0;
  }

  return col;
}

/** Build a column for an entity sub-field (e.g. `entity.domain`). */
function buildEntityCol(fieldId: string, fieldSchema: TSchema): TableViewCol {
  const isReadonly = READONLY_ENTITY_FIELDS.has(fieldId) || fieldSchema?.[X_SCRATCH_READONLY] === true;
  const hidden = HIDDEN_ENTITY_FIELDS.has(fieldId) || undefined;

  return {
    kind: 'col',
    path: `entity.${fieldId}`,
    name: formatCamelCaseName(fieldId),
    type: mapType(fieldSchema),
    readonly: isReadonly || undefined,
    hidden,
  };
}

// ── Dynamic-field value-type families the view editorializes ──
//
// Each family's stored value is a decorated object (or array of them) whose
// USEFUL inner value the view plucks — the "pluck the useful inner value" job the
// Connector Guide assigns the view layer — without reshaping the verbatim element
// on disk (Connector Prime Directive intact). The pluck is a display transformer
// (grid) + a `codec.toCore` (sync/export), both jsonpaths reaching into the whole
// element at `value.data`.

/** Reference value types → foreign key to the tenant People table (DEV-11065). */
const PERSON_REFERENCE_VALUE_TYPES: ReadonlySet<string> = new Set(['person', 'person-multi']);
/** Reference value types → foreign key to the tenant Companies table (DEV-11065). */
const COMPANY_REFERENCE_VALUE_TYPES: ReadonlySet<string> = new Set(['company', 'company-multi']);
/** Dropdown value types → pluck the option `.text` label (DEV-11064). */
const DROPDOWN_VALUE_TYPES: ReadonlySet<string> = new Set(['dropdown', 'ranked-dropdown', 'dropdown-multi']);
/** Homogeneous scalar-array value types → the joined/array of `value.data` elements (DEV-11064). */
const SCALAR_MULTI_VALUE_TYPES: ReadonlySet<string> = new Set(['filterable-text-multi', 'number-multi']);

/**
 * Build a column for one dynamic Affinity field, editorializing the reference,
 * dropdown, and multi-value scalar families into typed / linked columns and
 * leaving everything else as a drill-into-`value.data` column with subfields.
 *
 * The column always addresses the whole verbatim array element by its filter path
 * (`entity.fields.[id=field-1]` / `fields.[id=field-1]`). `readonly` is preserved
 * from the `x-scratch-array-keyed-by` column so publish never receives an edit to
 * an enriched / relationship-intelligence / computed field it would reject.
 */
function buildDynamicFieldCol(
  column: ArrayKeyedColumn,
  valueType: string | undefined,
  fieldColumnPath: string,
): TableViewCol {
  const readonly = column.readonly || undefined;
  const isMultiValue = typeof valueType === 'string' && valueType.endsWith('-multi');

  // Reference fields (person / company, single or multi) → foreign keys. The
  // referenced record's id lives at `value.data.id` (single) / `value.data[*].id`
  // (multi) — the fully-hydrated object the export needs, unused until now.
  if (valueType !== undefined && PERSON_REFERENCE_VALUE_TYPES.has(valueType)) {
    return buildReferenceFieldCol(column, fieldColumnPath, PEOPLE_TABLE_WS_ID, isMultiValue, readonly);
  }
  if (valueType !== undefined && COMPANY_REFERENCE_VALUE_TYPES.has(valueType)) {
    return buildReferenceFieldCol(column, fieldColumnPath, COMPANIES_TABLE_WS_ID, isMultiValue, readonly);
  }

  // Dropdown family → the option label (`value.data.text`), not the
  // `{ dropdownOptionId, text }` envelope.
  if (valueType !== undefined && DROPDOWN_VALUE_TYPES.has(valueType)) {
    return buildFlattenedScalarFieldCol({
      column,
      fieldColumnPath,
      pluckKey: 'text',
      isMultiValue,
      logicalType: 'string',
      readonly,
    });
  }

  // Homogeneous scalar arrays (filterable-text-multi / number-multi) → the joined
  // (display) / array (export) of the `value.data` elements themselves.
  if (valueType !== undefined && SCALAR_MULTI_VALUE_TYPES.has(valueType)) {
    return buildFlattenedScalarFieldCol({
      column,
      fieldColumnPath,
      pluckKey: undefined,
      isMultiValue: true,
      logicalType: valueType === 'number-multi' ? 'number' : 'string',
      readonly,
    });
  }

  // Everything else (scalar text/number/date, interaction, formula-number,
  // unknown) keeps the drill-into-`value.data` column with subfields.
  return {
    kind: 'col',
    path: fieldColumnPath,
    name: column.name,
    type: (column.type as TablePropertyType | undefined) ?? tablePropertyTypeForAffinityValueType(valueType),
    readonly,
    subfields: buildFieldSubfields(valueType),
    selectedSubfield: 0,
  };
}

/**
 * Build a foreign-key column for a person/company reference field. Renders and
 * exports the referenced record id (`value.data.id`, or the array of them for a
 * multi field) so a sync links to the People / Companies table instead of copying
 * the decorated reference object as JSON text. Display-and-export only: no
 * `fromCore` (the id can't be re-decorated into the on-disk `{ id, name, … }`
 * object), matching Pipedrive's single-select codec, and the verbatim element on
 * disk is untouched.
 */
function buildReferenceFieldCol(
  column: ArrayKeyedColumn,
  fieldColumnPath: string,
  linkedTableId: string,
  isMultiValue: boolean,
  readonly: true | undefined,
): TableViewCol {
  const idExpression = isMultiValue ? '$.value.data[*].id' : '$.value.data.id';
  return {
    kind: 'col',
    path: fieldColumnPath,
    name: column.name,
    // Rendered as text (the id / joined ids); the FK target drives the relation.
    type: 'string',
    foreignKey: { linkedTableId },
    displayTransformer: jsonPathDisplayTransformer(idExpression, isMultiValue),
    codec: { toCore: jsonPathToCore(idExpression, isMultiValue) },
    readonly,
  };
}

/**
 * Build a column that flattens the field's `value.data` to a scalar (or joined
 * scalars) for display and export: a dropdown's `.text` label, or a homogeneous
 * scalar array's own elements. The verbatim element on disk is untouched — this is
 * display + `toCore` only.
 */
function buildFlattenedScalarFieldCol(params: {
  column: ArrayKeyedColumn;
  fieldColumnPath: string;
  /** Object key to pluck from each `value.data` element (`text`), or undefined to take the element itself. */
  pluckKey: string | undefined;
  isMultiValue: boolean;
  /** The SEMANTIC type the flattened value carries — the type the destination column is built for. */
  logicalType: TablePropertyType;
  readonly: true | undefined;
}): TableViewCol {
  const { column, fieldColumnPath, pluckKey, isMultiValue, logicalType, readonly } = params;
  const dataExpression = isMultiValue ? '$.value.data[*]' : '$.value.data';
  const expression = pluckKey ? `${dataExpression}.${pluckKey}` : dataExpression;
  return {
    kind: 'col',
    path: fieldColumnPath,
    name: column.name,
    // Rendered through the text cell (the only cell that consults the display
    // transformer); `logicalType` tells the export what the flattened value IS.
    type: 'string',
    ...(logicalType !== 'string' ? { logicalType } : {}),
    displayTransformer: jsonPathDisplayTransformer(expression, isMultiValue),
    codec: { toCore: jsonPathToCore(expression, isMultiValue) },
    readonly,
  };
}

/** A display (grid) jsonpath transformer: a single scalar, or the comma-joined scalars of a multi field. */
function jsonPathDisplayTransformer(
  expression: string,
  isMultiValue: boolean,
): NonNullable<TableViewCol['displayTransformer']> {
  const arrayHandling: JSONPathArrayHandling = isMultiValue ? 'join_comma' : 'first';
  return { type: 'jsonpath', options: { expression, arrayHandling } };
}

/** A `codec.toCore` jsonpath transformer: a single scalar, or the array of scalars of a multi field. */
function jsonPathToCore(expression: string, isMultiValue: boolean): ClientSafeTransformer {
  const arrayHandling: JSONPathArrayHandling = isMultiValue ? 'array' : 'first';
  return { type: TransformerTypes.JSONPath, options: { expression, arrayHandling } };
}

/** Read a schema field's declared foreign-key target (`x-scratch-foreign-key.linkedTableId`), if any. */
function linkedTableIdFromSchema(fieldSchema: TSchema | undefined): string | undefined {
  const foreignKeyOptions = (fieldSchema as Record<string, unknown> | undefined)?.[X_SCRATCH_FOREIGN_KEY_OPTIONS] as
    | { linkedTableId?: unknown }
    | undefined;
  return typeof foreignKeyOptions?.linkedTableId === 'string' ? foreignKeyOptions.linkedTableId : undefined;
}

/** Map a TypeBox schema to a TablePropertyType based on Kind and format annotations. */
function mapType(fieldSchema: TSchema | undefined): TablePropertyType | undefined {
  if (!fieldSchema) return undefined;

  const format = (fieldSchema as TSchema & { format?: string }).format;
  if (format === 'date-time') return 'date';

  const kind = fieldSchema[Kind] as string | undefined;
  switch (kind) {
    case 'Boolean':
      return 'checkbox';
    case 'Number':
    case 'Integer':
      return 'number';
    case 'Array':
      return 'object';
    case 'Object':
      return 'object';
    case 'Union': {
      const anyOf = (fieldSchema as TSchema & { anyOf?: TSchema[] }).anyOf;
      if (anyOf) {
        const nonNull = anyOf.find((s) => s[Kind] !== 'Null');
        if (nonNull) return mapType(nonNull);
      }
      return 'object';
    }
    default:
      return undefined;
  }
}

/** Format a camelCase field ID as Title Case (e.g. `firstName` → `First Name`). */
function formatCamelCaseName(fieldId: string): string {
  const spaced = fieldId.replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ── Location banner groups ──

const LOCATION_SUBFIELDS = ['streetAddress', 'city', 'state', 'country', 'continent'] as const;

/**
 * Build a banner group for a location-type field, expanding `value.data` into
 * separate columns hung off the field's verbatim-array filter path (e.g.
 * `entity.fields.[id=dealroom-location].value.data.city`).
 *
 * Each sub-column is typed `string` (its value is a plain string) so it is not
 * reported as an unrecognized field, and its display name is qualified with the
 * parent location field — "Dealroom Location · City" — so when the banner group is
 * flattened for an export the names never collide across a table's several
 * location fields (which would otherwise be auto-suffixed to "City 2" / "City 3",
 * with no hint of which location they came from) (DEV-11066).
 */
function buildLocationBannerGroup(
  fieldId: string,
  column: ArrayKeyedColumn,
  fieldColumnPath: string,
): TableViewBannerGroup {
  // A distinct, human-readable label for this location field — the banner name
  // and the per-sub-column qualifier. e.g. "affinity-data-location" → "Affinity
  // Data Location", "dealroom-location" → "Dealroom Location", a user field →
  // its own name ("QA Location").
  const locationFieldLabel = deriveLocationFieldLabel(fieldId, column.name);

  const locationFieldIsReadonly = column.readonly || undefined;
  const cols: TableViewCol[] = LOCATION_SUBFIELDS.map((sub) => ({
    kind: 'col' as const,
    path: `${fieldColumnPath}.value.data.${sub}`,
    name: `${locationFieldLabel} · ${formatCamelCaseName(sub)}`,
    type: 'string' as const,
    readonly: locationFieldIsReadonly,
  }));

  return { kind: 'banner-group', name: locationFieldLabel, cols };
}

/**
 * Derive a distinct display label for a location field. Affinity's enrichment
 * location fields share the generic name "Location", so they are disambiguated by
 * the enrichment source encoded in their stable slug id
 * (`affinity-data-location` → "Affinity Data Location", `dealroom-location` →
 * "Dealroom Location"). A user-defined location field has a meaningful name and an
 * opaque `field-<n>` id, so it uses its own name.
 */
function deriveLocationFieldLabel(fieldKey: string, fieldName: string | undefined): string {
  const enrichmentSourceMatch = /^(.+?)-?location$/i.exec(fieldKey);
  const enrichmentSource = enrichmentSourceMatch?.[1];
  if (enrichmentSource) {
    const sourceLabel = enrichmentSource
      .split('-')
      .filter((word) => word.length > 0)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
    return `${sourceLabel} Location`;
  }
  return fieldName ?? 'Location';
}

/** Format a snake_case field ID as Title Case (e.g. `created_at` → `Created At`). */
function formatSnakeCaseName(fieldId: string): string {
  return fieldId
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
