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
  X_SCRATCH_LAST_MODIFIED_FIELD,
  X_SCRATCH_READONLY,
  X_SCRATCH_REMOTE_FIELD_ID,
  X_SCRATCH_SUGGESTED_TRANSFORMER,
} from '@spinner/shared-types';
import { BaseJsonTableSpec, DotPath, EntityId, dotPath } from '../../types';
import { escapePointerToken } from '../../utils/json-pointer';
import {
  AirtableBase,
  AirtableDataType,
  AirtableFieldsV2,
  AirtableTableV2,
  X_SCRATCH_AIRTABLE_FIELD_ORDER,
  X_SCRATCH_AIRTABLE_LOOKUP_RESULT_TYPE,
} from './airtable-types';

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
  let titlePath: DotPath | undefined;
  let mainContentPath: DotPath | undefined;

  for (const field of table.fields) {
    const fieldSchema = airtableFieldToJsonSchema(field);
    // All Airtable fields are optional in the response (can be missing if empty)
    fieldProperties[field.name] = Type.Optional(fieldSchema);

    // Track title column (primary field)
    if (field.id === table.primaryFieldId) {
      titlePath = dotPath(['fields', field.name].join('.'));
    }

    // Track main content column (first rich text field)
    if (!mainContentPath && (field.type as AirtableDataType) === AirtableDataType.RICH_TEXT) {
      mainContentPath = dotPath(['fields', field.name].join('.'));
    }
  }

  // Airtable raw record schema: { id, fields, createdTime }. The `fields` node
  // carries the true API field order (field names can be numeric, which JS object
  // key iteration would reorder — see X_SCRATCH_AIRTABLE_FIELD_ORDER).
  const schema = Type.Object(
    {
      id: Type.String({ description: 'Unique record identifier' }),
      fields: Type.Object(fieldProperties, {
        description: 'Record field values keyed by field name',
        [X_SCRATCH_AIRTABLE_FIELD_ORDER]: table.fields.map((field) => field.name),
      }),
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
    idPath: dotPath('id'),
    titlePath,
    mainContentPath,
    basePath: [base.name],
    // Deep link to the table in Airtable's web UI, e.g.
    // https://airtable.com/appXXXX/tblYYYY/
    remoteWebUrl: `https://airtable.com/${baseId}/${tableId}`,
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
      schema = Type.String({ description, format: airtableFieldHasTime(field) ? 'date-time' : 'date' });
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
        // A lookup surfaces an array of the looked-up field's values, so type the
        // items by the lookup's result type (reusing the formula/rollup mapping).
        // This covers looked-up aiText objects and per-item formula errors, which a
        // flat Array(String) would wrongly reject; exotic result types fall back to
        // Unknown items — strictly fewer false positives than String.
        schema = Type.Array(formulaResultTypeToSchema(lookupResultType, description), { description });
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

    case AirtableDataType.AI_TEXT:
      schema = aiTextSchema(description);
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
  // A lookup's connector-data-type is the bare "multipleLookupValues" (no result
  // suffix, unlike formula/rollup/lookup), so record its lookup result type
  // separately — the default-view builder needs it to decide whether the column
  // is flattened with the computed-field display transformer.
  if ((field.type as AirtableDataType) === AirtableDataType.MULTIPLE_LOOKUP_VALUES) {
    const lookupResultType = field.options?.result?.type;
    schema[X_SCRATCH_AIRTABLE_LOOKUP_RESULT_TYPE] = lookupResultType ?? undefined;
  }
  if ((field.type as AirtableDataType) === AirtableDataType.LAST_MODIFIED_TIME) {
    schema[X_SCRATCH_LAST_MODIFIED_FIELD] = true;
  }
  return schema;
}

/**
 * Whether an Airtable date-bearing field carries a time component. CREATED_TIME /
 * LAST_MODIFIED_TIME (and DATE_TIME) can be configured date-only, in which case
 * Airtable returns "YYYY-MM-DD" — which fails a `date-time` format check. For the
 * computed created/modified fields the discriminator is the result field's type
 * under `options.result` ('dateTime' = has time, 'date' = date-only). Falls back to
 * `true` (date-time) when the signal is absent, preserving prior behavior and never
 * introducing a new error for data that already validated.
 */
function airtableFieldHasTime(field: AirtableFieldsV2): boolean {
  const resultType = field.options?.result?.type as AirtableDataType | undefined;
  if (resultType === AirtableDataType.DATE) return false;
  if (resultType === AirtableDataType.DATE_TIME) return true;
  return true;
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
 * Airtable `aiText` field value. The API returns an object, e.g.
 * `{ state: "generated", value: "…", isStale: true }`. `value` is string-or-null
 * (null while empty / not yet generated); observed `state` values include
 * "generated" and "empty". Extra keys (e.g. `errorType` on failed generations)
 * still validate — TypeBox `Type.Object` does not set `additionalProperties: false`
 * — which is what we want for a readonly, service-computed source field.
 */
function aiTextSchema(description: string): TSchema {
  return Type.Object(
    {
      state: Type.String(),
      value: Type.Union([Type.String(), Type.Null()]),
      isStale: Type.Optional(Type.Boolean()),
    },
    { description },
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

/**
 * Airtable returns formula / rollup / lookup errors as an object in one of two
 * shapes: `{ error: "#ERROR!" }` (formula evaluation error) or
 * `{ specialValue: "NaN" }` (numeric special values). Accept either so a raw
 * error value passes schema conformance instead of flooding `enforce_schema`.
 */
function formulaErrorSchema(): TSchema {
  return Type.Union([Type.Object({ error: Type.String() }), Type.Object({ specialValue: Type.String() })]);
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
      return Type.Union([Type.String(), formulaErrorSchema()], { description });

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
      return Type.Union([Type.Boolean(), formulaErrorSchema()], { description });

    case AirtableDataType.AI_TEXT:
      return Type.Union([aiTextSchema(description), formulaErrorSchema()], { description });

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
