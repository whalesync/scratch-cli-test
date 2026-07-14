import { TSchema, Type } from '@sinclair/typebox';
import { ValuePointer } from '@sinclair/typebox/value';
import {
  AssetTableOptions,
  ForeignKeyOptionSchema,
  X_SCRATCH_ASSET_TABLE,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_LAST_MODIFIED_FIELD,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { isArray } from 'lodash';
import { BaseJsonTableSpec, DotPath, EntityId, dotPath } from '../../types';
import { escapePointerToken } from '../../utils/json-pointer';
import { WORDPRESS_MODIFIED_COLUMN_ID, WORDPRESS_STATUS_COLUMN_ID } from './wordpress-constants';
import { WordPressArgument, WordPressDataType, WordPressEndpointOptionsResponse } from './wordpress-types';

/**
 * Resolve the WordPress data type for a field, following the same logic
 * as parseTypeFromArgument in wordpress-schema-parser.ts.
 */
function resolveWordPressDataType(
  fieldId: string,
  field: WordPressArgument,
  isAcf: boolean,
  foreignKeyColumnIds: { remoteColumnId: string; foreignKeyRemoteTableId: string }[],
): WordPressDataType {
  if (field.type === undefined) {
    return WordPressDataType.UNKNOWN;
  }
  if (field.enum !== undefined) {
    return WordPressDataType.ENUM;
  }

  let type = field.type;
  if (isArray(type)) {
    if (type.includes('array')) {
      type = 'array';
    } else if (type.includes('object')) {
      type = 'object';
    } else {
      const nonNullType = type.find((t) => t !== 'null');
      type = nonNullType ?? 'string';
    }
  }

  // Check for rendered object
  if (field.properties?.rendered !== undefined) {
    if (fieldId === 'title') {
      return WordPressDataType.RENDERED_INLINE;
    }
    return WordPressDataType.RENDERED;
  }

  // Check for foreign keys (non-ACF only)
  if (!isAcf && foreignKeyColumnIds.find((fk) => fk.remoteColumnId === fieldId) !== undefined) {
    return WordPressDataType.FOREIGN_KEY;
  }

  switch (type) {
    case 'string':
      if (field.format === undefined) {
        return WordPressDataType.STRING;
      }
      switch (field.format) {
        case 'email':
          return WordPressDataType.EMAIL;
        case 'uri':
          return WordPressDataType.URI;
        case 'date':
          return WordPressDataType.DATE;
        case 'date-time':
          return WordPressDataType.DATETIME;
        default:
          return WordPressDataType.STRING;
      }
    case 'array':
      return WordPressDataType.ARRAY;
    case 'integer':
      return WordPressDataType.INTEGER;
    case 'number':
      return WordPressDataType.NUMBER;
    case 'boolean':
      return WordPressDataType.BOOLEAN;
    case 'object':
      return WordPressDataType.OBJECT;
    default:
      return WordPressDataType.UNKNOWN;
  }
}

/**
 * PHP serializes an empty associative array as JSON `[]`, not `{}`. WordPress
 * therefore returns object-typed fields (notably `meta` and `acf`) as `[]` when
 * they have no entries. Accept that empty-array shape alongside the object so
 * verbatim records don't trip the enforce-schema validator.
 *
 * Only an EMPTY array is tolerated (`maxItems: 0`): a populated associative array
 * always serializes back to a JSON object, so a non-empty array in an object slot
 * is genuinely malformed and should still surface as a validation error.
 */
function wordpressObjectSchemaThatMayBeEmptyArray(objectSchema: TSchema): TSchema {
  return Type.Union([objectSchema, Type.Array(Type.Unknown(), { maxItems: 0 })]);
}

/** True when `schema` is a TypeBox union (it carries an `anyOf` member array). */
function isUnionSchema(schema: TSchema): schema is TSchema & { anyOf: TSchema[] } {
  return isArray((schema as { anyOf?: unknown }).anyOf);
}

/**
 * Build a TypeBox schema for a single (non-null) WordPress JSON type. Factored out
 * of `wordpressFieldToJsonSchema` so a field that declares multiple non-null types
 * (e.g. `["integer","array"]`) can union the per-type schemas.
 */
function buildSingleWordPressTypeSchema(
  jsonType: string,
  field: WordPressArgument,
  isAcf: boolean,
  foreignKeyColumnIds: { remoteColumnId: string; foreignKeyRemoteTableId: string }[],
  description: string | undefined,
): TSchema {
  switch (jsonType) {
    case 'integer':
      return Type.Integer({ description });

    case 'number':
      return Type.Number({ description });

    case 'boolean':
      return Type.Boolean({ description });

    case 'string':
      // We never assert a string `format`. WordPress's string serialization isn't
      // guaranteed to satisfy the strict RFC checks the validator runs with formats
      // on: date-times come back in the site's local timezone with no UTC offset
      // (e.g. "2026-05-07T04:49:29", not valid RFC 3339), and URLs can contain
      // unencoded Unicode in the filename (e.g. an emoji/CJK media `source_url`,
      // not a valid RFC 3986 URI). Asserting `format` would reject those verbatim
      // values. Columns still render correctly via the x-scratch-connector-data-type
      // annotation (date/url/email), so dropping the format keyword is display-safe.
      return Type.String({ description });

    case 'array':
      return Type.Array(Type.Unknown(), { description });

    case 'object':
      if (field.properties) {
        const objectProperties: Record<string, TSchema> = {};
        for (const [propId, propDef] of Object.entries(field.properties)) {
          if (propDef) {
            objectProperties[propId] = wordpressFieldToJsonSchema(propId, propDef, isAcf, foreignKeyColumnIds);
          }
        }
        return wordpressObjectSchemaThatMayBeEmptyArray(Type.Object(objectProperties, { description }));
      }
      return wordpressObjectSchemaThatMayBeEmptyArray(Type.Record(Type.String(), Type.Unknown(), { description }));

    default:
      return Type.Unknown({ description });
  }
}

/**
 * Convert a WordPress field argument to a TypeBox JSON Schema.
 * Annotates the schema with x-scratch metadata (readonly, foreign key, connector data type).
 *
 * Records are stored verbatim, so the schema is built to accept exactly what
 * WordPress returns rather than what its OPTIONS metadata claims:
 * - Every field is made nullable. WordPress returns `null` for unset values and its
 *   OPTIONS under-declares this (e.g. media `post` is typed `integer` but is `null`
 *   for unattached files), so we don't trust the declared (non-)nullability.
 * - A field that declares several non-null types (e.g. `["integer","array","null"]`)
 *   is unioned so each declared shape validates.
 * - Enum fields become plain strings (their declared values aren't exhaustive), and
 *   string `format`s are dropped (see `buildSingleWordPressTypeSchema`).
 */
export function wordpressFieldToJsonSchema(
  fieldId: string,
  field: WordPressArgument,
  isAcf: boolean,
  foreignKeyColumnIds: { remoteColumnId: string; foreignKeyRemoteTableId: string }[],
): TSchema {
  const description = fieldId;
  const dataType = resolveWordPressDataType(fieldId, field, isAcf, foreignKeyColumnIds);

  // Handle rendered objects (title, content, excerpt, etc.). These always come
  // back as a populated `{ raw, rendered }` object, so they stay a plain object
  // (kept un-annotated and un-wrapped so the default-view rendered-object detection
  // — which keys off `.properties.raw`/`.properties.rendered` — keeps working).
  if (field.properties?.rendered) {
    const topObjectSchema = Type.Object(
      {
        raw: Type.String({
          title: fieldId,
          // description: `${fieldId} (raw)`,
          [X_SCRATCH_READONLY]: field.readonly === true ? true : undefined,
        }),
        rendered: Type.String({
          title: `${fieldId}.rendered`,
          description: 'Display-ready HTML. Edit "raw" to modify this.',
          contentMediaType: 'text/html',
          [X_SCRATCH_READONLY]: true,
        }),
        protected: Type.Optional(
          Type.Boolean({
            title: `${fieldId}.protected`,
            description: 'Whether this field is password protected',
          }),
        ),
      },
      { description },
    );

    // schema[CONNECTOR_DATA_TYPE] = dataType;

    return topObjectSchema;
  }

  const declaredJsonTypes = isArray(field.type) ? field.type : field.type === undefined ? [] : [field.type];
  const nonNullJsonTypes = declaredJsonTypes.filter((jsonType) => jsonType !== 'null');

  // Build the base schema from the declared non-null type(s).
  let baseSchema: TSchema;
  let baseAlreadyAcceptsNull = false;
  if (field.enum && field.enum.length > 0) {
    // WordPress enums (status/format/comment_status/…) are advisory and NOT
    // exhaustive: attachments use status "inherit", which the media endpoint's
    // declared enum omits, and plugins add custom statuses/formats. Emit a plain
    // string so verbatim values never fail validation; the ENUM connector-data-type
    // annotation set below still records the enum-ness for the UI.
    baseSchema = Type.String({ description });
  } else if (nonNullJsonTypes.length === 0) {
    // Type is absent (or only `"null"`) — accept anything (this also covers null).
    baseSchema = Type.Unknown({ description });
    baseAlreadyAcceptsNull = true;
  } else if (nonNullJsonTypes.length === 1) {
    baseSchema = buildSingleWordPressTypeSchema(nonNullJsonTypes[0], field, isAcf, foreignKeyColumnIds, description);
  } else {
    // Several non-null types (e.g. ["integer","array"]) — union them so each
    // declared shape validates. The description sits on the union root below.
    baseSchema = Type.Union(
      nonNullJsonTypes.map((jsonType) =>
        buildSingleWordPressTypeSchema(jsonType, field, isAcf, foreignKeyColumnIds, undefined),
      ),
      { description },
    );
  }

  // Make every field nullable. WordPress returns `null` for unset values and its
  // OPTIONS under-declares this (e.g. media `post` is typed `integer` but comes back
  // `null`), so — since records are verbatim — accept `null` regardless of the
  // declared type rather than trusting it. Reuse an existing union's members so the
  // result stays a flat `anyOf` instead of a nested one.
  //
  // ACF additionally uses the empty string `""` — not `null` — as its unset sentinel: an
  // empty ACF number field (e.g. `price`, `rating`) comes back as `""`, which a
  // `number`-typed schema rejects. Since records are verbatim, accept that blank too for
  // ACF fields (mirrors the nullability rationale). This blank can't be cleared by the
  // validator's top-level empty-string skip: it sits inside the `acf` object, which is
  // wrapped in an anyOf for the `acf: []` quirk, so the failure is reported against the
  // whole object, not the `""` — allowing it here is what clears the false positive.
  // Harmless for ACF text fields, which already accept "".
  const blankStringSentinelMembers: TSchema[] = isAcf ? [Type.Literal('')] : [];
  let schema: TSchema;
  if (baseAlreadyAcceptsNull) {
    schema = baseSchema;
  } else if (isUnionSchema(baseSchema)) {
    schema = Type.Union([...baseSchema.anyOf, Type.Null(), ...blankStringSentinelMembers], { description });
  } else {
    schema = Type.Union([baseSchema, Type.Null(), ...blankStringSentinelMembers], { description });
  }

  // Set foreign key metadata for known FK fields (non-ACF only). All x-scratch
  // annotations must land on the OUTERMOST schema (the union root when wrapped
  // above) because the default-view builder and the `isReadonlyField`/`isForeignKey`
  // ValuePointer helpers read them off the property root.
  if (!isAcf) {
    const fkDef = foreignKeyColumnIds.find((fk) => fk.remoteColumnId === fieldId);
    if (fkDef) {
      schema[X_SCRATCH_FOREIGN_KEY_OPTIONS] = { linkedTableId: fkDef.foreignKeyRemoteTableId };
    }
  }

  schema[X_SCRATCH_CONNECTOR_DATA_TYPE] = dataType;
  schema[X_SCRATCH_READONLY] = field.readonly === true ? true : undefined;
  return schema;
}

/**
 * Build a BaseJsonTableSpec from a WordPress endpoint OPTIONS response.
 * Generates a JSON Schema describing the raw WordPress record format with rendered objects.
 */
export function buildWordPressJsonTableSpec(
  id: EntityId,
  optionsResponse: WordPressEndpointOptionsResponse,
  foreignKeyColumnIds: { remoteColumnId: string; foreignKeyRemoteTableId: string }[],
): BaseJsonTableSpec {
  const [tableId] = id.remoteId;

  const properties: Record<string, TSchema> = {};
  let titlePath: DotPath | undefined;
  let mainContentPath: DotPath | undefined;

  // Get schema properties from the endpoint OPTIONS response
  const schemaProps = optionsResponse.schema?.properties || {};

  // Detect post type: if status field exists with enum values, this is a post type
  const statusField = schemaProps.status;
  const isPostType = statusField?.enum !== undefined && statusField.enum.length > 0;

  for (const [fieldId, fieldDef] of Object.entries(schemaProps)) {
    if (!fieldDef || !('type' in fieldDef)) continue;

    // Skip dynamic status field for post types — it will be injected as a static field below
    if (isPostType && fieldId === WORDPRESS_STATUS_COLUMN_ID) continue;

    const fieldSchema = wordpressFieldToJsonSchema(fieldId, fieldDef, false, foreignKeyColumnIds);

    // Check if field is required
    if (fieldDef.required) {
      properties[fieldId] = fieldSchema;
    } else {
      properties[fieldId] = Type.Optional(fieldSchema);
    }

    // Track title column
    if (fieldId === 'title') {
      titlePath = dotPath('title.raw');
    }

    // Track main content column
    if (fieldId === 'content' && !mainContentPath) {
      mainContentPath = dotPath([fieldId, 'raw'].join('.'));
    }
  }

  // Inject a status column for post types. WordPress's declared status enum is not
  // exhaustive — attachments (media) use "inherit", which the media endpoint's enum
  // omits, and plugins add custom statuses — so we emit a nullable string rather than
  // a strict enum union. The ENUM data-type annotation records the enum-ness for the
  // UI without rejecting verbatim values.
  if (isPostType && statusField?.enum) {
    const statusSchema = Type.Union([Type.String(), Type.Null()], { description: 'Publication status' });
    statusSchema[X_SCRATCH_CONNECTOR_DATA_TYPE] = WordPressDataType.ENUM;
    properties[WORDPRESS_STATUS_COLUMN_ID] = Type.Optional(statusSchema);
  }

  // Handle ACF (Advanced Custom Fields) if present
  const acfProps = schemaProps.acf?.properties;
  if (acfProps) {
    const acfFieldProperties: Record<string, TSchema> = {};
    for (const [acfFieldId, acfFieldDef] of Object.entries(acfProps)) {
      if (!acfFieldDef) continue;
      const acfFieldSchema = wordpressFieldToJsonSchema(acfFieldId, acfFieldDef, true, foreignKeyColumnIds);
      acfFieldProperties[acfFieldId] = acfFieldDef.required ? acfFieldSchema : Type.Optional(acfFieldSchema);
    }
    // WordPress returns `acf: []` (PHP empty associative array) when a post type
    // has no ACF values, so tolerate the empty-array shape alongside the object.
    properties['acf'] = Type.Optional(
      wordpressObjectSchemaThatMayBeEmptyArray(
        Type.Object(acfFieldProperties, { description: 'Advanced Custom Fields' }),
      ),
    );
  }

  const schemaOptions: Record<string, unknown> = {
    $id: tableId,
    title: formatTableName(tableId),
  };

  // Media tables are standalone asset tables — each record IS an asset
  if (tableId === 'media') {
    schemaOptions[X_SCRATCH_ASSET_TABLE] = {
      urlPath: 'source_url',
      filenamePath: 'title.raw',
      mimeTypePath: 'mime_type',
      sizePath: 'media_details.filesize',
      widthPath: 'media_details.width',
      heightPath: 'media_details.height',
      altTextPath: 'alt_text',
      urlExpires: false,
    } satisfies AssetTableOptions;
  }

  const schema = Type.Object(properties, schemaOptions);

  // Annotate the last-modified field for incremental pulls. WordPress post-type
  // and media collections expose `modified` (the date the record was last
  // modified, in the site's timezone) — annotate it so the auto-detect layer
  // (`findLastModifiedFieldName`) and the client's last-modified-field picker
  // surface it, exactly as Linear annotates `updatedAt`. Taxonomy collections
  // (categories/tags/terms) have no `modified` field, so nothing is annotated
  // and the connector's `supportsIncrementalPull` resolves to `false` — the job
  // then demotes that folder to a full scan. (`modified_gmt` is intentionally
  // left unannotated; we filter on `modified` and let WordPress map it.)
  const modifiedProp = (schema.properties as Record<string, TSchema | undefined>)[WORDPRESS_MODIFIED_COLUMN_ID];
  if (modifiedProp) {
    modifiedProp[X_SCRATCH_LAST_MODIFIED_FIELD] = true;
  }

  const spec: BaseJsonTableSpec = {
    id,
    slug: id.wsId,
    name: formatTableName(tableId),
    schema,
    idPath: dotPath('id'),
    titlePath,
    mainContentPath,
    slugPath: dotPath('slug'),
    basePath: [],
    generatedAt: new Date().toISOString(),
  };

  return spec;
}

/**
 * Format a table name for display.
 */
export function formatTableName(tableId: string): string {
  return tableId
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

const FIELD_PATH = '/properties';
// NOTE: in a generated spec the `acf` container is now a union
// (`anyOf: [Object, EmptyArray]`), so its real properties live at
// `/properties/acf/anyOf/0/properties`. The helpers below are only exercised by
// the self-contained pointer spec (which builds `acf` as a bare object), so this
// path stays correct there; update it if a generated spec ever reads acf fields.
const ACF_FIELD_PATH = '/properties/acf/properties';

/**
 * Checks if a field is readonly.
 * @param field - The ID of the field to check.
 * @param tableSpec - The table specification.
 * @param isAcf - Whether the field is an ACF field.
 * @returns True if the field is readonly, false otherwise.
 */
export function isReadonlyField(field: string, tableSpec: BaseJsonTableSpec, isAcf = false): boolean {
  const basePath = isAcf ? ACF_FIELD_PATH : FIELD_PATH;
  return ValuePointer.Get(tableSpec.schema, `${basePath}/${escapePointerToken(field)}/${X_SCRATCH_READONLY}`) === true;
}

/**
 * Checks if a field is a foreign key.
 * @param field - The ID of the field to check.
 * @param tableSpec - The table specification.
 * @param isAcf - Whether the field is an ACF field.
 * @returns True if the field is a foreign key, false otherwise.
 */
export function isForeignKey(field: string, tableSpec: BaseJsonTableSpec, isAcf = false): boolean {
  const basePath = isAcf ? ACF_FIELD_PATH : FIELD_PATH;
  return (
    ValuePointer.Has(tableSpec.schema, `${basePath}/${escapePointerToken(field)}/${X_SCRATCH_FOREIGN_KEY_OPTIONS}`) !==
    undefined
  );
}

/**
 * Gets the foreign key options for a field if they exist.
 * @param field - The ID of the field to check.
 * @param tableSpec - The table specification.
 * @param isAcf - Whether the field is an ACF field.
 * @returns The foreign key options, or undefined if the field is not a foreign key.
 */
export function getForeignKeyOptions(
  field: string,
  tableSpec: BaseJsonTableSpec,
  isAcf = false,
): ForeignKeyOptionSchema | undefined {
  const basePath = isAcf ? ACF_FIELD_PATH : FIELD_PATH;
  return ValuePointer.Get(
    tableSpec.schema,
    `${basePath}/${escapePointerToken(field)}/${X_SCRATCH_FOREIGN_KEY_OPTIONS}`,
  ) as ForeignKeyOptionSchema | undefined;
}
