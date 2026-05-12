import { Type, type TSchema } from '@sinclair/typebox';
import { ValuePointer } from '@sinclair/typebox/value';
import {
  AssetFieldOptions,
  ForeignKeyOptionSchema,
  TransformerConfig,
  TransformerTypes,
  X_SCRATCH_ASSET_FIELD,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_READONLY,
  X_SCRATCH_REMOTE_FIELD_ID,
  X_SCRATCH_SUGGESTED_TRANSFORMER,
} from '@spinner/shared-types';
import { BaseJsonTableSpec, EntityId, idPath } from '../../types';
import { escapePointerToken } from '../../utils/json-pointer';
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
      titleColumnRemoteId = ['fields', field.name];
    }

    // Track main content column (first rich text field)
    if (!mainContentColumnRemoteId && (field.type as AirtableDataType) === AirtableDataType.RICH_TEXT) {
      mainContentColumnRemoteId = ['fields', field.name];
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
    idColumnRemoteId: idPath('id'),
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

    case AirtableDataType.MULTIPLE_LOOKUP_VALUES: {
      const lookupResultType = field.options?.result?.type as AirtableDataType | undefined;
      if (lookupResultType === AirtableDataType.MULTIPLE_ATTACHMENTS) {
        schema = multipleAttachmentsSchema(description);
      } else {
        schema = Type.Array(Type.String(), { description });
      }
      break;
    }

    case AirtableDataType.MULTIPLE_RECORD_LINKS:
      schema = Type.Array(Type.String(), {
        description,
        [X_SCRATCH_FOREIGN_KEY_OPTIONS]: field.options?.linkedTableId
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
      schema = multipleAttachmentsSchema(description);
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
    case AirtableDataType.LOOKUP: {
      const resultType = field.options?.result?.type as AirtableDataType | undefined;
      schema = formulaResultTypeToSchema(resultType, description);
      break;
    }

    default:
      schema = Type.Unknown({ description });
      break;
  }

  const connectorDataType = formulaConnectorDataType(field);
  schema[X_SCRATCH_CONNECTOR_DATA_TYPE] = connectorDataType;
  schema[X_SCRATCH_READONLY] = isAirtableColumnReadonly(field) ? true : undefined;
  schema[X_SCRATCH_REMOTE_FIELD_ID] = field.id;
  schema[X_SCRATCH_SUGGESTED_TRANSFORMER] = formulaSuggestedTransformer(connectorDataType) ?? undefined;
  return schema;
}

function multipleAttachmentsSchema(description: string): TSchema {
  return Type.Array(
    Type.Object({
      id: Type.String(),
      url: Type.String({ format: 'uri' }),
      filename: Type.Optional(Type.String()),
      size: Type.Optional(Type.Number()),
      type: Type.Optional(Type.String()),
    }),
    {
      description,
      [X_SCRATCH_ASSET_FIELD]: { idPath: 'id', urlExpires: true } satisfies AssetFieldOptions,
    },
  );
}

/**
 * Returns the CONNECTOR_DATA_TYPE value for a field.
 * For formula/rollup/lookup fields, appends the result type: e.g. "formula-number".
 */
function formulaConnectorDataType(field: AirtableFieldsV2): string {
  const type = field.type as AirtableDataType;
  if (type === AirtableDataType.FORMULA || type === AirtableDataType.ROLLUP || type === AirtableDataType.LOOKUP) {
    const resultType = field.options?.result?.type;
    if (resultType) {
      return `${field.type}-${resultType}`;
    }
  }
  return field.type;
}

/** Airtable returns formula errors as an object, e.g. { specialValue: "#ERROR!" } */
function formulaErrorSchema(): TSchema {
  return Type.Object({ specialValue: Type.String() });
}

/**
 * Maps an Airtable formula result type to a TypeBox schema.
 * Falls back to Type.Unknown for unrecognised or missing result types.
 */
function formulaResultTypeToSchema(resultType: AirtableDataType | undefined, description: string): TSchema {
  switch (resultType) {
    case AirtableDataType.SINGLE_LINE_TEXT:
    case AirtableDataType.MULTILINE_TEXT:
    case AirtableDataType.EMAIL:
    case AirtableDataType.URL:
    case AirtableDataType.PHONE_NUMBER:
    case AirtableDataType.RICH_TEXT:
      return Type.String({ description });

    case AirtableDataType.NUMBER:
    case AirtableDataType.PERCENT:
    case AirtableDataType.CURRENCY:
    case AirtableDataType.DURATION:
    case AirtableDataType.RATING:
      return Type.Union([Type.Number(), formulaErrorSchema()], { description });

    case AirtableDataType.AUTO_NUMBER:
    case AirtableDataType.COUNT:
      return Type.Union([Type.Integer(), formulaErrorSchema()], { description });

    case AirtableDataType.CHECKBOX:
      return Type.Boolean({ description });

    case AirtableDataType.DATE:
      return Type.Union([Type.String({ format: 'date' }), formulaErrorSchema()], { description });

    case AirtableDataType.DATE_TIME:
    case AirtableDataType.CREATED_TIME:
    case AirtableDataType.LAST_MODIFIED_TIME:
      return Type.Union([Type.String({ format: 'date-time' }), formulaErrorSchema()], { description });

    default:
      return Type.Unknown({ description });
  }
}

/**
 * Returns a suggested transformer for a formula field based on its connector data type,
 * or null if no suggestion applies.
 */
function formulaSuggestedTransformer(connectorDataType: string): TransformerConfig | null {
  if (
    connectorDataType.endsWith('-number') ||
    connectorDataType.endsWith('-currency') ||
    connectorDataType.endsWith('-percent') ||
    connectorDataType.endsWith('-duration') ||
    connectorDataType.endsWith('-rating') ||
    connectorDataType.endsWith('-autoNumber') ||
    connectorDataType.endsWith('-count')
  ) {
    return { type: TransformerTypes.EnsureType, options: { expectedType: 'number', onFailure: 'null' } };
  }
  if (
    connectorDataType.endsWith('-singleLineText') ||
    connectorDataType.endsWith('-multilineText') ||
    connectorDataType.endsWith('-email') ||
    connectorDataType.endsWith('-url') ||
    connectorDataType.endsWith('-phoneNumber') ||
    connectorDataType.endsWith('-richText')
  ) {
    return { type: TransformerTypes.EnsureType, options: { expectedType: 'string', onFailure: 'null' } };
  }
  return null;
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
  return (
    ValuePointer.Get(
      tableSpec.schema,
      `/properties/fields/properties/${escapePointerToken(field)}/${X_SCRATCH_READONLY}`,
    ) === true
  );
}

/**
 * Checks if a field is a foreign key.
 * @param field - The ID of the field to check.
 * @param tableSpec - The table specification.
 * @returns True if the field is a foreign key, false otherwise.
 */
export function isForeignKey(field: string, tableSpec: BaseJsonTableSpec): boolean {
  return (
    ValuePointer.Has(
      tableSpec.schema,
      `/properties/fields/properties/${escapePointerToken(field)}/${X_SCRATCH_FOREIGN_KEY_OPTIONS}`,
    ) !== undefined
  );
}

/**
 * Gets the foreign key options for a field if they exist
 * @param field
 * @param tableSpec
 * @returns
 */
export function getForeignKeyOptions(field: string, tableSpec: BaseJsonTableSpec): ForeignKeyOptionSchema | undefined {
  return ValuePointer.Get(
    tableSpec.schema,
    `/properties/fields/properties/${escapePointerToken(field)}/${X_SCRATCH_FOREIGN_KEY_OPTIONS}`,
  ) as ForeignKeyOptionSchema | undefined;
}
