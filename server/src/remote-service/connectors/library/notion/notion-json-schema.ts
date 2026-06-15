import { type DataSourceObjectResponse } from '@notionhq/client';
import { Type, type TSchema } from '@sinclair/typebox';
import {
  AssetFieldOptions,
  TransformerTypes,
  X_SCRATCH_ASSET_FIELD,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_LAST_MODIFIED_FIELD,
  X_SCRATCH_READONLY,
  X_SCRATCH_REMOTE_FIELD_ID,
  X_SCRATCH_SUGGESTED_TRANSFORMER,
  X_SCRATCH_VIRTUAL_FIELDS,
  type VirtualFieldDef,
} from '@spinner/shared-types';
import { sanitizeForTableWsId } from '../../ids';
import { BaseJsonTableSpec, EntityId, idPath } from '../../types';
import { getDataSourceDisplayName } from './notion-data-source-types';
import { buildNotionDefaultView } from './notion-default-view';

/**
 * Read-only property types that cannot be updated via the Notion API.
 */
export const NOTION_READ_ONLY_PROPERTY_TYPES = new Set([
  'rollup',
  'formula',
  'created_time',
  'last_edited_time',
  'created_by',
  'last_edited_by',
  'unique_id',
  'verification',
]);

/**
 * Build a BaseJsonTableSpec from a Notion 2025-09-03 data source definition.
 *
 * Generates a JSON Schema describing the raw Notion page API response format.
 * The `dataSource` argument carries the property map (which moved from the
 * database to the data source in 2025-09-03) plus its display name. Property
 * shapes themselves are unchanged, so {@link notionPropertyToJsonSchema}
 * still reads them via the SDK v3 `DatabaseObjectResponse['properties']` type.
 */
