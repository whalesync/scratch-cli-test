import { TSchema } from '@sinclair/typebox';
import {
  ForeignKeyOptionSchema,
  TablePropertyType,
  TableView,
  TableViewBannerGroup,
  TableViewCol,
  TransformerTypes,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { INTERCOM_UNIX_TIMESTAMP_DATA_TYPE, IntercomTableType, isIntercomTableType } from './intercom-types';

/**
 * The editorial rules that shape one table's default view. Keyed per table because Intercom reuses
 * field names with different shapes across objects — a conversation's `tags` carries tag names, a
 * contact's carries name-less stubs — so a rule written for one table is wrong for another.
 */
interface IntercomTableViewRules {
  /** Fields listed here appear first, in this order. Anything not listed goes after alphabetically. */
  priorityFields: string[];
  /**
   * Fields hidden by default. Kept deliberately short: a hidden column is not merely collapsed in
   * the grid, it is dropped from Live Export field selection entirely, so the user is never offered
   * it (the DEV-11148 lesson).
   */
  hiddenFields: ReadonlySet<string>;
  /**
   * Objects expanded into one column per leaf — `source.subject` as `Source (Subject)` — plus the raw
   * container appended hidden so nothing is lost. Mirrors the Stripe/Pipedrive composite pattern.
   */
  compositeObjectFields: ReadonlySet<string>;
  /**
   * Object fields whose useful value is one repeated inner scalar joined into a readable list. The
   * stored record keeps the verbatim object — this is view/codec only (Prime Directive intact).
   */
  flattenedListFields: Readonly<Record<string, { jsonPathExpression: string }>>;
  /**
   * An object field whose declared leaves are user-defined (custom) attributes, gathered under a
   * banner group named `bannerName` instead of being expanded inline.
   */
  customAttributesField?: { fieldId: string; bannerName: string };
  /**
   * Object fields shown as ONE column for one of their leaves (`plan` → its `name`), plus the raw
   * container hidden — for objects where the other leaves (`type`, `id`) are plumbing.
   */
  objectFieldsShownAsOneLeaf?: Readonly<Record<string, string>>;
  /**
   * Stub-list fields (`{type: 'list', data: [{type, id, url}], …}`) whose item ids are foreign keys,
   * per the schema's annotation on `data[].id`. Shown as one link column over `data`.
   */
  foreignKeyStubListFields?: ReadonlySet<string>;
}

/**
 * Hidden fields for the Help Center tables and Conversations: plumbing (`workspace_id`), an
 * open-ended bag with no declared keys (`custom_attributes`, `conversation_rating`,
 * `translated_content`), or a nested list whose useful values are surfaced as their own columns.
 */
const HELP_CENTER_AND_CONVERSATIONS_HIDDEN_FIELDS = new Set([
  'workspace_id',
  'translated_content',
  'parent_ids',
  'statistics',
  'conversation_parts',
  'custom_attributes',
  'conversation_rating',
]);

/**
 * A conversation's `source` is its INITIATING MESSAGE (`{type, delivered_as, subject, body,
 * author{name,email}, url, redacted}`) — the highest-value content on the record. Left whole it
 * downgrades to one blob of JSON text, which is unusable at every destination (DEV-11287).
 *
 * A conversation's `contacts` is deliberately NOT a composite: its elements are `{type, id}` with no
 * human-readable scalar to pluck, so JSON text is the honest rendering. `tags` is a flatten rather
 * than an expansion — its useful value is the list of names (`{type: 'tag.list', tags: [{id, name}]}`).
 */
const HELP_CENTER_AND_CONVERSATIONS_COMPOSITE_OBJECT_FIELDS = new Set(['source']);
const HELP_CENTER_AND_CONVERSATIONS_FLATTENED_LIST_FIELDS = {
  tags: { jsonPathExpression: '$.tags[*].name' },
};

/**
 * Contacts.
 *  - `custom_attributes` is the most valuable data on a contact and is declared per attribute from
 *    the workspace's own definitions, so it is gathered under a "Custom Attributes" banner (Intercom's
 *    own term) rather than hidden.
 *  - `tags` is `{type: 'list', data: [{id, type, url}]}` — the stubs carry NO `name` (probed live), so
 *    the readable value available is the tag ids.
 *  - `companies` is a link column into the Companies table (the schema annotates `companies.data[].id`
 *    as a foreign key). Intercom inlines at most 10 of a contact's companies, so a contact in more
 *    links only those 10. `notes`, the subscription lists, `social_profiles` and `avatar` are stub
 *    lists or blobs with nothing readable to export.
 */
const CONTACTS_VIEW_RULES: IntercomTableViewRules = {
  priorityFields: [
    'email',
    'name',
    'role',
    'id',
    'external_id',
    'phone',
    'created_at',
    'updated_at',
    'last_seen_at',
    'signed_up_at',
  ],
  hiddenFields: new Set([
    'type',
    'workspace_id',
    'avatar',
    'social_profiles',
    'notes',
    'opted_in_subscription_types',
    'opted_out_subscription_types',
  ]),
  compositeObjectFields: new Set(['location']),
  flattenedListFields: { tags: { jsonPathExpression: '$.data[*].id' } },
  customAttributesField: { fieldId: 'custom_attributes', bannerName: 'Custom Attributes' },
  foreignKeyStubListFields: new Set(['companies']),
};

/**
 * Companies.
 *  - `tags` is `{type: 'tag.list', tags: [{type, id, name}]}` — names are present, the same shape and
 *    flatten as a conversation's (probed live).
 *  - `plan` is `{type, id, name}` (or `{}` when unset): only the name is meaningful.
 *  - `segments` items couldn't be observed (segments can't be created through the API) and
 *    `app_id`/`type` are plumbing, so they are hidden.
 *  - Custom attributes are gathered under the same "Custom Attributes" banner as on Contacts.
 */
const COMPANIES_VIEW_RULES: IntercomTableViewRules = {
  priorityFields: [
    'name',
    'company_id',
    'id',
    'website',
    'industry',
    'plan',
    'size',
    'user_count',
    'session_count',
    'monthly_spend',
    'created_at',
    'updated_at',
    'remote_created_at',
    'last_request_at',
  ],
  hiddenFields: new Set(['type', 'app_id', 'segments']),
  compositeObjectFields: new Set(),
  flattenedListFields: { tags: { jsonPathExpression: '$.tags[*].name' } },
  customAttributesField: { fieldId: 'custom_attributes', bannerName: 'Custom Attributes' },
  objectFieldsShownAsOneLeaf: { plan: 'name' },
};

/**
 * View rules per table. Typed over every {@link IntercomTableType} so adding a table forces a
 * decision here rather than silently inheriting another table's rules.
 */
const VIEW_RULES_BY_TABLE_TYPE: Record<IntercomTableType, IntercomTableViewRules> = {
  articles: {
    priorityFields: ['title', 'id', 'description', 'author_id', 'state', 'url', 'created_at', 'updated_at'],
    hiddenFields: HELP_CENTER_AND_CONVERSATIONS_HIDDEN_FIELDS,
    compositeObjectFields: HELP_CENTER_AND_CONVERSATIONS_COMPOSITE_OBJECT_FIELDS,
    flattenedListFields: HELP_CENTER_AND_CONVERSATIONS_FLATTENED_LIST_FIELDS,
  },
  collections: {
    priorityFields: ['name', 'id', 'description', 'url', 'order', 'created_at', 'updated_at'],
    hiddenFields: HELP_CENTER_AND_CONVERSATIONS_HIDDEN_FIELDS,
    compositeObjectFields: HELP_CENTER_AND_CONVERSATIONS_COMPOSITE_OBJECT_FIELDS,
    flattenedListFields: HELP_CENTER_AND_CONVERSATIONS_FLATTENED_LIST_FIELDS,
  },
  conversations: {
    priorityFields: [
      'title',
      'id',
      'state',
      'open',
      'read',
      'priority',
      'admin_assignee_id',
      'created_at',
      'updated_at',
    ],
    hiddenFields: HELP_CENTER_AND_CONVERSATIONS_HIDDEN_FIELDS,
    compositeObjectFields: HELP_CENTER_AND_CONVERSATIONS_COMPOSITE_OBJECT_FIELDS,
    flattenedListFields: HELP_CENTER_AND_CONVERSATIONS_FLATTENED_LIST_FIELDS,
  },
  contacts: CONTACTS_VIEW_RULES,
  companies: COMPANIES_VIEW_RULES,
};

/** Rules for a table wsId this connector doesn't know: no priority, nothing hidden or reshaped. */
const RULES_FOR_UNKNOWN_TABLE_TYPE: IntercomTableViewRules = {
  priorityFields: [],
  hiddenFields: new Set(),
  compositeObjectFields: new Set(),
  flattenedListFields: {},
};

/**
 * Build a default TableView for an Intercom entity type by reading the TypeBox schema.
 * Prioritizes important business fields, hides noisy metadata, and maps types.
 */
export function buildIntercomDefaultView(schema: TSchema, entityType: string): TableView {
  const properties: Record<string, TSchema> =
    (schema as TSchema & { properties?: Record<string, TSchema> }).properties ?? {};
  const viewRules = isIntercomTableType(entityType)
    ? VIEW_RULES_BY_TABLE_TYPE[entityType]
    : RULES_FOR_UNKNOWN_TABLE_TYPE;

  const sorted = sortFields(Object.keys(properties), viewRules.priorityFields);
  const standardColumnNames = new Set(
    sorted.filter((fieldId) => fieldId !== viewRules.customAttributesField?.fieldId).map(formatFieldName),
  );
  const cols: (TableViewCol | TableViewBannerGroup)[] = [];

  for (const fieldId of sorted) {
    cols.push(...buildColsForField(fieldId, properties[fieldId], viewRules, standardColumnNames));
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

  cols.push(buildRawContainerCol(path, name, isReadonly));

  return cols;
}

/**
 * The custom attributes as a banner group of one column per declared attribute, plus the raw
 * container appended hidden (so the whole bag, including attributes created after the schema was
 * built, stays available to turn on).
 *
 * Columns are named by the attribute's own name — Intercom shows users that name, and it is already
 * human-readable (`Plan Tier`, `paid_subscriber` → `Paid Subscriber`). A name that collides with a
 * standard column (`Email`) is qualified as `Custom Attributes (Email)`, because a Live Export
 * destination can't hold two columns with one name.
 */
function buildCustomAttributeCols(
  path: string,
  name: string,
  bannerName: string,
  properties: Record<string, TSchema>,
  standardColumnNames: ReadonlySet<string>,
): (TableViewCol | TableViewBannerGroup)[] {
  const customAttributeCols = Object.entries(properties).map(([attributeName, attributeSchema]) => {
    const formattedAttributeName = formatFieldName(attributeName);
    const columnName = standardColumnNames.has(formattedAttributeName)
      ? `${name} (${formattedAttributeName})`
      : formattedAttributeName;
    return buildLeafCol(
      `${path}.${attributeName}`,
      columnName,
      attributeSchema,
      attributeSchema?.[X_SCRATCH_READONLY] === true,
    );
  });

  const rawContainerCol = buildRawContainerCol(path, name, false);
  if (customAttributeCols.length === 0) return [rawContainerCol];
  return [{ kind: 'banner-group', name: bannerName, cols: customAttributeCols }, rawContainerCol];
}

/** A hidden column holding a container's raw value, so nothing is lost when its leaves are surfaced. */
function buildRawContainerCol(path: string, name: string, isReadonly: boolean): TableViewCol {
  return {
    kind: 'col',
    path,
    name: `${name} (raw)`,
    type: 'object',
    hidden: true,
    ...(isReadonly ? { readonly: true } : {}),
  };
}

/** The foreign-key annotation on a stub list's `data[].id`, if the schema declares one. */
function stubListItemIdForeignKeyOf(fieldSchema: TSchema | undefined): TableViewCol['foreignKey'] | undefined {
  const dataSchema = objectPropertiesOf(fieldSchema)?.data as (TSchema & { items?: TSchema }) | undefined;
  return foreignKeyOf(objectPropertiesOf(dataSchema?.items)?.id);
}

/**
 * A link column over a stub list's `data` array (`[{type, id, url}, …]`) — the HubSpot association
 * pattern. The foreign key is declared on the COLUMN because its annotation lives on `data[].id`,
 * below the column's path, where neither the schema join nor scratch-git's index looks. The ids are
 * flattened for display; `codec.toCore` extracts them as the id list a sync resolves to linked
 * records. Read-only, so there is no `fromCore`.
 */
function buildStubListForeignKeyCol(
  path: string,
  name: string,
  foreignKey: NonNullable<TableViewCol['foreignKey']>,
  isReadonly: boolean,
): TableViewCol {
  return {
    kind: 'col',
    path: `${path}.data`,
    name,
    type: 'string',
    foreignKey,
    displayTransformer: {
      type: TransformerTypes.JSONPath,
      options: { expression: '$[*].id', arrayHandling: 'join_comma' },
    },
    codec: {
      toCore: { type: TransformerTypes.JSONPath, options: { expression: '$[*].id', arrayHandling: 'array' } },
    },
    ...(isReadonly ? { readonly: true } : {}),
  };
}

/** Build the column(s) a single top-level schema field contributes to the view. */
function buildColsForField(
  fieldId: string,
  fieldSchema: TSchema,
  viewRules: IntercomTableViewRules,
  standardColumnNames: ReadonlySet<string>,
): (TableViewCol | TableViewBannerGroup)[] {
  const name = formatFieldName(fieldId);
  const isReadonly = fieldSchema?.[X_SCRATCH_READONLY] === true;

  if (viewRules.hiddenFields.has(fieldId)) {
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

  if (viewRules.customAttributesField?.fieldId === fieldId) {
    const properties = objectPropertiesOf(fieldSchema);
    if (properties) {
      return buildCustomAttributeCols(
        fieldId,
        name,
        viewRules.customAttributesField.bannerName,
        properties,
        standardColumnNames,
      );
    }
  }

  if (viewRules.foreignKeyStubListFields?.has(fieldId)) {
    const foreignKey = stubListItemIdForeignKeyOf(fieldSchema);
    if (foreignKey) {
      return [
        buildStubListForeignKeyCol(fieldId, name, foreignKey, isReadonly),
        buildRawContainerCol(fieldId, name, isReadonly),
      ];
    }
  }

  const shownLeafKey = viewRules.objectFieldsShownAsOneLeaf?.[fieldId];
  const shownLeafSchema = shownLeafKey ? objectPropertiesOf(fieldSchema)?.[shownLeafKey] : undefined;
  if (shownLeafKey && shownLeafSchema) {
    return [
      buildLeafCol(
        `${fieldId}.${shownLeafKey}`,
        name,
        shownLeafSchema,
        isReadonly || shownLeafSchema[X_SCRATCH_READONLY] === true,
      ),
      buildRawContainerCol(fieldId, name, isReadonly),
    ];
  }

  const flattenedList = viewRules.flattenedListFields[fieldId];
  if (flattenedList && objectPropertiesOf(fieldSchema)) {
    return [buildFlattenedListCol(fieldId, name, flattenedList.jsonPathExpression, isReadonly)];
  }

  if (viewRules.compositeObjectFields.has(fieldId)) {
    const properties = objectPropertiesOf(fieldSchema);
    if (properties) return expandCompositeObjectCols(fieldId, name, properties, isReadonly);
  }

  return [buildLeafCol(fieldId, name, fieldSchema, isReadonly)];
}
