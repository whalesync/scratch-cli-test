import type { TSchema } from '@sinclair/typebox';
import {
  TransformerTypes,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_READONLY,
  type TablePropertyType,
  type TableView,
  type TableViewBannerGroup,
  type TableViewCol,
} from '@spinner/shared-types';
import type { BaseJsonTableSpec } from '../../types';
import type { PipedriveEntityType } from './pipedrive-types';

/**
 * Default view for a Pipedrive entity — a PURE function of the table spec.
 *
 * The schema stays the verbatim description of what the API returns (Connector
 * Prime Directive); this view is where the display opinions live
 * (DEV-11033/11034/11035/11036):
 *
 * - **Date typing** (DEV-11033): every field whose schema carries
 *   `format: 'date'` / `'date-time'` is typed `'date'`, so the plan generator
 *   creates real date columns at a destination (`format: 'date-time'` promotes
 *   to `includesTime` downstream).
 * - **Select labels** (DEV-11034): enum/set fields carry a `value_map` codec
 *   built from the schema's option literals (`Type.Literal(id, { title })`), so
 *   a sync exports the human label ("Opt, B"), not the raw option id (33). The
 *   option sets are open — an id outside the discovered set passes through as
 *   its string form.
 * - **Multi-value emails/phones** (DEV-11035): the `[{value, label, primary}]`
 *   arrays render and sync as their comma-joined `value`s via a jsonpath
 *   display transformer, instead of concatenated JSON fragments.
 * - **Junk columns hidden** (DEV-11036): the `custom_fields` container, each
 *   composite field's container object (monetary/address/daterange/time/
 *   timerange — their unpacked subfield columns stay visible), and notes'
 *   server-hydrated stubs are `hidden` — kept toggleable in the grid but
 *   excluded from a plan/export.
 *
 * A composite field's subfield columns are named "<Field> (<Subfield>)" so
 * sibling monetary/daterange fields don't all collide on "value" at the
 * destination. `picture_id` is pinned to a plain number column (its schema is a
 * `Number | {url} | Null` union; expanding the object branch produces the
 * unsavable `picture_id.url` plan of DEV-11030).
 */
export function buildPipedriveDefaultView(spec: BaseJsonTableSpec): TableView {
  const entityType = spec.id.wsId as PipedriveEntityType;
  const schemaProperties = (spec.schema as TSchema & { properties?: Record<string, TSchema> }).properties ?? {};

  const systemFieldCols: TableViewCol[] = [];
  const customFieldCols: TableViewCol[] = [];
  const trailingHiddenContainerCols: TableViewCol[] = [];

  for (const [fieldCode, fieldSchema] of Object.entries(schemaProperties)) {
    // v2 entities nest custom fields under the `custom_fields` container: one column per custom
    // field inside it, plus the container itself hidden (its raw JSON duplicates every unpacked
    // column — DEV-11036).
    if (fieldCode === 'custom_fields') {
      const customFieldProperties =
        (fieldSchema as TSchema & { properties?: Record<string, TSchema> }).properties ?? {};
      for (const [customFieldCode, customFieldSchema] of Object.entries(customFieldProperties)) {
        customFieldCols.push(
          ...buildColumnsForField(entityType, `custom_fields.${customFieldCode}`, customFieldCode, customFieldSchema),
        );
      }
      trailingHiddenContainerCols.push({
        kind: 'col',
        path: 'custom_fields',
        name: 'Custom Fields (raw)',
        type: 'object',
        hidden: true,
      });
      continue;
    }

    // v1 entities (leads) carry custom fields flat, as 40-char hash keys at the top level; group
    // them with the nested customs so the grid reads the same across entities.
    const columnGroup = isFlatCustomFieldCode(fieldCode) ? customFieldCols : systemFieldCols;
    columnGroup.push(...buildColumnsForField(entityType, fieldCode, fieldCode, fieldSchema));
  }

  const orderedSystemFieldCols = orderColumnsTitleThenIdFirst(systemFieldCols, spec.titlePath, spec.idPath);

  const cols: (TableViewCol | TableViewBannerGroup)[] = [...orderedSystemFieldCols];
  if (customFieldCols.length > 0) {
    // "Custom Fields" is a real, pre-existing Pipedrive concept (Settings → Data fields), not an
    // invented theme, so it satisfies the banner-group contract.
    cols.push({ kind: 'banner-group', name: 'Custom Fields', cols: customFieldCols });
  }
  cols.push(...trailingHiddenContainerCols);

  return { name: 'Default', cols };
}

