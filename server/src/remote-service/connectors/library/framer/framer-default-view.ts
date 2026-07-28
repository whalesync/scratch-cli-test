import type { TSchema } from '@sinclair/typebox';
import {
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  type TablePropertyType,
  type TableView,
  type TableViewCol,
} from '@spinner/shared-types';
import type { BaseJsonTableSpec } from '../../types';
import { FramerFieldType } from './framer-types';

/**
 * JSONPath from an image/file field's stored asset object (`{ id, url, thumbnailUrl, … }`)
 * to the one value that is useful anywhere else — the asset's URL. It is also exactly what
 * the connector sends back on write, so display and publish agree on what the field "is".
 */
const FRAMER_ASSET_URL_EXPRESSION = '$.url';

/**
 * JSONPath from an `array` (gallery) field's stored sub-item list to each sub-item's asset
 * URL. A sub-item is a mini record — `{ id, fieldData: { <subFieldId>: { type, value } } }` —
 * keyed by an internal sub-field id we can't know ahead of time, so the sub-field is matched
 * with a wildcard. Framer's array sub-items are image-only today, so every match is an asset.
 */
const FRAMER_ARRAY_ITEM_ASSET_URLS_EXPRESSION = '$[*].fieldData.*.value.url';

/**
 * Map a Framer field type to the grid's column-type hint.
 *
 * The asset (`image`/`file`) and `array` types render as `'string'` rather than their raw
 * `'object'` shape because they carry a {@link FRAMER_TYPE_TO_DISPLAY_TRANSFORMER} entry, and
 * the grid's text cell is the only cell kind that consults a `displayTransformer` — a `'url'`
 * or `'object'` hint would route to a cell that draws the raw JSON blob and ignore the
 * transformer entirely.
 */
const FRAMER_TYPE_TO_COLUMN_TYPE: Record<string, TablePropertyType> = {
  [FramerFieldType.String]: 'string',
  [FramerFieldType.FormattedText]: 'richtext',
  [FramerFieldType.Number]: 'number',
  [FramerFieldType.Boolean]: 'checkbox',
  [FramerFieldType.Date]: 'date',
  [FramerFieldType.Link]: 'url',
  [FramerFieldType.Enum]: 'string',
  [FramerFieldType.Color]: 'string',
  [FramerFieldType.Image]: 'string',
  [FramerFieldType.File]: 'string',
  [FramerFieldType.CollectionReference]: 'string',
  [FramerFieldType.MultiCollectionReference]: 'object',
  [FramerFieldType.Array]: 'string',
};

/**
 * Declarative flatteners for the field types whose stored value is a structure rather than a
 * scalar. The record on disk stays verbatim; this only says how to READ the interesting value
 * out of it — and the sync layer reuses the same instruction as the column's export extract,
 * so a Live Export ships the asset URL instead of the raw JSON blob (DEV-11087, DEV-11088).
 *
 * `array` joins its URLs with ", " rather than keeping the list, because there is no
 * multi-valued column type in the create-schema plan: keeping it a list would make a
 * single-valued destination slot (a Notion `url` property) drop everything after the first
 * element, whereas the joined string carries every URL to every destination.
 */
const FRAMER_TYPE_TO_DISPLAY_TRANSFORMER: Record<string, NonNullable<TableViewCol['displayTransformer']>> = {
  [FramerFieldType.Image]: {
    type: 'jsonpath',
    options: { expression: FRAMER_ASSET_URL_EXPRESSION, arrayHandling: 'first' },
  },
  [FramerFieldType.File]: {
    type: 'jsonpath',
    options: { expression: FRAMER_ASSET_URL_EXPRESSION, arrayHandling: 'first' },
  },
  [FramerFieldType.Array]: {
    type: 'jsonpath',
    options: { expression: FRAMER_ARRAY_ITEM_ASSET_URLS_EXPRESSION, arrayHandling: 'join_comma' },
  },
};

/**
 * The column's SEMANTIC type for sync / Live Export, where it differs from the render type
 * forced to `'string'` above. A flattened image/file column really holds a URL, so the
 * destination field should be created as a URL column, not plain text. The joined `array`
 * column is genuinely a string (many URLs in one value), so it declares nothing here.
 */
const FRAMER_TYPE_TO_EXPORT_LOGICAL_TYPE: Record<string, TablePropertyType> = {
  [FramerFieldType.Image]: 'url',
  [FramerFieldType.File]: 'url',
};

/**
 * Build the default grid view for a Framer collection — a PURE function of the
 * spec. Each CMS field becomes a column pointed at its editable leaf
 * (`fieldData.<id>.value`) with the field's display name. The item-meta columns
 * (slug, draft) lead; the read-only id trails. The view stays flat — Framer's
 * fields are the primary content, with no pre-existing structural sub-grouping
 * to mirror, so no banner groups are added.
 *
 * Reads the per-field id/name/type off `schema.properties.fieldData.properties`
 * (keyed by field id, in collection order, with non-data fields like dividers
 * already excluded at schema-gen time) instead of the raw collection metadata.
 */
export function buildFramerDefaultView(spec: BaseJsonTableSpec): TableView {
  const cols: TableViewCol[] = [
    { kind: 'col', path: 'slug', name: 'Slug', type: 'string' },
    { kind: 'col', path: 'draft', name: 'Draft', type: 'checkbox' },
  ];

  const schemaProperties = (spec.schema as TSchema & { properties?: Record<string, TSchema> }).properties ?? {};
  const fieldDataSchema = schemaProperties.fieldData as
    | (TSchema & { properties?: Record<string, TSchema> })
    | undefined;
  // Field ids are non-integer strings (e.g. `fTitle`), so Object.keys preserves the
  // schema's insertion order — which mirrors the collection's field order.
  const fieldDataProperties = fieldDataSchema?.properties ?? {};

  for (const [fieldId, entrySchema] of Object.entries(fieldDataProperties)) {
    const entry = entrySchema as TSchema & { title?: string; properties?: { value?: TSchema } };
    const valueNode = entry.properties?.value;
    const framerFieldType = valueNode?.[X_SCRATCH_CONNECTOR_DATA_TYPE] as string | undefined;
    // The field's display name is stored as the entry object's `title` (and mirrored
    // as the value node's `description`) — both equal the original field.name.
    const name = entry.title ?? valueNode?.description;
    const col: TableViewCol = {
      kind: 'col',
      path: `fieldData.${fieldId}.value`,
      name,
      // Deliberately do NOT propagate x-scratch-readonly here: today's view leaves
      // even the `unsupported` field's column editable — only `id` is read-only.
      type: framerFieldType ? FRAMER_TYPE_TO_COLUMN_TYPE[framerFieldType] : undefined,
    };

    const displayTransformer = framerFieldType ? FRAMER_TYPE_TO_DISPLAY_TRANSFORMER[framerFieldType] : undefined;
    if (displayTransformer) {
      col.displayTransformer = displayTransformer;
      const exportLogicalType = framerFieldType ? FRAMER_TYPE_TO_EXPORT_LOGICAL_TYPE[framerFieldType] : undefined;
      // Only worth declaring when it actually differs from the (text) render type.
      if (exportLogicalType && exportLogicalType !== col.type) col.logicalType = exportLogicalType;
    }

    cols.push(col);
  }

  cols.push({ kind: 'col', path: 'id', name: 'Id', type: 'string', readonly: true });

  return { name: 'Default', cols };
}
