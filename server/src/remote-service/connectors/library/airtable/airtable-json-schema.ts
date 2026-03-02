import { Type, type TSchema } from '@sinclair/typebox';
import { ValuePointer } from '@sinclair/typebox/value';
import {
  CONNECTOR_DATA_TYPE,
  FOREIGN_KEY_OPTIONS,
  ForeignKeyOptionSchema,
  READONLY_FLAG,
  REMOTE_FIELD_ID,
} from '../../json-schema';
import { BaseJsonTableSpec, EntityId } from '../../types';
import { AirtableBase, AirtableDataType, AirtableFieldsV2, AirtableTableV2 } from './airtable-types';

/**
 * Build a BaseJsonTableSpec from an Airtable table definition.
 * Generates a JSON Schema describing the raw Airtable record format:
 * { id: string, fields: { ... }, createdTime: string }
 */
export function buildAirtableJsonTableSpec(
  id: EntityId,
  base: AirtableBase,
  table: AirtableTableV2,
): BaseJsonTableSpec {
  const [baseId, tableId] = id.remoteId;

  const fieldProperties: Record<string, TSchema> = {};
  let titleColumnRemoteId: EntityId['remoteId'] | undefined;
  let mainContentColumnRemoteId: EntityId['remoteId'] | undefined;

  for (const field of table.fields) {
    const fieldSchema = airtableFieldToJsonSchema(field);
    // All Airtable fields are optional in the response (can be missing if empty)
    fieldProperties[field.name] = Type.Optional(fieldSchema);

    // Track title column (primary field)
    if (field.id === table.primaryFieldId) {
      titleColumnRemoteId = [baseId, tableId, field.id];
    }

    // Track main content column (first rich text field)
    if (!mainContentColumnRemoteId && (field.type as AirtableDataType) === AirtableDataType.RICH_TEXT) {
      mainContentColumnRemoteId = [baseId, tableId, field.id];
    }
  }

  // Airtable raw record schema: { id, fields, createdTime }
  const schema = Type.Object(
    {
      id: Type.String({ description: 'Unique record identifier' }),
      fields: Type.Object(fieldProperties, { description: 'Record field values keyed by field name' }),
      createdTime: Type.String({ description: 'ISO 8601 timestamp of record creation', format: 'date-time' }),
    },
    {
      $id: `${baseId}/${tableId}`,
      title: table.name,
    },
  );

  return {
    id,
    slug: id.wsId,
    name: table.name,
    schema,
    idColumnRemoteId: 'id',
    titleColumnRemoteId,
    mainContentColumnRemoteId,
    basePath: [base.name],
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Convert an Airtable field to a TypeBox JSON Schema.
 */
export function airtableFieldToJsonSchema(field: AirtableFieldsV2): TSchema {
  const description = field.description || field.name;
  let schema: TSchema;

  switch (field.type as AirtableDataType) {
    case AirtableDataType.SINGLE_LINE_TEXT:
    case AirtableDataType.MULTILINE_TEXT:
    case AirtableDataType.PHONE_NUMBER:
      schema = Type.String({ description });
      break;

    case AirtableDataType.BARCODE:
      schema = Type.Object(
        {
          text: Type.Optional(Type.String()),
          type: Type.Optional(Type.String()),
        },
        { description },
      );
      break;

    case AirtableDataType.EMAIL:
      schema = Type.String({ description, format: 'email' });
      break;

    case AirtableDataType.URL:
      schema = Type.String({ description, format: 'uri' });
      break;

    case AirtableDataType.RICH_TEXT:
      schema = Type.String({ description, contentMediaType: 'text/airmark' });
      break;

    case AirtableDataType.NUMBER:
    case AirtableDataType.PERCENT:
    case AirtableDataType.CURRENCY:
    case AirtableDataType.DURATION:
    case AirtableDataType.RATING:
      schema = Type.Number({ description });
      break;

    case AirtableDataType.AUTO_NUMBER:
    case AirtableDataType.COUNT:
      schema = Type.Integer({ description });
      break;

    case AirtableDataType.CHECKBOX:
      schema = Type.Boolean({ description });
      break;

    case AirtableDataType.DATE:
      schema = Type.String({ description, format: 'date' });
      break;

    case AirtableDataType.DATE_TIME:
    case AirtableDataType.CREATED_TIME:
    case AirtableDataType.LAST_MODIFIED_TIME:
      schema = Type.String({ description, format: 'date-time' });
      break;

    case AirtableDataType.SINGLE_SELECT:
      schema = Type.Union([Type.String(), Type.Null()], { description });
      break;

    case AirtableDataType.MULTIPLE_SELECTS:
      schema = Type.Array(Type.String(), { description });
      break;

    case AirtableDataType.MULTIPLE_LOOKUP_VALUES:
      schema = Type.Array(Type.String(), { description });
      break;

    case AirtableDataType.MULTIPLE_RECORD_LINKS:
      schema = Type.Array(Type.String(), {
        description,
        [FOREIGN_KEY_OPTIONS]: field.options?.linkedTableId
          ? {
              linkedTableId: field.options?.linkedTableId,
            }
          : undefined,
      });
      break;

    case AirtableDataType.SINGLE_COLLABORATOR:
      schema = Type.Object(
        {
          id: Type.String(),
          email: Type.String({ format: 'email' }),
          name: Type.String(),
        },
        { description },
      );
      break;

    case AirtableDataType.MULTIPLE_COLLABORATORS:
      schema = Type.Array(
        Type.Object({
          id: Type.String(),
          email: Type.String({ format: 'email' }),
          name: Type.String(),
        }),
        { description },
      );
      break;

    case AirtableDataType.MULTIPLE_ATTACHMENTS:
      schema = Type.Array(
        Type.Object({
          id: Type.String(),
          url: Type.String({ format: 'uri' }),
          filename: Type.Optional(Type.String()),
          size: Type.Optional(Type.Number()),
          type: Type.Optional(Type.String()),
        }),
        { description },
      );
      break;

    case AirtableDataType.CREATED_BY:
    case AirtableDataType.LAST_MODIFIED_BY:
      schema = Type.Object(
        {
          id: Type.String(),
          email: Type.String({ format: 'email' }),
          name: Type.String(),
        },
        { description },
      );
      break;

    case AirtableDataType.FORMULA:
    case AirtableDataType.ROLLUP:
    case AirtableDataType.LOOKUP:
      // These can return various types, use unknown
      schema = Type.Unknown({ description });
      break;

    default:
      schema = Type.Unknown({ description });
      break;
  }

  schema[CONNECTOR_DATA_TYPE] = field.type;
  schema[READONLY_FLAG] = isAirtableColumnReadonly(field) ? true : undefined;
  schema[REMOTE_FIELD_ID] = field.id;
  return schema;
}

function isAirtableColumnReadonly(field: AirtableFieldsV2): boolean {
  const type = field.type as AirtableDataType;

  switch (type) {
    case AirtableDataType.FORMULA:
    case AirtableDataType.ROLLUP:
    case AirtableDataType.COUNT:
    case AirtableDataType.LOOKUP:
    case AirtableDataType.CREATED_TIME:
    case AirtableDataType.LAST_MODIFIED_TIME:
    case AirtableDataType.CREATED_BY:
    case AirtableDataType.LAST_MODIFIED_BY:
    case AirtableDataType.AUTO_NUMBER:
    case AirtableDataType.BUTTON:
    case AirtableDataType.AI_TEXT:
    case AirtableDataType.EXTERNAL_SYNC_SOURCE:
    case AirtableDataType.MULTIPLE_LOOKUP_VALUES:
      return true;

    default:
      return false;
  }
}

/**
 * Checks if a field is readonly.
 * @param field - The ID of the field to check.
 * @param tableSpec - The table specification.
 * @returns True if the field is readonly, false otherwise.
 */
export function isReadonlyField(field: string, tableSpec: BaseJsonTableSpec): boolean {
  return ValuePointer.Get(tableSpec.schema, `/properties/fields/properties/${field}/${READONLY_FLAG}`) === true;
}

/**
 * Checks if a field is a foreign key.
 * @param field - The ID of the field to check.
 * @param tableSpec - The table specification.
 * @returns True if the field is a foreign key, false otherwise.
 */
export function isForeignKey(field: string, tableSpec: BaseJsonTableSpec): boolean {
  return (
    ValuePointer.Has(tableSpec.schema, `/properties/fields/properties/${field}/${FOREIGN_KEY_OPTIONS}`) !== undefined
  );
}

/**
 * Gets the foreign key options for a field if they exist
 * @param field
 * @param tableSpec
 * @returns
 */
export function getForeignKeyOptions(field: string, tableSpec: BaseJsonTableSpec): ForeignKeyOptionSchema | undefined {
  return ValuePointer.Get(tableSpec.schema, `/properties/fields/properties/${field}/${FOREIGN_KEY_OPTIONS}`) as
    | ForeignKeyOptionSchema
    | undefined;
}
