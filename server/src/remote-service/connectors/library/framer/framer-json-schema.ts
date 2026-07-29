import { type TSchema, Type } from '@sinclair/typebox';
import { ValuePointer } from '@sinclair/typebox/value';
import {
  type ForeignKeyOptionSchema,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_READONLY,
  X_SCRATCH_REMOTE_FIELD_ID,
} from '@spinner/shared-types';
import { BaseJsonTableSpec, DotPath, EntityId, dotPath } from '../../types';
import { escapePointerToken } from '../../utils/json-pointer';
import { FramerCollectionMeta, FramerFieldMeta, FramerFieldType, NON_DATA_FRAMER_FIELD_TYPES } from './framer-types';

/**
 * Build the JSON Schema for the *value* of one Framer field — the editable leaf
 * at `fieldData.<fieldId>.value`. Carries the x-scratch annotations (connector
 * data type, remote field id, and — for references — the foreign-key target), so
 * the generic schema walkers (FK discovery, column definitions) find them at the
 * value node's path.
 */
function framerFieldValueSchema(field: FramerFieldMeta): TSchema {
  const description = field.name;
  let schema: TSchema;

  switch (field.type) {
    case FramerFieldType.String:
      schema = Type.Union([Type.String(), Type.Null()], { description });
      break;
    case FramerFieldType.FormattedText:
      schema = Type.Union([Type.String(), Type.Null()], { description, contentMediaType: 'text/html' });
      break;
    case FramerFieldType.Number:
      schema = Type.Union([Type.Number(), Type.Null()], { description });
      break;
    case FramerFieldType.Boolean:
      schema = Type.Boolean({ description });
      break;
    case FramerFieldType.Date:
      // Framer stores dates as UTC instants and reads every one back as a full ISO-8601
      // timestamp, even a value entered as a bare calendar day (`2026-12-25` comes back as
      // `2026-12-25T00:00:00.000Z`) — or omits `value` entirely when the field is empty.
      // `format: 'date-time'` is the generic signal the export layer reads to create a real
      // timestamp column on the destination instead of a date-only one that drops the
      // time-of-day for the life of the export (DEV-11086, the Framer instance of DEV-10788).
      //
      // A field Framer itself reports as not displaying time is a genuine calendar date, so
      // it keeps the date-only column. It still gets NO format: the value on the wire is an
      // ISO instant regardless, and a `format: 'date'` assertion would flag every record.
      schema = Type.Union([Type.String(dateValueFormatAnnotation(field)), Type.Null()], { description });
      break;
    case FramerFieldType.Link:
      // No `format: 'uri'` — Framer returns "" for a cleared link, which a strict
      // uri format would reject (the verbatim record must always conform to its own
      // schema). The 'url' column type in the default view still hints the display.
      schema = Type.Union([Type.String(), Type.Null()], { description });
      break;
    case FramerFieldType.Color:
      // Reads as a hex/rgba string or a ColorStyle object — keep it permissive.
      schema = Type.Unknown({ description });
      break;
    case FramerFieldType.Enum:
      // Framer reads an enum value back as the case NAME (e.g. "Live"), not the
      // case id, and normalizes it on write — so model it as a nullable string
      // rather than a fixed id/name union (which would churn on case renames).
      schema = Type.Union([Type.String(), Type.Null()], { description });
      break;
    case FramerFieldType.Image:
    case FramerFieldType.File:
      // Reads back as an asset object ({ url, ... }); writes as a URL string.
      schema = Type.Union([framerAssetValueSchema(), Type.Null()], { description });
      break;
    case FramerFieldType.CollectionReference:
      schema = Type.Union([Type.String(), Type.Null()], {
        description,
        [X_SCRATCH_FOREIGN_KEY_OPTIONS]: field.collectionId
          ? framerReferenceForeignKeyOptions(field.collectionId)
          : undefined,
      });
      break;
    case FramerFieldType.MultiCollectionReference:
      schema = Type.Array(Type.String(), {
        description,
        [X_SCRATCH_FOREIGN_KEY_OPTIONS]: field.collectionId
          ? framerReferenceForeignKeyOptions(field.collectionId)
          : undefined,
      });
      break;
    case FramerFieldType.Array:
      // Array of sub-items (currently image-only per Framer docs) — stored verbatim.
      schema = Type.Array(Type.Unknown(), { description });
      break;
    default:
      schema = Type.Unknown({ description });
      break;
  }

  schema[X_SCRATCH_CONNECTOR_DATA_TYPE] = field.type;
  schema[X_SCRATCH_REMOTE_FIELD_ID] = field.id;
  // `unsupported` is the SDK's marker for a field type it (and therefore we) can't
  // model — we don't know its write shape, so mark it read-only rather than let a
  // user make an edit that the service would reject. Future-proofs against new
  // Framer field types an older SDK version doesn't recognize.
  if (field.type === FramerFieldType.Unsupported) {
    schema[X_SCRATCH_READONLY] = true;
  }
  return schema;
}

/**
 * The foreign-key annotation for a Framer reference field.
 *
 * Framer's Server API reads a reference back as the target item's **slug**, never its id — the
 * connector stores that verbatim per the Prime Directive, and the write path translates slug→id
 * (`getWriteTranslationMaps`). `targetKeyPath: 'slug'` tells the generic FK resolver the same
 * thing, so it matches the value against the target's `slug` instead of its remote id, which it
 * would otherwise assume and never find (DEV-11085). Slugs are unique within a Framer collection,
 * which is what the key contract requires.
 */
