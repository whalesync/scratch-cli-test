import { TSchema, Type } from '@sinclair/typebox';
import { ValuePointer } from '@sinclair/typebox/value';
import { TransformerTypes } from '@spinner/shared-types';
import _ from 'lodash';
import { Webflow } from 'webflow-api';
import {
  CONNECTOR_DATA_TYPE,
  FOREIGN_KEY_OPTIONS,
  ForeignKeyOptionSchema,
  READONLY_FLAG,
  REMOTE_FIELD_ID,
  SUGGESTED_TRANSFORMER,
} from '../../json-schema';
import { BaseJsonTableSpec, EntityId } from '../../types';

/**
 * Convert a Webflow field to a TypeBox JSON Schema.
 * Annotates the schema with x-scratch metadata (readonly, foreign key, connector data type).
 */
export function webflowFieldToJsonSchema(field: Webflow.Field): TSchema {
  const description = field.displayName;
  let schema: TSchema;

  switch (field.type) {
    case Webflow.FieldType.PlainText:
      schema = Type.String({ description });
      break;

    case Webflow.FieldType.Reference: {
      const refCollectionId = _.get(field.validations, 'collectionId') as string | undefined;
      schema = Type.String({
        description,
        [FOREIGN_KEY_OPTIONS]: refCollectionId ? { linkedTableId: refCollectionId } : undefined,
      });
      break;
    }

    case Webflow.FieldType.RichText:
      schema = Type.String({ description, contentMediaType: 'text/html' });
      break;

    case Webflow.FieldType.Number: {
      const validations = field.validations as { format?: 'decimal' | 'integer' } | undefined;
      if (validations?.format === 'integer') {
        schema = Type.Integer({ description });
      } else {
        schema = Type.Number({ description });
      }
      break;
    }

    case Webflow.FieldType.Switch:
      schema = Type.Boolean({ description });
      break;

    case Webflow.FieldType.DateTime:
      schema = Type.String({ description, format: 'date-time' });
      break;

    case Webflow.FieldType.Email:
      schema = Type.String({ description, format: 'email' });
      break;

    case Webflow.FieldType.Phone:
      schema = Type.String({ description });
      break;

    case Webflow.FieldType.Link:
    case Webflow.FieldType.VideoLink:
      schema = Type.String({ description, format: 'uri' });
      break;

    case Webflow.FieldType.Color:
      schema = Type.String({ description });
      break;

    case Webflow.FieldType.Option: {
      // Webflow options are in validations.options as array of { id, name }
      const options = _.get(field.validations, 'options', []) as { id: string; name: string }[];
      if (options.length > 0) {
        schema = Type.Union(
          options.map((opt) => Type.Literal(opt.id, { title: opt.name })),
          {
            description,
            [SUGGESTED_TRANSFORMER]: {
              type: TransformerTypes.WebflowOption,
            },
          },
        );
      } else {
        schema = Type.String({ description });
      }
      break;
    }

    case Webflow.FieldType.Image:
    case Webflow.FieldType.File:
      schema = Type.Object(
        {
          url: Type.String({ format: 'uri' }),
          alt: Type.Optional(Type.String()),
        },
        { description },
      );
      break;

    case Webflow.FieldType.MultiImage:
      schema = Type.Array(
        Type.Object({
          url: Type.String({ format: 'uri' }),
          alt: Type.Optional(Type.String()),
        }),
        { description },
      );
      break;

    case Webflow.FieldType.MultiReference: {
      const multiRefCollectionId = _.get(field.validations, 'collectionId') as string | undefined;
      schema = Type.Array(Type.String(), {
        description,
        [FOREIGN_KEY_OPTIONS]: multiRefCollectionId ? { linkedTableId: multiRefCollectionId } : undefined,
      });
      break;
    }

    default:
      // Default to unknown for unrecognized types
      schema = Type.Unknown({ description });
      break;
  }

  schema[CONNECTOR_DATA_TYPE] = field.type;
  schema[READONLY_FLAG] = field.isEditable === false ? true : undefined;
  schema[REMOTE_FIELD_ID] = field.id;
  return schema;
}

/**
 * Build a BaseJsonTableSpec schema from Webflow site and collection data.
 * Converts Webflow field types to JSON Schema types.
 * Uses field slugs as property keys.
 */
