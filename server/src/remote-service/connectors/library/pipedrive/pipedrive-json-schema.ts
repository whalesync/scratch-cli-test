import { Type, type TSchema } from '@sinclair/typebox';
import {
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_LAST_MODIFIED_FIELD,
  X_SCRATCH_READONLY,
  X_SCRATCH_REMOTE_FIELD_ID,
} from '@spinner/shared-types';
import { BaseJsonTableSpec, EntityId, dotPath } from '../../types';
import { PipedriveApiClient } from './pipedrive-api-client';
import { STATIC_SYSTEM_SCHEMAS } from './pipedrive-static-schemas';
import {
  ENTITY_CONFIG,
  ENTITY_DISPLAY_NAMES,
  PipedriveApiVersion,
  PipedriveEntityType,
  PipedriveField,
} from './pipedrive-types';

/** Read-only system fields present on (essentially) every Pipedrive entity. */
const COMMON_READONLY_SYSTEM_FIELDS: readonly string[] = ['id', 'add_time', 'update_time'];

/**
 * Pipedrive's "empty date" sentinels. Instead of `null`, Pipedrive can return a
 * placeholder date string for an unset date field (most visibly `birthday`): the
 * raw zero-date `"0000-00-00"`, and the value `"-0001-11-30"` — that same zero-date
 * normalised into the proleptic Gregorian calendar (year 0000 → -0001, and the day
 * before the epoch is Nov 30). Both are legitimate verbatim API output, not corrupt
 * data, but neither satisfies `format: 'date'`, so a record carrying one fails the
 * CLI's enforce_schema validator (`should_validate_formats(true)`).
 *
 * Per "preserve external data fidelity", we admit these verbatim sentinels rather
 * than reshaping the stored value — the `'date'` union accepts a well-formed date,
 * either empty sentinel, or `null`. (DEV-10453, Pipedrive zero-date birthdays.)
 */
const PIPEDRIVE_EMPTY_DATE_SENTINELS: readonly string[] = ['0000-00-00', '-0001-11-30'];

/**
 * Decide whether a Pipedrive `field_type: 'date'` field actually holds a full
 * RFC 3339 date-time rather than a `YYYY-MM-DD` date-only value.
 *
 * Pipedrive types BOTH true date-only fields and full-timestamp system fields as
 * `field_type: 'date'`, but returns the latter as date-times like
 * `"2026-06-04T14:14:02Z"`. Mapping every `'date'` field to `format: 'date'` makes
 * those timestamp fields fail format validation on otherwise-verbatim records,
 * flooding the validator with false positives (DEV-10453, finding 3).
 *
 * Pipedrive's own naming convention separates the two cleanly: timestamp system
 * fields end in `_time` (`add_time`, `update_time`, `marked_as_done_time`,
 * `won_time`, `lost_time`, `close_time`, `stage_change_time`, …), while date-only
 * fields end in `_date` (`due_date`, `expected_close_date`) or are custom fields
 * (40-char hash codes that never end in `_time`). Clock-time fields like `due_time`
 * are `field_type: 'time'`, so they are handled by `case 'time'` and never reach
 * the `'date'` case. Reading the field code (metadata) — rather than sniffing the
 * stored value — keeps this connector-local and generalises across every entity.
 */
function pipedriveDateFieldHoldsDateTime(field: PipedriveField): boolean {
  return field.field_code.endsWith('_time');
}

/**
 * Wrap a composite object/array schema in a nullable union, placing any annotations on the
 * OUTER union (a sibling of `anyOf`), mirroring `case 'picture'`. Pipedrive returns `null`
 * for an empty composite field (address/monetary/daterange/timerange), so a verbatim record
 * only validates if the schema admits `null`. The frontend reads `x-scratch-connector-data-type`
 * as a sibling key and unwraps nullable unions, so the annotation must live on the union, not
 * the inner object. (DEV-10453, finding 3)
 */
function nullableCompositeFieldSchema(objectSchema: TSchema, annotations: Record<string, unknown> = {}): TSchema {
  return Type.Union([objectSchema, Type.Null()], annotations);
}

/**
 * Stored shapes for the handful of stable system field codes whose Pipedrive metadata
 * `field_type` does NOT describe their verbatim v2 shape. Pipedrive has no dedicated
 * `email`/`participants` field type (both arrive as `varchar`/default → `string | null`),
 * and `project_id` is reported as a string-ish type but stored as a number. Keying on the
 * field code — the same mechanism the builder already uses for `update_time`/`pipeline_id`
 * and the ENTITY_* maps — is more robust than trusting the (ambiguous) metadata type.
 *
 * Returns `null` when the field code has no override, so the caller falls through to the
 * normal `field_type` switch. (DEV-10453, finding 3)
 */
