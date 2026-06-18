import { Type, type TSchema } from '@sinclair/typebox';
import {
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_LAST_MODIFIED_FIELD,
  X_SCRATCH_READONLY,
  X_SCRATCH_REMOTE_FIELD_ID,
} from '@spinner/shared-types';
import { BaseJsonTableSpec, EntityId, idPath } from '../../types';
import { PipedriveApiClient } from './pipedrive-api-client';
import { STATIC_SYSTEM_SCHEMAS } from './pipedrive-static-schemas';
import { ENTITY_CONFIG, ENTITY_DISPLAY_NAMES, PipedriveEntityType, PipedriveField } from './pipedrive-types';

/** Read-only system fields present on (essentially) every Pipedrive entity. */
const COMMON_READONLY_SYSTEM_FIELDS: readonly string[] = ['id', 'add_time', 'update_time'];

/**
 * Per-entity read-only system fields, keyed on the stored record's field code, used to set
 * `X_SCRATCH_READONLY` on the schema so the UI marks them non-editable and the user sees a field
 * is non-writable before they edit it. Activities carry the extra entries because they are
 * read-only in Pipedrive v2: `person_id`/`org_id` are set through the writable `participants`
 * array, and `private`/`marked_as_done_time` are read-only system fields.
 */
const ENTITY_READONLY_FIELDS: Record<PipedriveEntityType, ReadonlySet<string>> = {
  deals: new Set(COMMON_READONLY_SYSTEM_FIELDS),
  persons: new Set(COMMON_READONLY_SYSTEM_FIELDS),
  organizations: new Set(COMMON_READONLY_SYSTEM_FIELDS),
  products: new Set(COMMON_READONLY_SYSTEM_FIELDS),
  activities: new Set([...COMMON_READONLY_SYSTEM_FIELDS, 'person_id', 'org_id', 'private', 'marked_as_done_time']),
  leads: new Set(COMMON_READONLY_SYSTEM_FIELDS),
  notes: new Set(COMMON_READONLY_SYSTEM_FIELDS),
  pipelines: new Set(COMMON_READONLY_SYSTEM_FIELDS),
  stages: new Set(COMMON_READONLY_SYSTEM_FIELDS),
};

/**
 * Per-entity field codes that Pipedrive's write API genuinely requires on create
 * and that are always present on an existing record's GET response. These are the
 * ONLY fields that belong in the schema's `required` array.
 *
 * Everything else is optional by default (see {@link buildPipedriveJsonTableSpec}).
 * We store the verbatim Pipedrive GET response, so most fields are legitimately
 * null/absent on any given record; marking them all `required` (TypeBox's default
 * for `Type.Object`) produced false-positive "required but missing" validation
 * errors and, worse, marked read-only fields (`id`, `update_time`, …) as both
 * required AND read-only — an impossible-to-satisfy combination. For anything not
 * listed here, the Pipedrive write API stays the final backstop. (DEV-10453)
 *
 * Invariant: every code listed here MUST be a writable field. A read-only field
 * can never be required; {@link buildPipedriveJsonTableSpec} enforces this by
 * dropping any read-only field from the computed `required` array.
 *
 * Custom fields are never required — we have no introspected mandatory metadata
 * for them, so they default to optional. (A future enhancement could derive this
 * map from the Fields endpoint's mandatory flag instead of hardcoding it.)
 */
const ENTITY_REQUIRED_FIELDS: Record<PipedriveEntityType, ReadonlySet<string>> = {
  deals: new Set(['title']),
  persons: new Set(['name']),
  organizations: new Set(['name']),
  products: new Set(['name']),
  // Activities: `subject` is optional on create in v2 (Pipedrive auto-generates it
  // from the activity type when omitted), so nothing is required.
  activities: new Set<string>(),
  leads: new Set(['title']),
  notes: new Set(['content']),
  pipelines: new Set(['name']),
  stages: new Set(['name', 'pipeline_id']),
};

/** Whether a field schema has been annotated read-only via {@link X_SCRATCH_READONLY}. */
function isFieldSchemaReadonly(fieldSchema: TSchema): boolean {
  return (fieldSchema as { [X_SCRATCH_READONLY]?: unknown })[X_SCRATCH_READONLY] === true;
}

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
      return Type.Union([Type.Number(), Type.Null()], {
        [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'stages' },
      });

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
 * Build a BaseJsonTableSpec for a Pipedrive entity.
 *
 * System fields come from one of two sources depending on the entity config:
 * - **Dynamic** (deals/persons/organizations/products/activities): discovered
 *   from the entity's v2 `*Fields` endpoint, so user-added fields appear
 *   automatically.
 * - **Static** (leads/notes): hardcoded in {@link STATIC_SYSTEM_SCHEMAS} because
 *   the API exposes no Fields endpoint for them.
 *
 * Custom fields (when the entity has a `*Fields` endpoint) are always taken
 * dynamically and placed according to `customFieldPlacement`: `nested` under a
 * `custom_fields` object for v2 entities, or `flat` (top-level hash keys) for v1
 * entities like leads, matching how each API returns and accepts them.
 */