/**
 * Composite object field types (by their `x-scratch-connector-data-type` annotation) that unpack
 * into one column per subfield, with the raw container object hidden alongside (DEV-11036).
 */
const COMPOSITE_CONNECTOR_DATA_TYPES: ReadonlySet<string> = new Set([
  'monetary',
  'address',
  'daterange',
  'time',
  'timerange',
]);

/**
 * Per-entity field codes hidden in the default view. Notes' server-hydrated read-only stubs each
 * duplicate — as one raw JSON blob — what the sibling FK columns (`deal_id`, `person_id`, …)
 * already express (DEV-11036).
 */
const HIDDEN_FIELD_CODES_BY_ENTITY: Partial<Record<PipedriveEntityType, ReadonlySet<string>>> = {
  notes: new Set(['organization', 'person', 'deal', 'lead', 'user']),
};

/**
 * Build the view column(s) for one schema field. Most fields yield exactly one column; a
 * composite object field yields one column per subfield plus its hidden container.
 */
function buildColumnsForField(
  entityType: PipedriveEntityType,
  path: string,
  fieldCode: string,
  fieldSchema: TSchema,
): TableViewCol[] {
  const name = columnDisplayName(fieldCode, fieldSchema);
  const isReadonly = (fieldSchema as Record<string, unknown>)[X_SCRATCH_READONLY] === true;
  const connectorDataType = (fieldSchema as Record<string, unknown>)[X_SCRATCH_CONNECTOR_DATA_TYPE];

  if (HIDDEN_FIELD_CODES_BY_ENTITY[entityType]?.has(fieldCode)) {
    return [{ kind: 'col', path, name, type: 'object', hidden: true, ...(isReadonly ? { readonly: true } : {}) }];
  }

  // `picture_id` is a `Number | {url} | Null` union; pin it to the number branch so the plan
  // never proposes the dead `picture_id.url` subfield column (DEV-11030's unsavable plan).
  if (fieldCode === 'picture_id') {
    return [{ kind: 'col', path, name, type: 'number', ...(isReadonly ? { readonly: true } : {}) }];
  }

  const nonNullFieldSchema = unwrapNullableUnionMember(fieldSchema);

  // Multi-value email/phone arrays (`[{value, label, primary}]`): render and sync the
  // comma-joined values — "a@x.com, b@y.com" — not concatenated JSON fragments (DEV-11035).
  // Guard on the schema actually being an array: a CUSTOM phone field is a bare string (not the
  // system multi-value array), so its `$[*].value` join_comma codec would JSON-parse the string
  // and throw, aborting the entire table's sync (DEV-11042). A non-array phone/email falls through
  // to a plain column below.
  if (
    (connectorDataType === 'email' || connectorDataType === 'phone') &&
    nonNullFieldSchema !== undefined &&
    nonNullFieldSchema.type === 'array'
  ) {
    return [
      {
        kind: 'col',
        path,
        name,
        type: 'string',
        displayTransformer: {
          type: 'jsonpath',
          options: { expression: '$[*].value', arrayHandling: 'join_comma' },
        },
        ...(isReadonly ? { readonly: true } : {}),
      },
    ];
  }

  // Composite objects (monetary/address/daterange/time/timerange): one column per subfield —
  // named "<Field> (<Subfield>)" so sibling composites don't collide on "value" — plus the raw
  // container hidden (DEV-11036). Daterange subfields carry `format: 'date'` → typed 'date'.
  // NB: shape checks read the serialized JSON-Schema `type` keyword, never TypeBox's `Kind`
  // symbol — the view may be rebuilt from a stored (JSON-parsed) schema, where symbols are gone.
  if (
    typeof connectorDataType === 'string' &&
    COMPOSITE_CONNECTOR_DATA_TYPES.has(connectorDataType) &&
    nonNullFieldSchema !== undefined &&
    nonNullFieldSchema.type === 'object'
  ) {
    const subfieldProperties =
      (nonNullFieldSchema as TSchema & { properties?: Record<string, TSchema> }).properties ?? {};
    const subfieldCols: TableViewCol[] = Object.entries(subfieldProperties).map(([subfieldKey, subfieldSchema]) => ({
      kind: 'col',
      path: `${path}.${subfieldKey}`,
      name: `${name} (${titleCaseSnakeCase(subfieldKey)})`,
      type: tablePropertyTypeForFieldSchema(subfieldSchema),
      ...(isReadonly ? { readonly: true } : {}),
    }));
    return [
      ...subfieldCols,
      {
        kind: 'col',
        path,
        name: `${name} (raw)`,
        type: 'object',
        hidden: true,
        ...(isReadonly ? { readonly: true } : {}),
      },
    ];
  }

  // Single-select (enum): the stored value is an option id whose label lives in the schema's
  // option literals — attach a value_map codec so a sync exports the label (DEV-11034).
  const enumOptionIdToLabelMapping = extractOptionIdToLabelMapping(fieldSchema);
  if (enumOptionIdToLabelMapping) {
    return [
      {
        kind: 'col',
        path,
        name,
        type: 'string',
        codec: { toCore: { type: TransformerTypes.ValueMap, options: { mapping: enumOptionIdToLabelMapping } } },
        ...(isReadonly ? { readonly: true } : {}),
      },
    ];
  }

  // Multi-select (set): an ARRAY of option ids — map each element through the same id → label
  // dictionary (the multi→single collapse downstream joins them comma-separated) (DEV-11034).
  if (nonNullFieldSchema !== undefined && nonNullFieldSchema.type === 'array') {
    const arrayItemsSchema = (nonNullFieldSchema as TSchema & { items?: TSchema }).items;
    const setOptionIdToLabelMapping = arrayItemsSchema ? extractOptionIdToLabelMapping(arrayItemsSchema) : null;
    if (setOptionIdToLabelMapping) {
      return [
        {
          kind: 'col',
          path,
          name,
          type: 'string',
          codec: {
            toCore: {
              type: TransformerTypes.MapArray,
              options: {
                elementTransformer: {
                  type: TransformerTypes.ValueMap,
                  options: { mapping: setOptionIdToLabelMapping },
                },
              },
            },
          },
          ...(isReadonly ? { readonly: true } : {}),
        },
      ];
    }

    // A plain scalar array (e.g. `label_ids`): join the elements comma-separated rather than
    // exporting the raw JSON array text.
    if (arrayItemsSchema && (arrayItemsSchema.type === 'string' || arrayItemsSchema.type === 'number')) {
      return [
        {
          kind: 'col',
          path,
          name,
          type: 'string',
          displayTransformer: { type: 'jsonpath', options: { expression: '$[*]', arrayHandling: 'join_comma' } },
          ...(isReadonly ? { readonly: true } : {}),
        },
      ];
    }
  }

  return [
    {
      kind: 'col',
      path,
      name,
      type: tablePropertyTypeForFieldSchema(fieldSchema),
      ...(isReadonly ? { readonly: true } : {}),
    },
  ];
}