export function buildNotionJsonTableSpec(id: EntityId, dataSource: DataSourceObjectResponse): BaseJsonTableSpec {
  const [databaseId] = id.remoteId;

  const propertySchemas: Record<string, TSchema> = {};
  let titleColumnRemoteId: string[] | undefined;

  for (const [name, property] of Object.entries(dataSource.properties)) {
    const propSchema = notionPropertyToJsonSchema(property);
    propertySchemas[name] = Type.Optional(propSchema);

    if (property.type === 'title') {
      titleColumnRemoteId = ['properties', name];
    }
  }

  const tableTitle = getDataSourceDisplayName(dataSource);

  const schema = Type.Object(
    {
      object: Type.Literal('page', { description: 'Object type' }),
      id: Type.String({ description: 'Unique page identifier' }),
      created_time: Type.String({ description: 'Page creation time', format: 'date-time', [X_SCRATCH_READONLY]: true }),
      last_edited_time: Type.String({
        description: 'Last edit time',
        format: 'date-time',
        [X_SCRATCH_READONLY]: true,
        // System field present on every Notion page. Drives incremental pulls
        // (the connector filters on it) and surfaces it to the UI's
        // last-modified-field picker. See notion-incremental.ts.
        [X_SCRATCH_LAST_MODIFIED_FIELD]: true,
      }),
      created_by: Type.Object(
        {
          object: Type.Literal('user'),
          id: Type.String(),
        },
        { description: 'User who created the page', [X_SCRATCH_READONLY]: true },
      ),
      last_edited_by: Type.Object(
        {
          object: Type.Literal('user'),
          id: Type.String(),
        },
        { description: 'User who last edited the page', [X_SCRATCH_READONLY]: true },
      ),
      cover: Type.Optional(
        Type.Union(
          [
            Type.Object({
              type: Type.Literal('external'),
              external: Type.Object({ url: Type.String({ format: 'uri' }) }),
            }),
            Type.Object({
              type: Type.Literal('file'),
              file: Type.Object({ url: Type.String({ format: 'uri' }), expiry_time: Type.String() }),
            }),
            Type.Null(),
          ],
          { [X_SCRATCH_ASSET_FIELD]: { idPath: null, urlExpires: true } satisfies AssetFieldOptions },
        ),
      ),
      icon: Type.Optional(
        Type.Union(
          [
            Type.Object({
              type: Type.Literal('emoji'),
              emoji: Type.String(),
            }),
            Type.Object({
              type: Type.Literal('external'),
              external: Type.Object({ url: Type.String({ format: 'uri' }) }),
            }),
            Type.Object({
              type: Type.Literal('file'),
              file: Type.Object({ url: Type.String({ format: 'uri' }), expiry_time: Type.String() }),
            }),
            Type.Null(),
          ],
          { [X_SCRATCH_ASSET_FIELD]: { idPath: null, urlExpires: true } satisfies AssetFieldOptions },
        ),
      ),
      parent: Type.Union(
        [
          Type.Object({
            type: Type.Literal('database_id'),
            database_id: Type.String(),
          }),
          Type.Object({
            type: Type.Literal('data_source_id'),
            data_source_id: Type.String(),
          }),
        ],
        { description: 'Parent reference (database or data source)' },
      ),
      // Trash / archive state. Notion renamed these across API versions:
      // 2025-09-03 emitted `archived`; 2026-03-11 stopped emitting it and uses
      // `in_trash` (the renamed soft-delete) plus a distinct `is_archived`. All
      // three are optional so the envelope faithfully describes a record pulled
      // under either version — older on-disk records still carry `archived`.
      archived: Type.Optional(Type.Boolean({ description: 'Is page archived (legacy; absent under 2026-03-11+)' })),
      in_trash: Type.Optional(Type.Boolean({ description: 'Is page in trash' })),
      is_archived: Type.Optional(Type.Boolean({ description: 'Is page archived (2026-03-11+)' })),
      page_content: Type.Optional(
        Type.Array(Type.Unknown(), {
          description: 'Page body content (Notion blocks)',
          [X_SCRATCH_SUGGESTED_TRANSFORMER]: { type: TransformerTypes.NotionToHtml },
          [X_SCRATCH_READONLY]: true,
        }),
      ),
      properties: Type.Object(propertySchemas, { description: 'Page properties' }),
      url: Type.String({ description: 'Page URL', format: 'uri', [X_SCRATCH_READONLY]: true }),
      public_url: Type.Optional(Type.Union([Type.String({ format: 'uri' }), Type.Null()])),
    },
    {
      $id: `notion/${databaseId}`,
      title: tableTitle,
    },
  );

  return {
    id,
    slug: id.wsId,
    name: sanitizeForTableWsId(tableTitle),
    schema,
    idColumnRemoteId: idPath('id'),
    titleColumnRemoteId,
    basePath: [],
    generatedAt: new Date().toISOString(),
    defaultView: buildNotionDefaultView(schema),
  };
}

/**
 * Build the rich-text span object schema shared by `title` and `rich_text`
 * property inner values (a Notion rich-text array element).
 */
function notionRichTextSpanSchema(): TSchema {
  return Type.Object({
    type: Type.String(),
    text: Type.Optional(Type.Object({ content: Type.String(), link: Type.Optional(Type.Unknown()) })),
    plain_text: Type.String(),
    href: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  });
}

/**
 * Build the Notion user object schema (`{ object: 'user', id, ... }`) used as
 * the inner value of `created_by` / `last_edited_by` properties.
 */
function notionUserObjectSchema(): TSchema {
  return Type.Object({
    object: Type.Literal('user'),
    id: Type.String(),
    name: Type.Optional(Type.String()),
    avatar_url: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  });
}

/**
 * Wrap an inner property value in the raw Notion property envelope that the pull
 * path persists verbatim on disk: `{ id, type: <typeKey>, <typeKey>: value, ...extras }`.
 *
 * `typeKey` is the Notion property type string, which is also the key the value
 * lives under in every Notion property object — e.g. an email property is stored
 * as `{ id, type: 'email', email: '...' }`, a multi_select as
 * `{ id, type: 'multi_select', multi_select: [...] }`. Modeling this envelope —
 * rather than the bare inner value — is what makes the generated schema match the
 * verbatim API response, per the *Preserve external data fidelity* product
 * principle. See docs/plans/2026-06-02-notion-schema-envelope-fix.md.
 *
 * The envelope is intentionally faithful-where-it-matters, not exhaustive: it
 * models the structural extras real data carries (e.g. `relation.has_more`) but
 * leaves rarely-needed keys off. TypeBox omits `additionalProperties`, so any
 * extra keys on a real record (rich-text `annotations`, page `parent.database_id`)
 * still validate.
 */