export async function buildPipedriveJsonTableSpec(
  id: EntityId,
  entityType: PipedriveEntityType,
  client: PipedriveApiClient,
): Promise<BaseJsonTableSpec> {
  const config = ENTITY_CONFIG[entityType];

  const systemProperties: Record<string, TSchema> = {};
  const customProperties: Record<string, TSchema> = {};

  // 1. Static system fields (leads, notes) — entities without a Fields endpoint
  //    (or, for leads, without an introspectable system shape).
  const staticSystemSchema = STATIC_SYSTEM_SCHEMAS[entityType];
  if (staticSystemSchema) {
    for (const [fieldCode, fieldSchema] of Object.entries(staticSystemSchema)) {
      systemProperties[fieldCode] = {
        description: fieldCode,
        [X_SCRATCH_REMOTE_FIELD_ID]: fieldCode,
        ...fieldSchema,
      };
    }
  }

  // 2. Dynamic fields from the Fields endpoint. For dynamic-system entities this
  //    supplies both system and custom fields; for leads it supplies only custom
  //    fields (the static system schema above wins for system fields).
  if (config.fieldsCollectionPath) {
    const fields = await client.getFields(entityType);
    for (const field of fields) {
      const schema = pipedriveFieldToJsonSchema(field);
      if (!schema) continue;

      // Build annotations object
      const annotations: Record<string, unknown> = {
        description: field.field_name,
        [X_SCRATCH_REMOTE_FIELD_ID]: field.field_code,
      };

      // Mark read-only system fields so the UI surfaces them as non-editable and the user
      // sees the field is non-writable before they edit it. For v2 activities this includes
      // `person_id`/`org_id` — read-only relations set via the writable `participants` array.
      if (ENTITY_READONLY_FIELDS[entityType].has(field.field_code)) {
        annotations[X_SCRATCH_READONLY] = true;
      }

      // Annotate the fixed `update_time` system field for the UI's
      // last-modified-field picker and the auto-detect path
      // (findLastModifiedFieldName). The connector hardcodes `update_time` for
      // incremental pulls (it is a fixed system field on every Pipedrive entity);
      // the annotation surfaces that field to the picker.
      if (field.field_code === 'update_time') {
        annotations[X_SCRATCH_LAST_MODIFIED_FIELD] = true;
      }

      // Deals reference their pipeline via a plain numeric `pipeline_id`
      // (field_type `double`, so there's no type-based hook like `stage`); wire
      // it as a foreign key to the pipelines table.
      if (field.field_code === 'pipeline_id') {
        annotations[X_SCRATCH_FOREIGN_KEY_OPTIONS] = { linkedTableId: 'pipelines' };
      }

      // Merge annotations into the schema
      const annotatedSchema: TSchema = { ...schema, ...annotations };

      if (field.is_custom_field) {
        customProperties[field.field_code] = annotatedSchema;
      } else if (config.useDynamicSystemFields) {
        systemProperties[field.field_code] = annotatedSchema;
      }
      // else: an entity with a static system schema (leads) — ignore the Fields
      // endpoint's system fields; only its custom fields are used.
    }
  }

  // 3. Assemble the top-level schema, placing custom fields per the config.
  const schemaProperties: Record<string, TSchema> = { ...systemProperties };
  if (Object.keys(customProperties).length > 0) {
    if (config.customFieldPlacement === 'nested') {
      // v2 entities nest custom fields under a `custom_fields` object. Custom
      // fields are optional by default, so drop the `required` array TypeBox adds.
      const customFieldsObject = Type.Object(customProperties, {
        description: 'Custom fields',
      });
      delete customFieldsObject.required;
      schemaProperties['custom_fields'] = customFieldsObject;
    } else {
      // v1 entities (leads) carry custom fields as top-level hash keys.
      Object.assign(schemaProperties, customProperties);
    }
  }

  const schema = Type.Object(schemaProperties, {
    $id: `pipedrive/${entityType}`,
    title: ENTITY_DISPLAY_NAMES[entityType],
  });

  // Pipedrive fields are optional by default. TypeBox's `Type.Object` marks every
  // property `required`; replace that with only the fields Pipedrive genuinely
  // requires on create, and never a read-only field (the read-only ⇒ not-required
  // invariant). Anything else is optional and the Pipedrive write API is the
  // final backstop. See ENTITY_REQUIRED_FIELDS. (DEV-10453)
  const requiredFieldNames = [...ENTITY_REQUIRED_FIELDS[entityType]].filter(
    (fieldCode) => fieldCode in schemaProperties && !isFieldSchemaReadonly(schemaProperties[fieldCode]),
  );
  if (requiredFieldNames.length > 0) {
    schema.required = requiredFieldNames;
  } else {
    delete schema.required;
  }

  return {
    id,
    slug: id.wsId,
    name: ENTITY_DISPLAY_NAMES[entityType],
    schema,
    idColumnRemoteId: idPath(config.idField),
    titleColumnRemoteId: config.titleField ? [config.titleField] : undefined,
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}
