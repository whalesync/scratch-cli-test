import { Type, type TSchema } from '@sinclair/typebox';
import {
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_READONLY,
  X_SCRATCH_REMOTE_FIELD_ID,
} from '@spinner/shared-types';
import { BaseJsonTableSpec, EntityId, idPath } from '../../types';
import { PipedriveApiClient } from './pipedrive-api-client';
import { ENTITY_CONFIG, ENTITY_DISPLAY_NAMES, PipedriveEntityType, PipedriveField } from './pipedrive-types';

/**
 * Read-only system field keys that should never be written to.
 */
const READONLY_SYSTEM_FIELDS = new Set(['id', 'add_time', 'update_time']);

/**
 * Convert a Pipedrive field type to a TypeBox schema.
 */
export function pipedriveFieldToJsonSchema(field: PipedriveField): TSchema | null {
  const fieldType = field.field_type;

  switch (fieldType) {
    case 'varchar':
    case 'text':
      return Type.Union([Type.String(), Type.Null()]);

    case 'varchar_auto':
      return Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true });

    case 'int':
      return Type.Union([Type.Number(), Type.Null()]);

    case 'double':
      return Type.Union([Type.Number(), Type.Null()]);

    case 'boolean':
      return Type.Union([Type.Boolean(), Type.Null()]);

    case 'date':
      return Type.Union([Type.String({ format: 'date' }), Type.Null()]);

    case 'time':
      return Type.Union([Type.String(), Type.Null()]);

    case 'daterange':
      return Type.Object({
        start_date: Type.Union([Type.String({ format: 'date' }), Type.Null()]),
        end_date: Type.Union([Type.String({ format: 'date' }), Type.Null()]),
      });

    case 'timerange':
      return Type.Object({
        start_time: Type.Union([Type.String(), Type.Null()]),
        end_time: Type.Union([Type.String(), Type.Null()]),
      });

    case 'phone':
      return Type.Array(
        Type.Object({
          value: Type.Union([Type.String(), Type.Null()]),
          primary: Type.Optional(Type.Boolean()),
          label: Type.Optional(Type.String()),
        }),
        { [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'phone' },
      );

    case 'monetary':
      return Type.Object(
        {
          value: Type.Union([Type.Number(), Type.Null()]),
          currency: Type.Union([Type.String(), Type.Null()]),
        },
        { [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'monetary' },
      );

    case 'address':
      return Type.Object(
        {
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          street_number: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          route: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          subpremise: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          locality: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          admin_area_level_1: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          admin_area_level_2: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          country: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          postal_code: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          formatted_address: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        },
        { [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'address' },
      );

    case 'enum': {
      if (field.options && field.options.length > 0) {
        const literals = field.options
          .filter((opt): opt is { id: number; label?: string } => opt.id !== undefined)
          .map((opt) => Type.Literal(opt.id, { title: opt.label ?? String(opt.id) }));
        if (literals.length > 0) {
          return Type.Union([...literals, Type.Null()]);
        }
      }
      return Type.Union([Type.Number(), Type.Null()]);
    }

    case 'set': {
      if (field.options && field.options.length > 0) {
        const literals = field.options
          .filter((opt): opt is { id: number; label?: string } => opt.id !== undefined)
          .map((opt) => Type.Literal(opt.id, { title: opt.label ?? String(opt.id) }));
        if (literals.length > 0) {
          return Type.Array(Type.Union(literals));
        }
      }
      return Type.Array(Type.Number());
    }

    case 'org':
      return Type.Union([Type.Number(), Type.Null()], {
        [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'organizations' },
      });

    case 'people':
      return Type.Union([Type.Number(), Type.Null()], {
        [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'persons' },
      });

    case 'deal':
      return Type.Union([Type.Number(), Type.Null()], {
        [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'deals' },
      });

    case 'user':
      return Type.Union([Type.Number(), Type.Null()], { [X_SCRATCH_READONLY]: true });

    case 'stage':
      return Type.Union([Type.Number(), Type.Null()]);

    case 'status':
      return Type.Union([Type.String(), Type.Null()]);

    case 'visible_to':
      return Type.Union([Type.Number(), Type.Null()]);

    case 'varchar_options':
      return Type.Union([Type.String(), Type.Null()]);

    case 'picture':
      return Type.Union(
        [
          Type.Object({
            url: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_READONLY]: true },
      );

    case 'json':
      return Type.Unknown();

    default:
      // For unknown field types, use a flexible string/null union
      return Type.Union([Type.String(), Type.Null()]);
  }
}

/**
 * Build a BaseJsonTableSpec from the Pipedrive Fields API response.
 * Custom fields are nested under a `custom_fields` property to mirror the v2 API structure.
 */
export async function buildPipedriveJsonTableSpec(
  id: EntityId,
  entityType: PipedriveEntityType,
  client: PipedriveApiClient,
): Promise<BaseJsonTableSpec> {
  const fields = await client.getFields(entityType);
  const config = ENTITY_CONFIG[entityType];

  const systemProperties: Record<string, TSchema> = {};
  const customProperties: Record<string, TSchema> = {};

  for (const field of fields) {
    const schema = pipedriveFieldToJsonSchema(field);
    if (!schema) continue;

    // Build annotations object
    const annotations: Record<string, unknown> = {
      description: field.field_name,
      [X_SCRATCH_REMOTE_FIELD_ID]: field.field_code,
    };

    // Mark system read-only fields
    if (READONLY_SYSTEM_FIELDS.has(field.field_code)) {
      annotations[X_SCRATCH_READONLY] = true;
    }

    // Merge annotations into the schema
    const annotatedSchema: TSchema = { ...schema, ...annotations };

    if (field.is_custom_field) {
      customProperties[field.field_code] = annotatedSchema;
    } else {
      systemProperties[field.field_code] = annotatedSchema;
    }
  }

  // Build the top-level schema
  const schemaProperties: Record<string, TSchema> = { ...systemProperties };

  // Add custom_fields as a nested object if there are any custom fields
  if (Object.keys(customProperties).length > 0) {
    schemaProperties['custom_fields'] = Type.Object(customProperties, {
      description: 'Custom fields',
    });
  }

  const schema = Type.Object(schemaProperties, {
    $id: `pipedrive/${entityType}`,
    title: ENTITY_DISPLAY_NAMES[entityType],
  });

  return {
    id,
    slug: id.wsId,
    name: ENTITY_DISPLAY_NAMES[entityType],
    schema,
    idColumnRemoteId: idPath(config.idField),
    titleColumnRemoteId: [config.titleField],
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}