function pipedriveFieldCodeOverrideSchema(field: PipedriveField): TSchema | null {
  switch (field.field_code) {
    // Person/organization multi-value email: `[{label?, value, primary?}]` (may be `[]`).
    // Mirrors the `phone` array shape (`case 'phone'`); Pipedrive exposes no `email` type.
    case 'email':
    case 'emails':
      return Type.Array(
        Type.Object({
          value: Type.Union([Type.String(), Type.Null()]),
          primary: Type.Optional(Type.Boolean()),
          label: Type.Optional(Type.String()),
        }),
        { [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'email' },
      );

    // Activity participants: `[{person_id, primary?}]` (may be `[]`).
    case 'participants':
      return Type.Array(
        Type.Object({
          person_id: Type.Number(),
          primary: Type.Optional(Type.Boolean()),
        }),
      );

    // Activity project link: a plain numeric Pipedrive Projects id (Projects aren't a Scratch
    // table), stored as a number — not the string its metadata field_type implies.
    case 'project_id':
      return Type.Union([Type.Number(), Type.Null()]);

    default:
      return null;
  }
}

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
export function pipedriveFieldToJsonSchema(
  field: PipedriveField,
  { apiVersion }: { apiVersion?: PipedriveApiVersion } = {},
): TSchema | null {
  // Stable system field codes whose verbatim v2 shape the metadata field_type misdescribes
  // win over the type-based switch below (e.g. `emails`/`participants` are arrays, not strings).
  const fieldCodeOverrideSchema = pipedriveFieldCodeOverrideSchema(field);
  if (fieldCodeOverrideSchema) return fieldCodeOverrideSchema;

  // Leads use the v1 API, which returns the composite custom-field types in a different verbatim
  // shape than v2: `monetary` is a bare number (not a `{value, currency}` object) and `set` is a
  // comma-joined id string (not an array). Map those shapes so leads records validate; every other
  // field type shares the v2 mapping below. (DEV-10453 follow-up)
  if (apiVersion === 'v1' && field.is_custom_field) {
    switch (field.field_type) {
      case 'monetary':
        return Type.Union([Type.Number(), Type.Null()]);
      case 'set':
        return Type.Union([Type.String(), Type.Null()]);
      default:
        break;
    }
  }

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

    case 'date': {
      // Timestamp-valued system fields (`add_time`, `update_time`, `marked_as_done_time`, …)
      // are typed `'date'` by Pipedrive but return RFC 3339 date-times, so they need
      // `format: 'date-time'`; true date-only fields keep `format: 'date'`.
      if (pipedriveDateFieldHoldsDateTime(field)) {
        return Type.Union([Type.String({ format: 'date-time' }), Type.Null()]);
      }
      // Date-only fields may instead carry an empty-date sentinel (`"0000-00-00"` /
      // `"-0001-11-30"`) in place of `null`; admit those verbatim alongside a real date.
      return Type.Union([
        Type.String({ format: 'date' }),
        ...PIPEDRIVE_EMPTY_DATE_SENTINELS.map((sentinel) => Type.Literal(sentinel)),
        Type.Null(),
      ]);
    }

    case 'time':
      // In Pipedrive v2 a CUSTOM time field is a `{value, timezone_id, timezone_name}` object,
      // while the SYSTEM time field (`due_time`) is a plain "HH:MM" string. Typing a custom field
      // as a string floods verbatim records (the object) with anyOf errors. Both shapes are
      // nullable — Pipedrive returns `null` for an empty time field. Mirrors `case 'monetary'`.
      if (field.is_custom_field) {
        return nullableCompositeFieldSchema(
          Type.Object({
            value: Type.Union([Type.String(), Type.Null()]),
            timezone_id: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
            timezone_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          { [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'time' },
        );
      }
      return Type.Union([Type.String(), Type.Null()]);

    // The v2 API's verbatim range shapes are `{value, until}` — NOT the `{start_date,end_date}` /
    // `{start_time,end_time}` shapes the docs suggest (the write API rejects those with
    // ERR_SCHEMA_VALIDATION_FAILED). `timerange` additionally carries the timezone pair, mirroring
    // the custom `time` case above. Probed live on both GET and write. (DEV-11032)
    case 'daterange':
      return nullableCompositeFieldSchema(
        Type.Object({
          value: Type.Union([Type.String({ format: 'date' }), Type.Null()]),
          until: Type.Union([Type.String({ format: 'date' }), Type.Null()]),
        }),
        { [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'daterange' },
      );

    case 'timerange':
      return nullableCompositeFieldSchema(
        Type.Object({
          value: Type.Union([Type.String(), Type.Null()]),
          until: Type.Union([Type.String(), Type.Null()]),
          timezone_id: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
          timezone_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        { [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'timerange' },
      );

    case 'phone':
      // In Pipedrive v2 only the SYSTEM phone field (persons'/organizations' `phone`) is the
      // multi-value `[{value, primary, label}]` array; a CUSTOM phone field is a bare string
      // (e.g. a deal's `"+34 915 000 000"`). Typing a custom phone as an array both floods
      // verbatim records with anyOf errors AND makes the default view attach its `$[*].value`
      // join_comma jsonpath codec, which JSON-parses the bare string, throws, and aborts the whole
      // table's sync (DEV-11042). Drop the `phone` annotation on the string shape so the view never
      // treats it as an array. Mirrors `case 'monetary'`/`case 'time'`.
      if (field.is_custom_field) {
        return Type.Union([Type.String(), Type.Null()]);
      }
      return Type.Array(
        Type.Object({
          value: Type.Union([Type.String(), Type.Null()]),
          primary: Type.Optional(Type.Boolean()),
          label: Type.Optional(Type.String()),
        }),
        { [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'phone' },
      );

    case 'monetary':
      // In Pipedrive v2 only CUSTOM monetary fields are `{value, currency}` objects; the SYSTEM
      // monetary fields (`value`/`acv`/`arr`/`mrr`) are plain decimal numbers paired with a single
      // root-level `currency` string (per the v2 migration guide). Typing a system field as an
      // object floods verbatim records (`value: 15000`) with "is not of type object" errors. Both
      // shapes are nullable — Pipedrive returns `null` for an empty monetary field. (DEV-10453)
      if (field.is_custom_field) {
        return nullableCompositeFieldSchema(
          Type.Object({
            value: Type.Union([Type.Number(), Type.Null()]),
            currency: Type.Union([Type.String(), Type.Null()]),
          }),
          { [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'monetary' },
        );
      }
      return Type.Union([Type.Number(), Type.Null()]);

    case 'address':
      return nullableCompositeFieldSchema(
        Type.Object({
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
        }),
        { [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'address' },
      );

    case 'enum': {
      const definedOptions = (field.options ?? []).filter(
        (opt): opt is { id: number | string; label?: string } => opt.id !== undefined,
      );
      if (definedOptions.length > 0) {
        const literals = definedOptions.map((opt) => Type.Literal(opt.id, { title: opt.label ?? String(opt.id) }));
        // Open the enum: keep the discovered options as UI suggestions (their `title`) but admit
        // any verbatim value of the same base type, so a value outside the current option set still
        // validates — Pipedrive default/deleted/disabled options and options added after schema
        // generation (e.g. activity `type` key_strings). Preserves external data fidelity. Option
        // ids are numeric for custom selects but key_strings for the activity `type` field.
        const baseScalar = typeof definedOptions[0].id === 'string' ? Type.String() : Type.Number();
        return Type.Union([...literals, baseScalar, Type.Null()]);
      }
      return Type.Union([Type.Number(), Type.Null()]);
    }

    case 'set': {
      const definedOptions = (field.options ?? []).filter(
        (opt): opt is { id: number | string; label?: string } => opt.id !== undefined,
      );
      if (definedOptions.length > 0) {
        const literals = definedOptions.map((opt) => Type.Literal(opt.id, { title: opt.label ?? String(opt.id) }));
        // Open the item union (see `case 'enum'`): admit verbatim option ids outside the current
        // set so deleted/added options still validate. The array itself stays as-is — an empty set
        // is `null`, which the validator skips as a verbatim blank.
        const baseScalar = typeof definedOptions[0].id === 'string' ? Type.String() : Type.Number();
        return Type.Array(Type.Union([...literals, baseScalar]));
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
      // Pipedrive v2 returns `picture_id` as a bare numeric id; the legacy/object shape (`{url}`)
      // may also appear. Admit both (plus null) so verbatim records validate either way.
      return Type.Union(
        [
          Type.Number(),
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
      const schema = pipedriveFieldToJsonSchema(field, { apiVersion: config.apiVersion });
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
    idPath: dotPath(config.idField),
    titlePath: config.titleField ? dotPath(config.titleField) : undefined,
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}
