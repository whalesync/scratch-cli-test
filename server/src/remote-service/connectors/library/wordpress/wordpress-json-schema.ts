import { TSchema, Type } from '@sinclair/typebox';
import { ValuePointer } from '@sinclair/typebox/value';
import { isArray } from 'lodash';
import {
  ASSET_TABLE,
  AssetTableOptions,
  CONNECTOR_DATA_TYPE,
  FOREIGN_KEY_OPTIONS,
  ForeignKeyOptionSchema,
  READONLY_FLAG,
} from '../../json-schema';
import { BaseJsonTableSpec, EntityId } from '../../types';
import { WORDPRESS_STATUS_COLUMN_ID } from './wordpress-constants';
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
 * Convert a WordPress field argument to a TypeBox JSON Schema.
 * Annotates the schema with x-scratch metadata (readonly, foreign key, connector data type).
 */
export function wordpressFieldToJsonSchema(
  fieldId: string,
  field: WordPressArgument,
  isAcf: boolean,
  foreignKeyColumnIds: { remoteColumnId: string; foreignKeyRemoteTableId: string }[],
): TSchema {
  const description = fieldId;
  const fieldType = isArray(field.type) ? field.type[0] : field.type;
  const dataType = resolveWordPressDataType(fieldId, field, isAcf, foreignKeyColumnIds);
  let schema: TSchema;

  // Handle rendered objects (title, content, excerpt, etc.)
  if (field.properties?.rendered) {
    schema = Type.Object(
      {
        rendered: Type.String({ description: 'HTML rendered content' }),
        raw: Type.Optional(Type.String({ description: 'Raw content' })),
        protected: Type.Optional(Type.Boolean()),
      },
      { description },
    );
  } else if (field.enum && field.enum.length > 0) {
    // Handle enums
    schema = Type.Union(
      field.enum.map((val) => Type.Literal(val)),
      { description },
    );
  } else {
    switch (fieldType) {
      case 'integer':
        schema = Type.Integer({ description });
        break;

      case 'number':
        schema = Type.Number({ description });
        break;

      case 'boolean':
        schema = Type.Boolean({ description });
        break;

      case 'string':
        if (field.format === 'date-time') {
          schema = Type.String({ description, format: 'date-time' });
        } else if (field.format === 'uri') {
          schema = Type.String({ description, format: 'uri' });
        } else if (field.format === 'email') {
          schema = Type.String({ description, format: 'email' });
        } else {
          schema = Type.String({ description });
        }
        break;

      case 'array':
        schema = Type.Array(Type.Unknown(), { description });
        break;

      case 'object':
        if (field.properties) {
          const objProps: Record<string, TSchema> = {};
          for (const [propId, propDef] of Object.entries(field.properties)) {
            if (propDef) {
              objProps[propId] = wordpressFieldToJsonSchema(propId, propDef, isAcf, foreignKeyColumnIds);
            }
          }
          schema = Type.Object(objProps, { description });
        } else {
          schema = Type.Record(Type.String(), Type.Unknown(), { description });
        }
        break;

      default:
        schema = Type.Unknown({ description });
        break;
    }
  }

  // Set foreign key metadata for known FK fields (non-ACF only)
  if (!isAcf) {
    const fkDef = foreignKeyColumnIds.find((fk) => fk.remoteColumnId === fieldId);
    if (fkDef) {
      schema[FOREIGN_KEY_OPTIONS] = { linkedTableId: fkDef.foreignKeyRemoteTableId };
    }
  }

  schema[CONNECTOR_DATA_TYPE] = dataType;
  schema[READONLY_FLAG] = field.readonly === true ? true : undefined;
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
  let titleColumnRemoteId: EntityId['remoteId'] | undefined;
  let mainContentColumnRemoteId: EntityId['remoteId'] | undefined;

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
      titleColumnRemoteId = ['title', 'raw'];
    }

    // Track main content column
    if (fieldId === 'content' && !mainContentColumnRemoteId) {
      mainContentColumnRemoteId = [tableId, fieldId];
    }
  }

  // Inject static status field for post types using enum values from the OPTIONS response
  if (isPostType && statusField?.enum) {
    const statusSchema = Type.Union(
      statusField.enum.map((val) => Type.Literal(val)),
      { description: 'Publication status' },
    );
    statusSchema[CONNECTOR_DATA_TYPE] = WordPressDataType.ENUM;
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
    properties['acf'] = Type.Optional(Type.Object(acfFieldProperties, { description: 'Advanced Custom Fields' }));
  }

  const schemaOptions: Record<string, unknown> = {
    $id: tableId,
    title: formatTableName(tableId),
  };

  // Media tables are standalone asset tables — each record IS an asset
  if (tableId === 'media') {
    schemaOptions[ASSET_TABLE] = {
      urlPath: 'source_url',
      filenamePath: 'title.rendered',
      mimeTypePath: 'mime_type',
      sizePath: 'media_details.filesize',
      widthPath: 'media_details.width',
      heightPath: 'media_details.height',
      altTextPath: 'alt_text',
      urlExpires: false,
    } satisfies AssetTableOptions;
  }

  const schema = Type.Object(properties, schemaOptions);

  return {
    id,
    slug: id.wsId,
    name: formatTableName(tableId),
    schema,
    idColumnRemoteId: 'id',
    titleColumnRemoteId,
    mainContentColumnRemoteId,
    slugFieldPath: 'slug',
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
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
  return ValuePointer.Get(tableSpec.schema, `${basePath}/${field}/${READONLY_FLAG}`) === true;
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
  return ValuePointer.Has(tableSpec.schema, `${basePath}/${field}/${FOREIGN_KEY_OPTIONS}`) !== undefined;
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
  return ValuePointer.Get(tableSpec.schema, `${basePath}/${field}/${FOREIGN_KEY_OPTIONS}`) as
    | ForeignKeyOptionSchema
    | undefined;
}
