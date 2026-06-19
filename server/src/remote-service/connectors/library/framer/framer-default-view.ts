import { type TablePropertyType, type TableView, type TableViewCol } from '@spinner/shared-types';
import { FramerCollectionMeta, FramerFieldType, NON_DATA_FRAMER_FIELD_TYPES } from './framer-types';

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
 * Build the default grid view for a Framer collection. Each CMS field becomes a
 * column pointed at its editable leaf (`fieldData.<id>.value`) with the field's
 * display name. The item-meta columns (slug, draft) lead; the read-only ids
 * trail. The view stays flat — Framer's fields are the primary content, with no
 * pre-existing structural sub-grouping to mirror, so no banner groups are added.
 */
export function buildFramerDefaultView(collection: FramerCollectionMeta): TableView {
  const cols: TableViewCol[] = [
    { kind: 'col', path: 'slug', name: 'Slug', type: 'string' },
    { kind: 'col', path: 'draft', name: 'Draft', type: 'checkbox' },
  ];

  for (const field of collection.fields) {
    if (NON_DATA_FRAMER_FIELD_TYPES.has(field.type)) continue;
    cols.push({
      kind: 'col',
      path: `fieldData.${field.id}.value`,
      name: field.name,
      type: FRAMER_TYPE_TO_COLUMN_TYPE[field.type],
    });
  }

  cols.push({ kind: 'col', path: 'id', name: 'Id', type: 'string', readonly: true });

  return { name: 'Default', cols };
}
