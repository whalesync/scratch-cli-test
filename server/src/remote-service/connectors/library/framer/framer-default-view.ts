import type { TSchema } from '@sinclair/typebox';
import {
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  type TablePropertyType,
  type TableView,
  type TableViewCol,
} from '@spinner/shared-types';
import type { BaseJsonTableSpec } from '../../types';
import { FramerFieldType } from './framer-types';

/** Map a Framer field type to the grid's column-type hint. */
const FRAMER_TYPE_TO_COLUMN_TYPE: Record<string, TablePropertyType> = {
  [FramerFieldType.String]: 'string',
  [FramerFieldType.FormattedText]: 'richtext',
  [FramerFieldType.Number]: 'number',
  [FramerFieldType.Boolean]: 'checkbox',
  [FramerFieldType.Date]: 'date',
  [FramerFieldType.Link]: 'url',
  [FramerFieldType.Enum]: 'string',
  [FramerFieldType.Color]: 'string',
  [FramerFieldType.Image]: 'object',
  [FramerFieldType.File]: 'object',
  [FramerFieldType.CollectionReference]: 'string',
  [FramerFieldType.MultiCollectionReference]: 'object',
  [FramerFieldType.Array]: 'object',
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
    cols.push({
      kind: 'col',
      path: `fieldData.${fieldId}.value`,
      name,
      // Deliberately do NOT propagate x-scratch-readonly here: today's view leaves
      // even the `unsupported` field's column editable — only `id` is read-only.
      type: framerFieldType ? FRAMER_TYPE_TO_COLUMN_TYPE[framerFieldType] : undefined,
    });
  }

  cols.push({ kind: 'col', path: 'id', name: 'Id', type: 'string', readonly: true });

  return { name: 'Default', cols };
}