export function buildWebflowJsonTableSpec(
  id: EntityId,
  site: Webflow.Site,
  collection: Webflow.Collection,
): BaseJsonTableSpec {
  const [, collectionId] = id.remoteId;

  const properties: Record<string, TSchema> = {};
  let titleColumnRemoteId: EntityId['remoteId'] | undefined;
  let mainContentColumnRemoteId: EntityId['remoteId'] | undefined;

  // Add item-level metadata fields (these are present in all Webflow items)
  properties['id'] = Type.String({ description: 'Unique item identifier (read-only)' });
  properties['cmsLocaleId'] = Type.Optional(Type.String({ description: 'CMS locale identifier (read-only)' }));
  properties['lastPublished'] = Type.Optional(
    Type.Union([Type.String({ format: 'date-time' }), Type.Null()], {
      description: 'When the item was last published (read-only)',
      [REMOTE_FIELD_ID]: 'published-on',
    }),
  );
  properties['lastUpdated'] = Type.Optional(
    Type.String({
      format: 'date-time',
      description: 'When the item was last updated (read-only)',
      [REMOTE_FIELD_ID]: 'updated-on',
    }),
  );
  properties['createdOn'] = Type.Optional(
    Type.String({
      format: 'date-time',
      description: 'When the item was created (read-only)',
      [REMOTE_FIELD_ID]: 'created-on',
    }),
  );
  properties['isArchived'] = Type.Optional(
    Type.Boolean({ description: 'Whether the item is archived (default: false)' }),
  );
  properties['isDraft'] = Type.Optional(Type.Boolean({ description: 'Whether the item is a draft (default: false)' }));

  // Add fieldData wrapper to indicate where custom fields are stored
  const fieldDataProperties: Record<string, TSchema> = {};

  for (const field of collection.fields) {
    // Skip fields without a slug
    if (!field.slug) {
      continue;
    }

    const fieldSchema = webflowFieldToJsonSchema(field);

    // Check if field is required using Webflow's isRequired property
    // slug and name fields are always required for Webflow
    const isRequired = field.isRequired || field.slug === 'slug' || field.slug === 'name';

    if (isRequired) {
      fieldDataProperties[field.slug] = fieldSchema;
    } else {
      // Wrap optional fields in Type.Optional to exclude from required array
      fieldDataProperties[field.slug] = Type.Optional(fieldSchema);
    }

    // Track title column (name field)
    if (field.slug === 'name') {
      titleColumnRemoteId = [field.slug, field.id];
    }

    // Track main content column (first RichText field)
    if (!mainContentColumnRemoteId && field.type === Webflow.FieldType.RichText) {
      mainContentColumnRemoteId = [field.slug, field.id];
    }
  }

  // Add fieldData as an object containing all collection-specific fields
  properties['fieldData'] = Type.Object(fieldDataProperties, {
    description: 'Collection-specific field values',
  });

  const schema = Type.Object(properties, {
    $id: collectionId,
    title: collection.displayName,
  });

  return {
    id,
    slug: collection.slug ?? id.wsId,
    name: collection.displayName,
    schema,
    titleColumnRemoteId,
    mainContentColumnRemoteId,
    idColumnRemoteId: 'id',
    slugColumnRemoteId: 'fieldData.slug',
    basePath: [site.displayName ?? site.shortName ?? ''],
    generatedAt: new Date().toISOString(),
  };
}

const FIELD_DATA_PATH = '/properties/fieldData/properties';

/**
 * Checks if a field is readonly.
 * @param field - The slug of the field to check.
 * @param tableSpec - The table specification.
 * @returns True if the field is readonly, false otherwise.
 */
export function isReadonlyField(field: string, tableSpec: BaseJsonTableSpec): boolean {
  return ValuePointer.Get(tableSpec.schema, `${FIELD_DATA_PATH}/${field}/${READONLY_FLAG}`) === true;
}

/**
 * Checks if a field is a foreign key.
 * @param field - The slug of the field to check.
 * @param tableSpec - The table specification.
 * @returns True if the field is a foreign key, false otherwise.
 */
export function isForeignKey(field: string, tableSpec: BaseJsonTableSpec): boolean {
  return ValuePointer.Has(tableSpec.schema, `${FIELD_DATA_PATH}/${field}/${FOREIGN_KEY_OPTIONS}`) !== undefined;
}

/**
 * Gets the foreign key options for a field if they exist.
 * @param field - The slug of the field to check.
 * @param tableSpec - The table specification.
 * @returns The foreign key options, or undefined if the field is not a foreign key.
 */
export function getForeignKeyOptions(field: string, tableSpec: BaseJsonTableSpec): ForeignKeyOptionSchema | undefined {
  return ValuePointer.Get(tableSpec.schema, `${FIELD_DATA_PATH}/${field}/${FOREIGN_KEY_OPTIONS}`) as
    | ForeignKeyOptionSchema
    | undefined;
}