/**
 * The id → label dictionary of an enum/set option union — the schema builds
 * `Type.Literal(opt.id, { title: opt.label })` per option, plus an untitled base-scalar member
 * (the open-union escape hatch) and possibly `Null`. Only TITLED const members count as options;
 * that guard keeps non-option literal unions (the empty-date sentinels `'0000-00-00'` /
 * `'-0001-11-30'`, which carry no title) from being mistaken for a select. Returns null when the
 * union carries no titled option literal.
 */
function extractOptionIdToLabelMapping(schema: TSchema): Record<string, string> | null {
  const unionMembers = (schema as TSchema & { anyOf?: TSchema[] }).anyOf;
  if (!unionMembers) return null;
  const optionIdToLabelMapping: Record<string, string> = {};
  let titledOptionLiteralCount = 0;
  for (const member of unionMembers) {
    const optionId = (member as TSchema & { const?: unknown }).const;
    const optionLabel = (member as TSchema & { title?: unknown }).title;
    if ((typeof optionId !== 'string' && typeof optionId !== 'number') || typeof optionLabel !== 'string') continue;
    titledOptionLiteralCount++;
    optionIdToLabelMapping[String(optionId)] = optionLabel;
  }
  return titledOptionLiteralCount > 0 ? optionIdToLabelMapping : null;
}

