import { Kind, TSchema } from '@sinclair/typebox';
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
  X_SCRATCH_WRITE_ONCE,
} from '@spinner/shared-types';
import { BaseJsonTableSpec } from '../../types';

/**
 * Default view for a Sanity document-type table.
 *
 * Sanity types are user-defined and the Content Lake is schemaless, so there is no
 * per-entity editorializing to do — the view is derived from what the schema builder
 * inferred, using the structure Sanity itself gives us:
 *   - the title field leads, then `slug` (collapsed to its `current` leaf);
 *   - remaining user fields follow in schema order, typed from the inferred schema.
 *     When the project deployed its Studio schema, the schema builder has already
 *     reordered the properties to the AUTHORED field order and stamped declared
 *     titles on the `title` keyword — so column order and naming inherit both here
 *     (declared title first, humanized field name as the fallback);
 *   - Portable Text fields render a plain-text preview via the generic jsonpath
 *     display transformer (blocks → children spans → text) and stay read-only in the
 *     grid — the flattened preview can't round-trip an edit;
 *   - reference fields collapse to their `_ref` id leaf;
 *   - plain user-defined objects (no `_type` marker) expand into a banner group of
 *     dotted-path child columns (`seo` → "Seo" with Meta Title / Meta Description) —
 *     real structure from the user's content model, per the banner-group rule;
 *   - the `_id`/`_type`/`_rev`/`_createdAt`/`_updatedAt` system fields sit last,
 *     hidden by default (toggleable).
 */
export function buildSanityDefaultView(spec: BaseJsonTableSpec): TableView {
  const schemaProperties: Record<string, TSchema> =
    (spec.schema as TSchema & { properties?: Record<string, TSchema> }).properties ?? {};

  const titleFieldName = spec.titlePath && spec.titlePath in schemaProperties ? spec.titlePath : undefined;
  const systemFieldNames = ['_id', '_type', '_rev', '_createdAt', '_updatedAt'];

  const orderedFieldNames: string[] = [];
  if (titleFieldName) orderedFieldNames.push(titleFieldName);
  if ('slug' in schemaProperties) orderedFieldNames.push('slug');
  for (const fieldName of Object.keys(schemaProperties)) {
    if (fieldName === titleFieldName || fieldName === 'slug' || systemFieldNames.includes(fieldName)) continue;
    orderedFieldNames.push(fieldName);
  }
  for (const systemFieldName of systemFieldNames) {
    if (systemFieldName in schemaProperties) orderedFieldNames.push(systemFieldName);
  }

  const cols = orderedFieldNames.map((fieldName) => {
    const fieldSchema = schemaProperties[fieldName];
    // A plain user-defined object (no `_type` marker — Sanity's typed values like
    // slug/reference/geopoint all carry one) is real structure the user created in
    // their content model: expand its sub-fields into dotted-path columns under a
    // banner group named after the field (e.g. `seo` → "Seo" with Meta Title /
    // Meta Description), mirroring how Studio presents object fields.
    if (isPlainUserObjectField(fieldName, fieldSchema, systemFieldNames)) {
      return buildBannerGroupForObjectField(fieldName, fieldSchema);
    }
    return buildSanityViewCol(fieldName, fieldSchema, { hidden: systemFieldNames.includes(fieldName) });
  });

  return { name: 'Default', cols };
}

function isPlainUserObjectField(fieldName: string, fieldSchema: TSchema, systemFieldNames: string[]): boolean {
  if (systemFieldNames.includes(fieldName) || fieldName === 'slug') return false;
  if ((fieldSchema?.[Kind] as string | undefined) !== 'Object') return false;
  const subProperties = fieldSchema.properties as Record<string, TSchema> | undefined;
  if (!subProperties || Object.keys(subProperties).length === 0) return false;
  return !('_type' in subProperties) && !('_ref' in subProperties);
}

function buildBannerGroupForObjectField(fieldName: string, fieldSchema: TSchema): TableViewBannerGroup {
  const subProperties = (fieldSchema.properties ?? {}) as Record<string, TSchema>;
  const childCols: TableViewCol[] = Object.keys(subProperties).map((subFieldName) => ({
    kind: 'col',
    path: `${fieldName}.${subFieldName}`,
    name: resolveColumnDisplayName(subFieldName, subProperties[subFieldName]),
    type: mapFieldType(subProperties[subFieldName]),
  }));
  return { kind: 'banner-group', name: resolveColumnDisplayName(fieldName, fieldSchema), cols: childCols };
}

