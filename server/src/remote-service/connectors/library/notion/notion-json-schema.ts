import { DatabaseObjectResponse } from '@notionhq/client';
import { Type, type TSchema } from '@sinclair/typebox';
import { TransformerTypes } from '@spinner/shared-types';
import { sanitizeForTableWsId } from '../../ids';
import {
  ASSET_FIELD,
  AssetFieldOptions,
  CONNECTOR_DATA_TYPE,
  FOREIGN_KEY_OPTIONS,
  READONLY_FLAG,
  REMOTE_FIELD_ID,
  SUGGESTED_TRANSFORMER,
  VIRTUAL_FIELDS,
} from '../../json-schema';
import { BaseJsonTableSpec, EntityId } from '../../types';

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
 * Build a BaseJsonTableSpec from a Notion database definition.
 * Generates a JSON Schema describing the raw Notion page API response format.
 */
export function buildNotionJsonTableSpec(id: EntityId, database: DatabaseObjectResponse): BaseJsonTableSpec {
  const [databaseId] = id.remoteId;

  const propertySchemas: Record<string, TSchema> = {};

  for (const [name, property] of Object.entries(database.properties)) {
    const propSchema = notionPropertyToJsonSchema(property);
    propertySchemas[name] = Type.Optional(propSchema);
  }

  const tableTitle = database.title.map((t) => t.plain_text).join('');

  const schema = Type.Object(
    {
      object: Type.Literal('page', { description: 'Object type' }),
      id: Type.String({ description: 'Unique page identifier' }),
      created_time: Type.String({ description: 'Page creation time', format: 'date-time' }),
      last_edited_time: Type.String({ description: 'Last edit time', format: 'date-time' }),
      created_by: Type.Object(
        {
          object: Type.Literal('user'),
          id: Type.String(),
        },
        { description: 'User who created the page' },
      ),
      last_edited_by: Type.Object(
        {
          object: Type.Literal('user'),
          id: Type.String(),
        },
        { description: 'User who last edited the page' },
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
          { [ASSET_FIELD]: { idPath: null, urlExpires: true } satisfies AssetFieldOptions },
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
          { [ASSET_FIELD]: { idPath: null, urlExpires: true } satisfies AssetFieldOptions },
        ),
      ),
      parent: Type.Object(
        {
          type: Type.Literal('database_id'),
          database_id: Type.String(),
        },
        { description: 'Parent database reference' },
      ),
      archived: Type.Boolean({ description: 'Is page archived' }),
      in_trash: Type.Optional(Type.Boolean({ description: 'Is page in trash' })),
      page_content: Type.Optional(
        Type.Array(Type.Unknown(), {
          description: 'Page body content (Notion blocks)',
          [SUGGESTED_TRANSFORMER]: { type: TransformerTypes.NotionToHtml },
          [READONLY_FLAG]: true,
        }),
      ),
      properties: Type.Object(propertySchemas, { description: 'Page properties' }),
      url: Type.String({ description: 'Page URL', format: 'uri' }),
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
    idColumnRemoteId: 'id',
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Convert a Notion database property to a TypeBox JSON Schema.
 */
export function notionPropertyToJsonSchema(property: DatabaseObjectResponse['properties'][string]): TSchema {
  const description = property.name;
  let schema: TSchema;

  switch (property.type) {
    case 'title':
      schema = Type.Array(
        Type.Object({
          type: Type.String(),
          text: Type.Optional(Type.Object({ content: Type.String(), link: Type.Optional(Type.Unknown()) })),
          plain_text: Type.String(),
          href: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        {
          description,
          [VIRTUAL_FIELDS]: [
            {
              displayLabel: description,
              type: 'string',
              suggestedTransformer: {
                type: TransformerTypes.JSONPath,
                options: { expression: '$.title[*].plain_text', arrayHandling: 'concat' },
              },
            },
          ],
        },
      );
      break;

    case 'rich_text':
      schema = Type.Array(
        Type.Object({
          type: Type.String(),
          text: Type.Optional(Type.Object({ content: Type.String(), link: Type.Optional(Type.Unknown()) })),
          plain_text: Type.String(),
          href: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        { description },
      );
      break;

    case 'number':
      schema = Type.Union([Type.Number(), Type.Null()], { description });
      break;

    case 'select':
      schema = Type.Union(
        [
          Type.Object({
            id: Type.String(),
            name: Type.String(),
            color: Type.String(),
          }),
          Type.Null(),
        ],
        { description },
      );
      break;

    case 'multi_select':
      schema = Type.Array(
        Type.Object({
          id: Type.String(),
          name: Type.String(),
          color: Type.String(),
        }),
        { description },
      );
      break;

    case 'status':
      schema = Type.Union(
        [
          Type.Object({
            id: Type.String(),
            name: Type.String(),
            color: Type.String(),
          }),
          Type.Null(),
        ],
        { description },
      );
      break;

    case 'date':
      schema = Type.Union(
        [
          Type.Object({
            start: Type.String({ format: 'date-time' }),
            end: Type.Optional(Type.Union([Type.String({ format: 'date-time' }), Type.Null()])),
            time_zone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { description },
      );
      break;

    case 'people':
      schema = Type.Array(
        Type.Object({
          object: Type.Literal('user'),
          id: Type.String(),
          name: Type.Optional(Type.String()),
          avatar_url: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          type: Type.Optional(Type.String()),
          person: Type.Optional(Type.Object({ email: Type.Optional(Type.String()) })),
        }),
        { description },
      );
      break;

    case 'files':
      schema = Type.Array(
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
        {
          description,
          [ASSET_FIELD]: { idPath: null, urlExpires: true } satisfies AssetFieldOptions,
          [VIRTUAL_FIELDS]: [
            {
              displayLabel: description,
              type: 'string',
              suggestedTransformer: {
                type: TransformerTypes.NotionFileUrl,
                options: { arrayHandling: 'array' },
              },
            },
          ],
        },
      );
      break;

    case 'checkbox':
      schema = Type.Boolean({ description });
      break;

    case 'url':
      schema = Type.Union([Type.String({ format: 'uri' }), Type.Null()], { description });
      break;

    case 'email':
      schema = Type.Union([Type.String({ format: 'email' }), Type.Null()], { description });
      break;

    case 'phone_number':
      schema = Type.Union([Type.String(), Type.Null()], { description });
      break;

    case 'formula':
      schema = Type.Union(
        [
          Type.Object({ type: Type.Literal('string'), string: Type.Union([Type.String(), Type.Null()]) }),
          Type.Object({ type: Type.Literal('number'), number: Type.Union([Type.Number(), Type.Null()]) }),
          Type.Object({ type: Type.Literal('boolean'), boolean: Type.Boolean() }),
          Type.Object({
            type: Type.Literal('date'),
            date: Type.Union([Type.Object({ start: Type.String(), end: Type.Optional(Type.String()) }), Type.Null()]),
          }),
        ],
        { description },
      );
      break;

    case 'relation':
      schema = Type.Object(
        {
          id: Type.String(),
          relation: Type.Array(Type.Object({ id: Type.String() }), {
            [FOREIGN_KEY_OPTIONS]: property.relation.database_id
              ? { linkedTableId: property.relation.database_id, map: 'id' }
              : undefined,
          }),
        },
        { description },
      );
      break;

    case 'rollup':
      schema = Type.Object(
        {
          type: Type.String(),
          function: Type.String(),
          number: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
          date: Type.Optional(Type.Unknown()),
          array: Type.Optional(Type.Array(Type.Unknown())),
        },
        { description },
      );
      break;

    case 'created_time':
      schema = Type.String({ description, format: 'date-time' });
      break;

    case 'created_by':
      schema = Type.Object(
        {
          object: Type.Literal('user'),
          id: Type.String(),
          name: Type.Optional(Type.String()),
          avatar_url: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        },
        { description },
      );
      break;

    case 'last_edited_time':
      schema = Type.String({ description, format: 'date-time' });
      break;

    case 'last_edited_by':
      schema = Type.Object(
        {
          object: Type.Literal('user'),
          id: Type.String(),
          name: Type.Optional(Type.String()),
          avatar_url: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        },
        { description },
      );
      break;

    default:
      schema = Type.Unknown({ description });
      break;
  }

  schema[CONNECTOR_DATA_TYPE] = property.type;
  schema[READONLY_FLAG] = NOTION_READ_ONLY_PROPERTY_TYPES.has(property.type) ? true : undefined;
  schema[REMOTE_FIELD_ID] = property.id;
  return schema;
}
