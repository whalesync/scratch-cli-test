import { Kind, TSchema } from '@sinclair/typebox';
import {
  ArrayKeyedColumn,
  buildKeyedArrayColumnPath,
  getArrayKeyedByOptions,
  TablePropertyType,
  TableView,
  TableViewBannerGroup,
  TableViewCol,
  TableViewSubfield,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import {
  affinityFieldValueTypeFromSchemasById,
  FIELD_KEY_FIELD,
  getAffinityFieldSchemasById,
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

const HIDDEN_ENTITY_FILES_FIELDS = new Set(['person_id', 'organization_id', 'opportunity_id', 'uploader_id']);

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

/**
 * Build a column for one dynamic Affinity field. The column addresses the whole
 * verbatim array element by its filter path (`entity.fields.[id=field-1]` /
 * `fields.[id=field-1]`); subfields drill into `value.data` etc. relative to it.
 * `name` / `type` / `readonly` come from the `x-scratch-array-keyed-by` column.
 */
function buildDynamicFieldCol(
  column: ArrayKeyedColumn,
  valueType: string | undefined,
  fieldColumnPath: string,
): TableViewCol {
  return {
    kind: 'col',
    path: fieldColumnPath,
    name: column.name,
    type: (column.type as TablePropertyType | undefined) ?? tablePropertyTypeForAffinityValueType(valueType),
    // enriched / relationship-intelligence / computed fields are read-only; the
    // grid honors the column's own readonly, so publish never gets an edit it
    // would reject.
    readonly: column.readonly || undefined,
    subfields: buildFieldSubfields(valueType),
    selectedSubfield: 0,
  };
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
 */
function buildLocationBannerGroup(
  fieldId: string,
  column: ArrayKeyedColumn,
  fieldColumnPath: string,
): TableViewBannerGroup {
  // Derive a disambiguated group name from the field id.
  // e.g. "dealroom-location" → "Location (Dealroom)", "affinity-data-location" → "Location (Affinity Data)"
  const groupName = deriveLocationGroupName(fieldId, column.name);

  const locationFieldIsReadonly = column.readonly || undefined;
  const cols: TableViewCol[] = LOCATION_SUBFIELDS.map((sub) => ({
    kind: 'col' as const,
    path: `${fieldColumnPath}.value.data.${sub}`,
    name: formatCamelCaseName(sub),
    readonly: locationFieldIsReadonly,
  }));

  return { kind: 'banner-group', name: groupName, cols };
}

/** Derive a display name for a location field, disambiguating by enrichment source in the field key. */
function deriveLocationGroupName(fieldKey: string, description: string | undefined): string {
  // Strip common location suffixes to get the source prefix
  const source = fieldKey.replace(/-?location$/, '');
  if (!source) return description ?? 'Location';

  const sourceLabel = source
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return `Location (${sourceLabel})`;
}

/** Format a snake_case field ID as Title Case (e.g. `created_at` → `Created At`). */
function formatSnakeCaseName(fieldId: string): string {
  return fieldId
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