function buildSanityViewCol(fieldName: string, fieldSchema: TSchema, opts: { hidden: boolean }): TableViewCol {
  const col: TableViewCol = {
    kind: 'col',
    path: fieldName,
    name: resolveColumnDisplayName(fieldName, fieldSchema),
    type: mapFieldType(fieldSchema),
  };
  if (opts.hidden) col.hidden = true;
  if (fieldSchema?.[X_SCRATCH_READONLY] === true) col.readonly = true;
  if (fieldSchema?.[X_SCRATCH_WRITE_ONCE] === true) col.writeOnce = true;

  if (fieldSchema?.[X_SCRATCH_CONNECTOR_DATA_TYPE] === 'datetime') {
    // The inferred TypeBox schema carries no `format` (a guessed format would be
    // enforced by validation) — the sample-detected annotation is the date signal.
    // `logicalType: 'datetime'` tells the Live Export plan the value is TIME-BEARING,
    // so destinations create a real datetime column (Airtable `dateTime`, Postgres
    // `timestamptz`) instead of a date-only one that drops the time-of-day for the
    // life of the export (found by the Live Export audit: `publishedAt`
    // "2026-06-15T12:34:56.789Z" landed in Airtable as "2026-06-15"). The generic
    // time-bearing signal is a JSON-Schema `format` this schema deliberately omits,
    // so the view declares it directly — the Stripe epoch-column precedent.
    col.type = 'date';
    col.logicalType = 'datetime';
    return col;
  }

  if (fieldSchema?.[X_SCRATCH_CONNECTOR_DATA_TYPE] === 'date') {
    // Sanity `date` fields are calendar dates ("2026-06-15") — a date column WITHOUT
    // the time-bearing logicalType, so destinations correctly create date-only columns.
    col.type = 'date';
    return col;
  }

  if (fieldSchema?.[X_SCRATCH_CONNECTOR_DATA_TYPE] === 'portableText') {
    // Render through the text cell (only it consults displayTransformer); the value's
    // real nature for export purposes is rich text. Read-only: a flattened preview
    // cannot round-trip an edit into the block structure.
    col.type = 'string';
    col.logicalType = 'richtext';
    col.readonly = true;
    col.displayTransformer = {
      type: 'jsonpath',
      options: { expression: '$[*].children[*].text', arrayHandling: 'join_matches_space' },
    };
    return col;
  }

  const subProperties = fieldSchema?.properties as Record<string, TSchema> | undefined;
  if (fieldName === 'slug' && subProperties && 'current' in subProperties) {
    col.subfields = [{ name: 'Current', relativePath: 'current', type: 'string' }];
    col.selectedSubfield = 0;
    return col;
  }
  if (subProperties && '_ref' in subProperties) {
    // A Sanity reference `{_type:'reference', _ref}` — show the referenced id leaf, and
    // carry the FK (annotated on the `_ref` leaf, BELOW this column's path — the view is
    // where consumers recover it).
    col.subfields = [{ name: 'Ref', relativePath: '_ref', type: 'string' }];
    col.selectedSubfield = 0;
    copyForeignKeyOntoCol(col, subProperties['_ref']);
    return col;
  }
  const arrayMemberProperties = (fieldSchema?.items as TSchema | undefined)?.properties as
    | Record<string, TSchema>
    | undefined;
  if (arrayMemberProperties && '_ref' in arrayMemberProperties) {
    // An array of references — the FK sits on the members' `_ref` leaf. The sync FK
    // phase expects the column's CORE value to be an array of id scalars, so the codec
    // extracts `_ref` from each `{_type:'reference', _ref, _key}` envelope (Affinity's
    // reference-column pattern); the grid shows the joined ids. The stored array on
    // disk stays verbatim.
    copyForeignKeyOntoCol(col, arrayMemberProperties['_ref']);
    col.type = 'string';
    col.displayTransformer = { type: 'jsonpath', options: { expression: '$[*]._ref', arrayHandling: 'join_comma' } };
    col.codec = {
      toCore: { type: TransformerTypes.JSONPath, options: { expression: '$[*]._ref', arrayHandling: 'array' } },
    };
    return col;
  }

  return col;
}

function copyForeignKeyOntoCol(col: TableViewCol, refLeafSchema: TSchema): void {
  const foreignKeyOptions = refLeafSchema?.[X_SCRATCH_FOREIGN_KEY_OPTIONS] as ForeignKeyOptionSchema | undefined;
  if (foreignKeyOptions) {
    col.foreignKey = {
      linkedTableId: foreignKeyOptions.linkedTableId,
      linkedTableRemoteId: foreignKeyOptions.linkedTableRemoteId,
      isSingleValued: foreignKeyOptions.isSingleValued,
    };
  }
}

/**
 * The column name: the deployed Studio schema's declared title when the schema builder
 * stamped one on the field schema (`title` keyword), otherwise the humanized field name.
 * (Sanity omits declared titles that equal its own humanization from the deployed
 * payload, so the fallback frequently IS the authored title.)
 */
function resolveColumnDisplayName(fieldName: string, fieldSchema: TSchema | undefined): string {
  const declaredTitle = (fieldSchema as (TSchema & { title?: unknown }) | undefined)?.title;
  if (typeof declaredTitle === 'string' && declaredTitle.length > 0) return declaredTitle;
  return formatFieldNameForDisplay(fieldName);
}

/** `wordCount` → "Word Count", `meta_title` → "Meta Title", `_updatedAt` → "Updated At". */
function formatFieldNameForDisplay(fieldName: string): string {
  return fieldName
    .replace(/^_/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function mapFieldType(fieldSchema: TSchema | undefined): TablePropertyType | undefined {
  if (!fieldSchema) return undefined;

  const format = resolveFormat(fieldSchema);
  if (format === 'date-time') return 'date';
  if (format === 'uri') return 'url';

  const kind = fieldSchema[Kind] as string | undefined;
  if (kind === 'Boolean') return 'checkbox';
  if (kind === 'Number' || kind === 'Integer') return 'number';
  if (kind === 'Array' || kind === 'Object') return 'object';
  if (kind === 'String') return 'string';

  if (kind === 'Union') {
    const unionMembers = (fieldSchema as TSchema & { anyOf?: TSchema[] }).anyOf;
    const firstNonNullMember = unionMembers?.find((member) => member[Kind] !== 'Null');
    if (firstNonNullMember) return mapFieldType(firstNonNullMember);
    return 'object';
  }

  return undefined;
}

function resolveFormat(schema: TSchema): string | undefined {
  const directFormat = (schema as TSchema & { format?: string }).format;
  if (directFormat) return directFormat;
  const unionMembers = (schema as TSchema & { anyOf?: TSchema[] }).anyOf;
  if (unionMembers) {
    for (const member of unionMembers) {
      const memberFormat = (member as TSchema & { format?: string }).format;
      if (memberFormat) return memberFormat;
    }
  }
  return undefined;
}