/**
 * Map a built field schema (usually `Union([X, Null])`) to a column type hint. `format: 'date'` /
 * `'date-time'` both map to `'date'` — the plan generator recovers time-of-day from the schema
 * `format` itself (`includesTime`), so the view never needs a separate datetime type (DEV-11033).
 */
function tablePropertyTypeForFieldSchema(schema: TSchema | undefined): TablePropertyType {
  const nonNullSchema = unwrapNullableUnionMember(schema);
  if (!nonNullSchema) return 'string';
  const format = (nonNullSchema as TSchema & { format?: string }).format;
  if (format === 'date' || format === 'date-time') return 'date';
  if (format === 'uri') return 'url';
  switch (nonNullSchema.type) {
    case 'boolean':
      return 'checkbox';
    case 'number':
    case 'integer':
      return 'number';
    case 'array':
    case 'object':
      return 'object';
    default:
      return 'string';
  }
}

/** Unwrap a `Union([X, …, Null])` (or plain schema) to the first non-null member. */
function unwrapNullableUnionMember(schema: TSchema | undefined): TSchema | undefined {
  if (!schema) return undefined;
  const unionMembers = (schema as TSchema & { anyOf?: TSchema[] }).anyOf;
  if (unionMembers) return unionMembers.find((member) => member.type !== 'null') ?? schema;
  return schema;
}

/**
 * A column's display name: the schema `description` carries the human field name for
 * dynamically-discovered fields ("Expected close date"); static-schema fields set
 * `description === fieldCode`, so those title-case the snake_case code instead.
 */
function columnDisplayName(fieldCode: string, fieldSchema: TSchema): string {
  const description = (fieldSchema as TSchema & { description?: string }).description;
  if (typeof description === 'string' && description.length > 0 && description !== fieldCode) return description;
  return titleCaseSnakeCase(fieldCode);
}

/** `expected_close_date` → `Expected Close Date`. */
function titleCaseSnakeCase(key: string): string {
  return key
    .split('_')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Pipedrive v1 custom-field hash keys (leads carry them flat at the record's top level). */
function isFlatCustomFieldCode(fieldCode: string): boolean {
  return /^[0-9a-f]{40}$/.test(fieldCode);
}

/** Reorder so the title column leads and the record id follows it; everything else keeps schema order. */
function orderColumnsTitleThenIdFirst(
  cols: TableViewCol[],
  titlePath: string | undefined,
  idPath: string | undefined,
): TableViewCol[] {
  const titleCols = cols.filter((col) => col.path === titlePath);
  const idCols = cols.filter((col) => col.path === idPath);
  const remainingCols = cols.filter((col) => col.path !== titlePath && col.path !== idPath);
  return [...titleCols, ...idCols, ...remainingCols];
}