function wrapInNotionPropertyEnvelope(
  typeKey: string,
  innerValueSchema: TSchema,
  description: string,
  extraEnvelopeKeys?: Record<string, TSchema>,
): TSchema {
  return Type.Object(
    {
      id: Type.String(),
      type: Type.Literal(typeKey),
      [typeKey]: innerValueSchema,
      ...(extraEnvelopeKeys ?? {}),
    },
    { description },
  );
}

/**
 * Convert a Notion database property to a TypeBox JSON Schema.
 *
 * Returns the raw on-disk **envelope** `{ id, type, <typeKey>: value }` (see
 * {@link wrapInNotionPropertyEnvelope}), with all `x-scratch-*` annotations on
 * the outer envelope object. Placing the annotations on the outer object keeps
 * each property a single leaf for diff/column granularity (see
 * `build-column-definitions.ts` and the `extractSchemaFields` leaf guard in
 * `server/src/utils/schema-helpers.ts`).
 */
export function notionPropertyToJsonSchema(property: DataSourceObjectResponse['properties'][string]): TSchema {
  const description = property.name;

  // Inner value schema (the unwrapped per-property value) plus any annotations
  // that belong on the outer envelope. `extraEnvelopeKeys` carries structural
  // envelope siblings beyond `{ id, type, <typeKey> }` (e.g. relation.has_more).
  let innerValueSchema: TSchema;
  let extraEnvelopeKeys: Record<string, TSchema> | undefined;
  let virtualFields: VirtualFieldDef[] | undefined;
  let assetFieldOptions: AssetFieldOptions | undefined;
  let foreignKeyOptions: { linkedTableId: string; map: string } | undefined;

  switch (property.type) {
    case 'title':
      innerValueSchema = Type.Array(notionRichTextSpanSchema());
      // JSONPath is envelope-relative: `$.title` resolves against the property
      // envelope `{ id, type: 'title', title: [...] }` we now describe.
      virtualFields = [
        {
          displayLabel: description,
          type: 'string',
          suggestedTransformer: {
            type: TransformerTypes.JSONPath,
            options: { expression: '$.title[*].plain_text', arrayHandling: 'concat' },
          },
        },
      ];
      break;

    case 'rich_text':
      innerValueSchema = Type.Array(notionRichTextSpanSchema());
      break;

    case 'number':
      innerValueSchema = Type.Union([Type.Number(), Type.Null()]);
      break;

    case 'select':
    case 'status':
      innerValueSchema = Type.Union([
        Type.Object({ id: Type.String(), name: Type.String(), color: Type.String() }),
        Type.Null(),
      ]);
      break;

    case 'multi_select':
      innerValueSchema = Type.Array(Type.Object({ id: Type.String(), name: Type.String(), color: Type.String() }));
      break;

    case 'date':
      innerValueSchema = Type.Union([
        Type.Object({
          start: Type.String({ format: 'date-time' }),
          end: Type.Optional(Type.Union([Type.String({ format: 'date-time' }), Type.Null()])),
          time_zone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]);
      break;

    case 'people':
      innerValueSchema = Type.Array(
        Type.Object({
          object: Type.Literal('user'),
          id: Type.String(),
          name: Type.Optional(Type.String()),
          avatar_url: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          type: Type.Optional(Type.String()),
          person: Type.Optional(Type.Object({ email: Type.Optional(Type.String()) })),
        }),
      );
      break;

    case 'files':
      innerValueSchema = Type.Array(
        Type.Union([
          Type.Object({
            name: Type.String(),
            type: Type.Literal('external'),
            external: Type.Object({ url: Type.String({ format: 'uri' }) }),
          }),
          Type.Object({
            name: Type.String(),
            type: Type.Literal('file'),
            file: Type.Object({ url: Type.String({ format: 'uri' }), expiry_time: Type.String() }),
          }),
        ]),
      );
      assetFieldOptions = { idPath: null, urlExpires: true };
      // NotionFileUrl reads the envelope and digs into `.files` itself.
      virtualFields = [
        {
          displayLabel: description,
          type: 'string',
          suggestedTransformer: {
            type: TransformerTypes.NotionFileUrl,
            options: { arrayHandling: 'array' },
          },
        },
      ];
      break;

    case 'checkbox':
      innerValueSchema = Type.Boolean();
      break;

    case 'url':
      innerValueSchema = Type.Union([Type.String({ format: 'uri' }), Type.Null()]);
      break;

    case 'email':
      innerValueSchema = Type.Union([Type.String({ format: 'email' }), Type.Null()]);
      break;

    case 'phone_number':
      innerValueSchema = Type.Union([Type.String(), Type.Null()]);
      break;

    case 'formula':
      // Doubly nested: the envelope `formula` value is itself a tagged result
      // object `{ type, <result> }`. The default view shows this inner object;
      // we model both nesting levels rather than guessing the result key.
      innerValueSchema = Type.Union([
        Type.Object({ type: Type.Literal('string'), string: Type.Union([Type.String(), Type.Null()]) }),
        Type.Object({ type: Type.Literal('number'), number: Type.Union([Type.Number(), Type.Null()]) }),
        Type.Object({ type: Type.Literal('boolean'), boolean: Type.Boolean() }),
        Type.Object({
          type: Type.Literal('date'),
          date: Type.Union([Type.Object({ start: Type.String(), end: Type.Optional(Type.String()) }), Type.Null()]),
        }),
      ]);
      break;

    case 'relation':
      innerValueSchema = Type.Array(Type.Object({ id: Type.String() }));
      // Real relation data carries a sibling `has_more` flag (Notion truncates
      // the relation array to 25 on response).
      extraEnvelopeKeys = { has_more: Type.Optional(Type.Boolean()) };
      foreignKeyOptions = property.relation.database_id
        ? { linkedTableId: property.relation.database_id, map: 'id' }
        : undefined;
      break;

    case 'rollup':
      // Doubly nested: the envelope `rollup` value is itself an object carrying
      // `function`/`type` plus the result key. Shown as its inner object.
      innerValueSchema = Type.Object({
        type: Type.String(),
        function: Type.String(),
        number: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
        date: Type.Optional(Type.Unknown()),
        array: Type.Optional(Type.Array(Type.Unknown())),
      });
      break;

    case 'created_time':
    case 'last_edited_time':
      innerValueSchema = Type.String({ format: 'date-time' });
      break;

    case 'created_by':
    case 'last_edited_by':
      innerValueSchema = notionUserObjectSchema();
      break;

    default:
      // Unknown / future Notion type: keep the envelope shape with an opaque
      // inner value. Renders as JSON; never silently mistyped.
      innerValueSchema = Type.Unknown();
      break;
  }

  const schema = wrapInNotionPropertyEnvelope(property.type, innerValueSchema, description, extraEnvelopeKeys);

  schema[X_SCRATCH_CONNECTOR_DATA_TYPE] = property.type;
  schema[X_SCRATCH_READONLY] = NOTION_READ_ONLY_PROPERTY_TYPES.has(property.type) ? true : undefined;
  schema[X_SCRATCH_REMOTE_FIELD_ID] = property.id;
  if (virtualFields) schema[X_SCRATCH_VIRTUAL_FIELDS] = virtualFields;
  if (assetFieldOptions) schema[X_SCRATCH_ASSET_FIELD] = assetFieldOptions;
  if (foreignKeyOptions) schema[X_SCRATCH_FOREIGN_KEY_OPTIONS] = foreignKeyOptions;
  return schema;
}
