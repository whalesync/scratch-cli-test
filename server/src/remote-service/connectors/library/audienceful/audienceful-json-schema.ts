import { Type, type TSchema } from '@sinclair/typebox';
import { ValuePointer } from '@sinclair/typebox/value';
import { FOREIGN_KEY_OPTIONS, ForeignKeyOptionSchema, READONLY_FLAG } from '../../json-schema';
import { BaseJsonTableSpec, EntityId } from '../../types';
import { AudiencefulField } from './audienceful-types';

/**
 * Build a BaseJsonTableSpec for the Audienceful People table.
 * Generates a JSON Schema describing the raw Audienceful person API response format.
 */
export function buildAudiencefulJsonTableSpec(id: EntityId, customFields: AudiencefulField[]): BaseJsonTableSpec {
  const schema = buildPeopleSchema(customFields);

  return {
    id,
    slug: id.wsId,
    name: 'People',
    schema,
    idColumnRemoteId: 'uid',
    titleColumnRemoteId: ['email'],
    mainContentColumnRemoteId: ['notes'],
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Build the TypeBox schema for a person record.
 */
function buildPeopleSchema(customFields: AudiencefulField[]): TSchema {
  // Standard fields
  const properties: Record<string, TSchema> = {
    id: Type.Integer({ description: 'Numeric database ID for the person', [READONLY_FLAG]: true }),
    uid: Type.String({ description: 'Unique identifier for the person', [READONLY_FLAG]: true }),
    email: Type.String({ description: 'Email address', format: 'email' }),
    tags: Type.Array(
      Type.Object(
        {
          id: Type.Optional(Type.Integer({ description: 'Tag ID (auto-generated, not required for create/update)' })),
          name: Type.String({ description: 'Tag name (required)' }),
          color: Type.Optional(Type.String({ description: 'Tag color (defaults to pink if not specified)' })),
        },
        { additionalProperties: false },
      ),
      { description: 'Tags applied to this person. Only name is required when adding new tags.' },
    ),
    notes: Type.Optional(
      Type.Union([Type.String(), Type.Null()], {
        description: 'Notes about this person. Accepts HTML or plain text.',
      }),
    ),
    extra_data: Type.Record(Type.String(), Type.Unknown(), {
      description: 'Additional custom field data stored for this person (e.g., first_name, last_name)',
    }),
    status: Type.Union(
      [Type.Literal('active'), Type.Literal('unconfirmed'), Type.Literal('bounced'), Type.Literal('unsubscribed')],
      { description: 'Subscription status', [READONLY_FLAG]: true },
    ),
    source: Type.Optional(
      Type.Union([Type.String(), Type.Null()], {
        description: 'How the person was added (import, manual, api, form, etc.)',
        [READONLY_FLAG]: true,
      }),
    ),
    created_at: Type.String({
      description: 'When the person was created',
      format: 'date-time',
      [READONLY_FLAG]: true,
    }),
    updated_at: Type.String({
      description: 'When the person was last updated',
      format: 'date-time',
      [READONLY_FLAG]: true,
    }),
    last_activity: Type.String({
      description: 'When the person was last active',
      format: 'date-time',
      [READONLY_FLAG]: true,
    }),
    unsubscribed: Type.Optional(
      Type.Union([Type.String({ format: 'date-time' }), Type.Null()], {
        description: 'When the person unsubscribed, or null if still subscribed',
        [READONLY_FLAG]: true,
      }),
    ),
    country: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'Country of the person' })),
    double_opt_in: Type.Union([Type.Literal('not_required'), Type.Literal('required'), Type.Literal('complete')], {
      description: 'Email confirmation status',
      [READONLY_FLAG]: true,
    }),
    bounced: Type.Boolean({ description: 'Whether the email address has bounced', [READONLY_FLAG]: true }),
    open_rate: Type.Optional(
      Type.Union([Type.Number(), Type.Null()], {
        description: 'Email open rate for this person',
        [READONLY_FLAG]: true,
      }),
    ),
    click_rate: Type.Optional(
      Type.Union([Type.Number(), Type.Null()], {
        description: 'Email click rate for this person',
        [READONLY_FLAG]: true,
      }),
    ),
  };

  // Add custom fields (skip built-in fields)
  const builtInFields = Object.keys(properties);
  for (const field of customFields) {
    if (builtInFields.includes(field.data_name)) continue;
    const fieldSchema = fieldTypeToSchema(field);
    if (!field.editable) {
      fieldSchema[READONLY_FLAG] = true;
    }
    properties[field.data_name] = field.required ? fieldSchema : Type.Optional(fieldSchema);
  }

  return Type.Object(properties, {
    $id: 'audienceful/people',
    title: 'People',
  });
}

/**
 * Convert an Audienceful field type to a TypeBox schema.
 */
function fieldTypeToSchema(field: AudiencefulField): TSchema {
  const description = field.name;

  switch (field.type) {
    case 'string':
      return Type.Union([Type.String(), Type.Null()], { description });
    case 'number':
      return Type.Union([Type.Number(), Type.Null()], { description });
    case 'date':
      return Type.Union([Type.String({ format: 'date-time' }), Type.Null()], { description });
    case 'boolean':
      return Type.Union([Type.Boolean(), Type.Null()], { description });
    case 'tag':
      // Tags are stored as an array of objects - only name is required for create/update
      return Type.Array(
        Type.Object({
          id: Type.Optional(Type.Integer()),
          name: Type.String(),
          color: Type.Optional(Type.String()),
        }),
        { description },
      );
    default:
      return Type.Unknown({ description });
  }
}

/**
 * Checks if a field is readonly.
 * @param field - The field name (e.g. "uid", "created_at").
 * @param tableSpec - The table specification.
 * @returns True if the field is readonly, false otherwise.
 */
export function isReadonlyField(field: string, tableSpec: BaseJsonTableSpec): boolean {
  return ValuePointer.Get(tableSpec.schema, `/properties/${field}/${READONLY_FLAG}`) === true;
}

/**
 * Checks if a field is a foreign key.
 * @param field - The field name.
 * @param tableSpec - The table specification.
 * @returns True if the field is a foreign key, false otherwise.
 */
export function isForeignKey(field: string, tableSpec: BaseJsonTableSpec): boolean {
  return ValuePointer.Has(tableSpec.schema, `/properties/${field}/${FOREIGN_KEY_OPTIONS}`) !== undefined;
}

/**
 * Gets the foreign key options for a field if they exist.
 * @param field - The field name.
 * @param tableSpec - The table specification.
 * @returns The foreign key options, or undefined if the field is not a foreign key.
 */
export function getForeignKeyOptions(field: string, tableSpec: BaseJsonTableSpec): ForeignKeyOptionSchema | undefined {
  return ValuePointer.Get(tableSpec.schema, `/properties/${field}/${FOREIGN_KEY_OPTIONS}`) as
    | ForeignKeyOptionSchema
    | undefined;
}
