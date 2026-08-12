import { TSchema } from '@sinclair/typebox';
import {
  ForeignKeyOptionSchema,
  TablePropertyType,
  TableView,
  TableViewCol,
  TransformerTypes,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { INTERCOM_UNIX_TIMESTAMP_DATA_TYPE } from './intercom-types';

// ── Priority fields per entity type ──
// Fields listed here appear first, in this order. Anything not listed goes after alphabetically.
const PRIORITY_FIELDS: Record<string, string[]> = {
  articles: ['title', 'id', 'description', 'author_id', 'state', 'url', 'created_at', 'updated_at'],
  collections: ['name', 'id', 'description', 'url', 'order', 'created_at', 'updated_at'],
  conversations: ['title', 'id', 'state', 'open', 'read', 'priority', 'admin_assignee_id', 'created_at', 'updated_at'],
};

// Fields that should be hidden by default — noisy or deeply nested data.
//
// Kept deliberately short: a hidden column is not merely collapsed in the grid, it is dropped from
// Live Export field selection entirely, so the user is never offered it (the DEV-11148 lesson).
// Everything here is either plumbing (`workspace_id`), an open-ended bag with no declared keys
// (`custom_attributes`, `conversation_rating`, `translated_content`), or a nested list whose useful
// values are surfaced as their own columns instead.
const HIDDEN_FIELDS = new Set([
  'workspace_id',
  'translated_content',
  'parent_ids',
  'statistics',
  'conversation_parts',
  'custom_attributes',
  'conversation_rating',
]);

/**
 * Objects expanded into one column per leaf — `source.subject` as `Source (Subject)` — plus the raw
 * container appended hidden so nothing is lost.
 *
 * A conversation's `source` is its INITIATING MESSAGE (`{type, delivered_as, subject, body,
 * author{name,email}, url, redacted}`) — the highest-value content on the record. Left whole it
 * downgrades to one blob of JSON text, which is unusable at every destination (DEV-11287). Mirrors
 * the Stripe/Pipedrive composite pattern.
 *
 * `contacts` is deliberately NOT here: its elements are `{type, id}` with no human-readable scalar
 * to pluck, so JSON text is the honest rendering. `tags` is handled separately — its useful value
 * is the list of names, which is a flatten rather than an expansion.
 */
const COMPOSITE_OBJECT_FIELDS = new Set(['source']);

/**
 * Object fields whose useful value is one repeated inner scalar joined into a readable list.
 * `tags` is `{type: 'tag.list', tags: [{id, name}]}`; what a user wants is the names (DEV-11287).
 * The stored record keeps the verbatim object — this is view/codec only (Prime Directive intact).
 */
const FLATTENED_LIST_FIELDS: Record<string, { jsonPathExpression: string }> = {
  tags: { jsonPathExpression: '$.tags[*].name' },
};

/**
 * Build a default TableView for an Intercom entity type by reading the TypeBox schema.
 * Prioritizes important business fields, hides noisy metadata, and maps types.
 */
export function buildIntercomDefaultView(schema: TSchema, entityType: string): TableView {
  const properties: Record<string, TSchema> =
    (schema as TSchema & { properties?: Record<string, TSchema> }).properties ?? {};

  const fieldIds = Object.keys(properties);
  const priority = PRIORITY_FIELDS[entityType] ?? [];
  const sorted = sortFields(fieldIds, priority);
  const cols: TableViewCol[] = [];

  for (const fieldId of sorted) {
    cols.push(...buildColsForField(fieldId, properties[fieldId]));
  }

  return { name: 'Default', cols };
}

// ── Helpers ──

/** Sort field IDs so priority fields come first (in their defined order), then the rest alphabetically. */
function sortFields(fieldIds: string[], priority: string[]): string[] {
  const priorityIndex = new Map(priority.map((f, i) => [f, i]));
  const inPriority: string[] = [];
  const rest: string[] = [];

  for (const id of fieldIds) {
    if (priorityIndex.has(id)) {
      inPriority.push(id);
    } else {
      rest.push(id);
    }
  }

  inPriority.sort((a, b) => (priorityIndex.get(a) ?? 0) - (priorityIndex.get(b) ?? 0));
  rest.sort((a, b) => a.localeCompare(b));

  return [...inPriority, ...rest];
}

/**
 * Strip a nullable union down to the arm carrying the real shape. Intercom declares most optional
 * fields as `Union([<shape>, Null])`, so without this the object/string checks below see a bare
 * union and fall through.
 */
function unwrapNullableSchema(fieldSchema: TSchema | undefined): TSchema | undefined {
  if (!fieldSchema) return undefined;
  const unionArms = (fieldSchema as TSchema & { anyOf?: TSchema[] }).anyOf;
  if (!unionArms) return fieldSchema;
  return unionArms.find((arm) => (arm as TSchema & { type?: string }).type !== 'null') ?? fieldSchema;
}

/** The declared object properties of a field, or undefined when it isn't an object with declared keys. */
function objectPropertiesOf(fieldSchema: TSchema | undefined): Record<string, TSchema> | undefined {
  const shape = unwrapNullableSchema(fieldSchema);
  if (!shape || (shape as TSchema & { type?: string }).type !== 'object') return undefined;
  // A `Record` (Intercom's open-ended `custom_attributes`) is `type: 'object'` with no declared
  // `properties`; there is nothing to expand, so it is not a composite.
  return (shape as TSchema & { properties?: Record<string, TSchema> }).properties;
}

/**
 * Map a schema to a TablePropertyType.
 *
 * NB: reads the serialized JSON-Schema `type` keyword, never TypeBox's `Kind` symbol. A view can be
 * rebuilt from a stored (JSON-parsed) schema, where symbols are gone — a `Kind`-based mapping
 * silently types every column `undefined` there, and an untyped column is inferred from the raw
 * JSON type downstream, losing every hint this view exists to carry. Same reasoning as
 * `stripe-default-view.ts` / `pipedrive-default-view.ts`.
 */
function mapType(fieldSchema: TSchema | undefined): TablePropertyType | undefined {
  const shape = unwrapNullableSchema(fieldSchema);
  if (!shape) return undefined;

  const format = (shape as TSchema & { format?: string }).format;
  if (format === 'date-time' || format === 'date') return 'date';
  if (format === 'uri') return 'url';

  switch ((shape as TSchema & { type?: string }).type) {
    case 'boolean':
      return 'checkbox';
    case 'number':
    case 'integer':
      return 'number';
    case 'string':
      return 'string';
    case 'array':
    case 'object':
      return 'object';
    default:
      return undefined;
  }
}

/** Whether Intercom reports this field as a Unix-epoch timestamp (see the schema annotation). */
function isUnixTimestampField(fieldSchema: TSchema | undefined): boolean {
  return (
    (fieldSchema as (TSchema & { [X_SCRATCH_CONNECTOR_DATA_TYPE]?: string }) | undefined)?.[
      X_SCRATCH_CONNECTOR_DATA_TYPE
    ] === INTERCOM_UNIX_TIMESTAMP_DATA_TYPE
  );
}

/**
 * The closed set of string values a field may take, when the schema declares it as a union of
 * string literals (`Union([Literal('published'), Literal('draft')])` serializes to an `anyOf` of
 * `const` arms). Undefined when the field is an open string, so a column only claims to be a select
 * when the option set is genuinely known.
 */
function declaredStringOptionsOf(fieldSchema: TSchema | undefined): string[] | undefined {
  if (!fieldSchema) return undefined;
  const unionArms = (fieldSchema as TSchema & { anyOf?: TSchema[] }).anyOf;
  if (!unionArms || unionArms.length === 0) return undefined;

  const options: string[] = [];
  for (const arm of unionArms) {
    if ((arm as TSchema & { type?: string }).type === 'null') continue;
    const constValue = (arm as TSchema & { const?: unknown }).const;
    if (typeof constValue !== 'string') return undefined;
    options.push(constValue);
  }
  return options.length > 0 ? options : undefined;
}

/** The foreign-key annotation a schema field carries, mirrored onto the view column. */
function foreignKeyOf(fieldSchema: TSchema | undefined): TableViewCol['foreignKey'] | undefined {
  const annotation = (
    fieldSchema as (TSchema & { [X_SCRATCH_FOREIGN_KEY_OPTIONS]?: ForeignKeyOptionSchema }) | undefined
  )?.[X_SCRATCH_FOREIGN_KEY_OPTIONS];
  if (!annotation?.linkedTableId) return undefined;
  return {
    linkedTableId: annotation.linkedTableId,
    ...(annotation.linkedTableRemoteId !== undefined ? { linkedTableRemoteId: annotation.linkedTableRemoteId } : {}),
    ...(annotation.isSingleValued !== undefined ? { isSingleValued: annotation.isSingleValued } : {}),
  };
}

/** Format a snake_case field ID as a human-readable column name. */
function formatFieldName(fieldId: string): string {
  return fieldId
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * A Unix-epoch column, rendered as a date and exported as one (DEV-11284).
 *
 * The raw value stays the integer Intercom sent; everything here is view/codec, so records on disk
 * are byte-identical to the API response. Three parts, each consumed by a different layer:
 *  - `type: 'string'` — the TEXT cell is the only grid cell that consults `displayTransformer`, so
 *    the column must render through it for the user to see a date rather than `1786570437`.
 *  - `logicalType: 'datetime'` — what the value actually IS, which is what the export layer reads
 *    to create a real datetime destination field (`'date'` alone would drop the time-of-day, since
 *    the generic time-bearing signal is a `format` the raw number can't carry).
 *  - `codec.toCore` — converts the epoch to ISO-8601 on the way into a sync, so the destination is
 *    handed a date and not the bare integer.
 */
function buildUnixTimestampCol(path: string, name: string, isReadonly: boolean): TableViewCol {
  return {
    kind: 'col',
    path,
    name,
    type: 'string',
    logicalType: 'datetime',
    // Intercom reports every timestamp in epoch SECONDS. Fresh objects per column: a view is
    // serialized per table, so nothing should share mutable structure between columns.
    displayTransformer: { type: 'epoch_to_iso', options: { unit: 'seconds' } },
    codec: { toCore: { type: TransformerTypes.EpochToIso, options: { unit: 'seconds' } } },
    ...(isReadonly ? { readonly: true } : {}),
  };
}

/**
 * A column whose raw value is an object holding a list, flattened for display (and for Live Export)
 * by joining one text-bearing key from each element.
 */
function buildFlattenedListCol(
  path: string,
  name: string,
  jsonPathExpression: string,
  isReadonly: boolean,
): TableViewCol {
  return {
    kind: 'col',
    path,
    name,
    type: 'string',
    logicalType: 'string',
    displayTransformer: {
      type: TransformerTypes.JSONPath,
      options: { expression: jsonPathExpression, arrayHandling: 'join_comma' },
    },
    ...(isReadonly ? { readonly: true } : {}),
  };
}

/** A single leaf column — a timestamp or a select if the schema says so, otherwise a plain typed column. */
function buildLeafCol(path: string, name: string, fieldSchema: TSchema | undefined, isReadonly: boolean): TableViewCol {
  if (isUnixTimestampField(fieldSchema)) return buildUnixTimestampCol(path, name, isReadonly);

  // A field declared as a union of string literals has a statically known option set (an article's
  // `state` is exactly `published | draft`), so the destination gets a native select rather than a
  // free-text column — strictly better ergonomics, and the values round-trip unchanged (DEV-11288).
  // Only the SEMANTIC type says `select`: the value is a plain string and renders as one, so the
  // render `type` stays `'string'` and no grid cell has to learn a new kind. The choices themselves
  // are read back off the schema by the create-schema plan generator.
  const isDeclaredSelect = declaredStringOptionsOf(fieldSchema) !== undefined;

  const foreignKey = foreignKeyOf(fieldSchema);
  return {
    kind: 'col',
    path,
    name,
    type: isDeclaredSelect ? 'string' : mapType(fieldSchema),
    ...(isDeclaredSelect ? { logicalType: 'select' } : {}),
    ...(foreignKey ? { foreignKey } : {}),
    ...(isReadonly ? { readonly: true } : {}),
  };
}

/**
 * Expand a composite object into one column per leaf, plus the raw container hidden.
 *
 * Recurses one level for a nested object so a source message's author becomes real columns
 * (`source.author.email` → `Source (Author Email)`) instead of riding inside one JSON blob. Names
 * are qualified with the parent field so sibling composites can't collide.
 */
function expandCompositeObjectCols(
  path: string,
  name: string,
  properties: Record<string, TSchema>,
  isReadonly: boolean,
): TableViewCol[] {
  const cols: TableViewCol[] = [];

  for (const [subfieldKey, subfieldSchema] of Object.entries(properties)) {
    const subfieldPath = `${path}.${subfieldKey}`;
    const subfieldName = `${name} (${formatFieldName(subfieldKey)})`;
    const isSubfieldReadonly = isReadonly || subfieldSchema?.[X_SCRATCH_READONLY] === true;

    const nestedProperties = objectPropertiesOf(subfieldSchema);
    if (nestedProperties) {
      for (const [nestedKey, nestedSchema] of Object.entries(nestedProperties)) {
        cols.push(
          buildLeafCol(
            `${subfieldPath}.${nestedKey}`,
            `${name} (${formatFieldName(subfieldKey)} ${formatFieldName(nestedKey)})`,
            nestedSchema,
            isSubfieldReadonly || nestedSchema?.[X_SCRATCH_READONLY] === true,
          ),
        );
      }
      continue;
    }

    cols.push(buildLeafCol(subfieldPath, subfieldName, subfieldSchema, isSubfieldReadonly));
  }

  cols.push({
    kind: 'col',
    path,
    name: `${name} (raw)`,
    type: 'object',
    hidden: true,
    ...(isReadonly ? { readonly: true } : {}),
  });

  return cols;
}

/** Build the column(s) a single top-level schema field contributes to the view. */
function buildColsForField(fieldId: string, fieldSchema: TSchema): TableViewCol[] {
  const name = formatFieldName(fieldId);
  const isReadonly = fieldSchema?.[X_SCRATCH_READONLY] === true;

  if (HIDDEN_FIELDS.has(fieldId)) {
    return [
      {
        kind: 'col',
        path: fieldId,
        name,
        type: mapType(fieldSchema),
        ...(isReadonly ? { readonly: true } : {}),
        hidden: true,
      },
    ];
  }

  const flattenedList = FLATTENED_LIST_FIELDS[fieldId];
  if (flattenedList && objectPropertiesOf(fieldSchema)) {
    return [buildFlattenedListCol(fieldId, name, flattenedList.jsonPathExpression, isReadonly)];
  }

  if (COMPOSITE_OBJECT_FIELDS.has(fieldId)) {
    const properties = objectPropertiesOf(fieldSchema);
    if (properties) return expandCompositeObjectCols(fieldId, name, properties, isReadonly);
  }

  return [buildLeafCol(fieldId, name, fieldSchema, isReadonly)];
}