function framerReferenceForeignKeyOptions(collectionId: string): ForeignKeyOptionSchema {
  // `listTables` builds each collection's `remoteId` as `[collection.id]`, so the target table's
  // full remote id array is just `[collectionId]`.
  return { linkedTableId: collectionId, linkedTableRemoteId: [collectionId], targetKeyPath: 'slug' };
}

/**
 * The `format` annotation for a date field's value string — `date-time` unless Framer
 * explicitly reports the field as not displaying a time-of-day, in which case the value is
 * annotated with no format at all. See the `Date` case above for why.
 */
function dateValueFormatAnnotation(field: FramerFieldMeta): { format?: string } {
  return field.displayTime === false ? {} : { format: 'date-time' };
}

/** The read-back shape of an image/file asset value. */
function framerAssetValueSchema(): TSchema {
  return Type.Object(
    {
      url: Type.Optional(Type.String()),
      id: Type.Optional(Type.String()),
      type: Type.Optional(Type.String()),
      alt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    },
    { additionalProperties: true },
  );
}

/**
 * Build the schema for one field's `fieldData` entry: the verbatim
 * `{ type, value, valueByLocale }` wrapper. `type` and `valueByLocale` are
 * read-only metadata; `value` is the editable leaf (and carries the field's
 * annotations). The whole entry is optional — Framer omits fields with no value.
 */
function framerFieldEntrySchema(field: FramerFieldMeta): TSchema {
  return Type.Optional(
    Type.Object(
      {
        type: Type.String({ description: 'Framer field type discriminant', [X_SCRATCH_READONLY]: true }),
        // Framer omits `value` for an empty field (e.g. `{ "type": "file" }`), so it's optional.
        value: Type.Optional(framerFieldValueSchema(field)),
        valueByLocale: Type.Optional(Type.Unknown({ description: 'Localized values', [X_SCRATCH_READONLY]: true })),
      },
      { title: field.name },
    ),
  );
}

/**
 * Build a {@link BaseJsonTableSpec} for a Framer CMS collection. The record is
 * stored verbatim: top-level `{ id, nodeId, slug, slugByLocale, draft, fieldData }`,
 * where `fieldData` is keyed by field id. The connection's project is singular
 * (the API key scopes to one site), so collections sit at the top level
 * (`basePath: []`) and the record path is `/{Collection}/{slug}.json`.
 */
export function buildFramerJsonTableSpec(id: EntityId, collection: FramerCollectionMeta): BaseJsonTableSpec {
  const fieldDataProperties: Record<string, TSchema> = {};
  let titlePath: DotPath | undefined;
  let mainContentPath: DotPath | undefined;

  for (const field of collection.fields) {
    if (NON_DATA_FRAMER_FIELD_TYPES.has(field.type)) continue;
    fieldDataProperties[field.id] = framerFieldEntrySchema(field);

    if (!titlePath && (field.type === FramerFieldType.String || field.type === FramerFieldType.FormattedText)) {
      titlePath = dotPath(['fieldData', field.id, 'value'].join('.'));
    }
    if (!mainContentPath && field.type === FramerFieldType.FormattedText) {
      mainContentPath = dotPath(['fieldData', field.id, 'value'].join('.'));
    }
  }

  const schema = Type.Object(
    {
      id: Type.String({ description: 'Unique item id (read-only)', [X_SCRATCH_READONLY]: true }),
      nodeId: Type.Optional(Type.String({ description: 'Node id (read-only)', [X_SCRATCH_READONLY]: true })),
      slug: Type.String({ description: 'Unique slug within the collection' }),
      slugByLocale: Type.Optional(
        Type.Unknown({ description: 'Localized slugs (read-only)', [X_SCRATCH_READONLY]: true }),
      ),
      draft: Type.Optional(Type.Boolean({ description: 'Whether the item is a draft (excluded from publishing)' })),
      fieldData: Type.Object(fieldDataProperties, { description: 'Field values keyed by field id' }),
    },
    {
      $id: collection.id,
      title: collection.name,
    },
  );

  return {
    id,
    slug: id.wsId,
    name: collection.name,
    schema,
    idPath: dotPath('id'),
    titlePath: titlePath ?? dotPath('slug'),
    mainContentPath,
    slugPath: dotPath('slug'),
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

const FIELD_VALUE_POINTER = (fieldId: string): string =>
  `/properties/fieldData/properties/${escapePointerToken(fieldId)}/properties/value`;

/** Whether a field's value is annotated as a foreign key. */
export function isFramerForeignKey(fieldId: string, tableSpec: BaseJsonTableSpec): boolean {
  return ValuePointer.Has(tableSpec.schema, `${FIELD_VALUE_POINTER(fieldId)}/${X_SCRATCH_FOREIGN_KEY_OPTIONS}`);
}

/** The foreign-key options for a field's value, if any. */
export function getFramerForeignKeyOptions(
  fieldId: string,
  tableSpec: BaseJsonTableSpec,
): ForeignKeyOptionSchema | undefined {
  return ValuePointer.Get(tableSpec.schema, `${FIELD_VALUE_POINTER(fieldId)}/${X_SCRATCH_FOREIGN_KEY_OPTIONS}`) as
    | ForeignKeyOptionSchema
    | undefined;
}
