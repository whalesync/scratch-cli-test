import { Type, type TObject, type TSchema } from '@sinclair/typebox';
import {
  X_SCRATCH_AGENT_INSTRUCTIONS,
  X_SCRATCH_ARRAY_KEYED_BY,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { BaseJsonTableSpec, EntityId, dotPath } from '../../types';
import {
  CUSTOM_FIELD_KEY_FIELD,
  buildCopperCustomFieldsArrayKeyedByOptions,
  isReadonlyCopperCustomField,
} from './copper-custom-fields';
import {
  COPPER_ENTITY_CONFIG,
  COPPER_REFERENCE_ENTITY_CONFIG,
  CopperCustomFieldDefinition,
  CopperEntityType,
  CopperReferenceEntityType,
} from './copper-types';

/**
 * Builds the JSON schema for each Copper entity.
 *
 * Copper has no system-field metadata endpoint, so the system fields below are
 * declared statically (the "hardcode only when the API offers no introspection"
 * rule). User-defined custom fields ARE discovered dynamically via
 * `GET /custom_field_definitions`.
 *
 * Copper returns custom-field values as a verbatim
 * `custom_fields: [{ custom_field_definition_id, value }]` array, which we store
 * exactly as-is. The array is annotated with `x-scratch-array-keyed-by` so the
 * generic engines expose each element as its own editable column addressed by
 * `custom_field_definition_id` (see {@link ./copper-custom-fields}) — no reshape
 * on disk — gathered under a "Custom Fields" banner in the default view
 * (see `CopperConnector.buildDefaultView`).
 */

// --- Field helpers ---

const nullableString = (): TSchema => Type.Union([Type.String(), Type.Null()]);
const nullableNumber = (): TSchema => Type.Union([Type.Number(), Type.Null()]);

/** Mark a field read-only (computed / system-managed — never sent on write). */
function readonly(schema: TSchema): TSchema {
  return { ...schema, [X_SCRATCH_READONLY]: true };
}

/** A numeric foreign key pointing at another Copper table (by wsId). */
function foreignKey(linkedTableId: CopperEntityType | CopperReferenceEntityType): TSchema {
  return Type.Union([Type.Number(), Type.Null()], {
    // listTables builds remoteId: [entityType]/[refType], so the target table's full
    // remote id is the single-element [linkedTableId].
    [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId, linkedTableRemoteId: [linkedTableId] },
  });
}

const addressSchema = (): TSchema =>
  Type.Union([
    Type.Object({
      street: nullableString(),
      city: nullableString(),
      state: nullableString(),
      postal_code: nullableString(),
      country: nullableString(),
    }),
    Type.Null(),
  ]);

/** Copper's typed contact arrays: `[{ <valueKey>, category }]` (emails/phones/socials/websites). */
const contactArray = (valueKey: string): TSchema =>
  Type.Array(Type.Object({ [valueKey]: nullableString(), category: nullableString() }));

const tagsSchema = (): TSchema => Type.Array(Type.String());

// Custom-field type hints, read-only detection, and the array-keyed-by options
// live in ./copper-custom-fields (shared with the default view).

/**
 * Build the verbatim `custom_fields` array property, annotated with
 * `x-scratch-array-keyed-by` so the generic engines expand each element into its
 * own editable column addressed by `custom_field_definition_id`. The element
 * `value` is typed permissively (`unknown`) because a Copper record mixes value
 * shapes across field types in one array — the per-column type hint for the
 * renderer comes from the annotation's `columns`, not the JSON schema. Stored
 * exactly as Copper returns it.
 */
function buildCustomFieldsArrayProperty(definitions: CopperCustomFieldDefinition[]): TSchema {
  const elementSchema = Type.Object(
    { [CUSTOM_FIELD_KEY_FIELD]: Type.Number(), value: Type.Unknown() },
    { additionalProperties: true },
  );
  return Type.Optional(
    Type.Array(elementSchema, {
      [X_SCRATCH_ARRAY_KEYED_BY]: buildCopperCustomFieldsArrayKeyedByOptions(definitions),
      description: 'Custom field values, stored verbatim as `[{ custom_field_definition_id, value }]`.',
    }),
  );
}

/** Agent-readable legend: each custom field's definition id, name, type and options. */
function buildCustomFieldsAgentInstructions(definitions: CopperCustomFieldDefinition[]): string {
  const shapeHint =
    'Custom field values are stored verbatim in the `custom_fields` array as ' +
    '`[{ custom_field_definition_id, value }]`. Edit an element by its definition id ' +
    '(path `custom_fields.[custom_field_definition_id=<id>].value`); never reorder or drop elements.';
  if (definitions.length === 0) {
    return `${shapeHint} This account has no custom fields defined.`;
  }
  const fieldLines = definitions.map((definition) => {
    const optionsSuffix =
      definition.available_options && definition.available_options.length > 0
        ? `, options: ${definition.available_options.map((option) => option.name).join(' | ')}`
        : '';
    const readonlySuffix = isReadonlyCopperCustomField(definition) ? ', read-only' : '';
    return `- ${definition.name} (definition id: ${definition.id}, type: ${definition.data_type}${optionsSuffix}${readonlySuffix})`;
  });
  return `${shapeHint}\nCustom-field definitions for this account:\n${fieldLines.join('\n')}`;
}

/** Polymorphic parent reference used by Tasks and Projects (`{ id, type }`). */
const relatedResourceSchema = (): TSchema =>
  Type.Union([Type.Object({ id: nullableNumber(), type: nullableString() }), Type.Null()]);

// Read-only system fields shared by every entity.
const sharedReadonlyDateFields = (): Record<string, TSchema> => ({
  date_created: readonly(nullableNumber()),
  date_modified: readonly(nullableNumber()),
});

// --- Per-entity system field definitions ---

function peopleProperties(): Record<string, TSchema> {
  return {
    id: readonly(Type.Number()),
    name: nullableString(),
    prefix: nullableString(),
    first_name: nullableString(),
    middle_name: nullableString(),
    last_name: nullableString(),
    suffix: nullableString(),
    title: nullableString(),
    address: addressSchema(),
    assignee_id: nullableNumber(),
    // company_id is set via Related Items (deferred), not a normal update — read-only in v1 (R8).
    company_id: readonly({
      ...foreignKey('companies'),
      description: 'Set via Related Items (read-only in v1)',
    }),
    company_name: nullableString(),
    contact_type_id: nullableNumber(),
    details: nullableString(),
    emails: contactArray('email'),
    phone_numbers: contactArray('number'),
    socials: contactArray('url'),
    websites: contactArray('url'),
    tags: tagsSchema(),
    date_last_contacted: readonly(nullableNumber()),
    interaction_count: readonly(nullableNumber()),
    leads_converted_from: readonly(Type.Unknown()),
    ...sharedReadonlyDateFields(),
  };
}

function companiesProperties(): Record<string, TSchema> {
  return {
    id: readonly(Type.Number()),
    name: nullableString(),
    address: addressSchema(),
    assignee_id: nullableNumber(),
    contact_type_id: nullableNumber(),
    details: nullableString(),
    email_domain: nullableString(),
    phone_numbers: contactArray('number'),
    socials: contactArray('url'),
    websites: contactArray('url'),
    tags: tagsSchema(),
    primary_contact_id: foreignKey('people'),
    interaction_count: readonly(nullableNumber()),
    ...sharedReadonlyDateFields(),
  };
}

function opportunitiesProperties(): Record<string, TSchema> {
  return {
    id: readonly(Type.Number()),
    name: nullableString(),
    assignee_id: nullableNumber(),
    close_date: nullableString(),
    company_id: foreignKey('companies'),
    company_name: nullableString(),
    customer_source_id: nullableNumber(),
    details: nullableString(),
    loss_reason_id: nullableNumber(),
    pipeline_id: foreignKey('pipelines'),
    pipeline_stage_id: foreignKey('pipeline_stages'),
    primary_contact_id: foreignKey('people'),
    priority: nullableString(),
    status: nullableString(),
    tags: tagsSchema(),
    monetary_value: nullableNumber(),
    win_probability: nullableNumber(),
    interaction_count: readonly(nullableNumber()),
    date_last_contacted: readonly(nullableNumber()),
    ...sharedReadonlyDateFields(),
  };
}

function leadsProperties(): Record<string, TSchema> {
  return {
    id: readonly(Type.Number()),
    name: nullableString(),
    prefix: nullableString(),
    first_name: nullableString(),
    middle_name: nullableString(),
    last_name: nullableString(),
    suffix: nullableString(),
    title: nullableString(),
    address: addressSchema(),
    assignee_id: nullableNumber(),
    company_name: nullableString(),
    customer_source_id: nullableNumber(),
    details: nullableString(),
    // Leads carry a single email object, not an array.
    email: Type.Union([Type.Object({ email: nullableString(), category: nullableString() }), Type.Null()]),
    phone_numbers: contactArray('number'),
    socials: contactArray('url'),
    websites: contactArray('url'),
    tags: tagsSchema(),
    monetary_value: nullableNumber(),
    status: nullableString(),
    status_id: nullableNumber(),
    interaction_count: readonly(nullableNumber()),
    date_last_contacted: readonly(nullableNumber()),
    ...sharedReadonlyDateFields(),
  };
}

function tasksProperties(): Record<string, TSchema> {
  return {
    id: readonly(Type.Number()),
    name: nullableString(),
    related_resource: relatedResourceSchema(),
    assignee_id: nullableNumber(),
    due_date: nullableNumber(),
    reminder_date: nullableNumber(),
    completed_date: readonly(nullableNumber()),
    priority: nullableString(),
    status: nullableString(),
    details: nullableString(),
    tags: tagsSchema(),
    ...sharedReadonlyDateFields(),
  };
}

function projectsProperties(): Record<string, TSchema> {
  return {
    id: readonly(Type.Number()),
    name: nullableString(),
    related_resource: relatedResourceSchema(),
    assignee_id: nullableNumber(),
    status: nullableString(),
    details: nullableString(),
    tags: tagsSchema(),
    ...sharedReadonlyDateFields(),
  };
}

const ENTITY_PROPERTY_BUILDERS: Record<CopperEntityType, () => Record<string, TSchema>> = {
  people: peopleProperties,
  companies: companiesProperties,
  opportunities: opportunitiesProperties,
  leads: leadsProperties,
  tasks: tasksProperties,
  projects: projectsProperties,
};

/**
 * Pin a Copper entity schema's `required` array to the record `id` only.
 *
 * Copper returns blank fields as `null` (and omits some entirely), so in a
 * verbatim record every field except the id is genuinely optional. TypeBox's
 * `Type.Object`, however, lists every non-`Optional` property in `required`,
 * which makes the CLI's `enforce_schema` validator reject real pulled records
 * whose blank fields came back null ("field 'X' is required but missing or
 * null"). `id` is the one field Copper always returns non-null, so it is the
 * only field we require — the schema must describe the data, not reject it.
 */
function pinRequiredToIdOnly(schema: TObject): void {
  schema.required = ['id'];
}

/**
 * Build a {@link BaseJsonTableSpec} for a Copper entity. The discovered custom
 * field definitions become the `x-scratch-array-keyed-by` columns on the
 * verbatim `custom_fields` array (so each renders as its own editable column),
 * an id→name legend at the schema root for agents, and a "Custom Fields" banner
 * group in the default view.
 */
export function buildCopperJsonTableSpec(
  id: EntityId,
  entityType: CopperEntityType,
  customFieldDefinitions: CopperCustomFieldDefinition[],
): BaseJsonTableSpec {
  const config = COPPER_ENTITY_CONFIG[entityType];
  const properties = ENTITY_PROPERTY_BUILDERS[entityType]();

  // Custom fields are stored verbatim as Copper's array; the annotation drives
  // per-field editable columns (see copper-custom-fields.ts) — no reshape.
  properties.custom_fields = buildCustomFieldsArrayProperty(customFieldDefinitions);

  const schema = Type.Object(properties, {
    $id: `copper/${entityType}`,
    title: config.displayName,
    // Field key→name/type/options legend for agents, at the schema ROOT so it
    // does not turn `custom_fields` into an opaque leaf column.
    [X_SCRATCH_AGENT_INSTRUCTIONS]: buildCustomFieldsAgentInstructions(customFieldDefinitions),
  });
  pinRequiredToIdOnly(schema);

  return {
    id,
    slug: id.wsId,
    name: config.displayName,
    schema,
    idPath: dotPath('id'),
    titlePath: dotPath(config.titleField),
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

// --- Read-only reference tables (Pipelines / Pipeline Stages) ---

/**
 * Pipelines (`GET /pipelines`). A small read-only config list and the FK target
 * of `Opportunities.pipeline_id`. Copper returns each pipeline's `stages` embedded
 * verbatim; the stages are also exposed flat as the Pipeline Stages table.
 */
function pipelinesProperties(): Record<string, TSchema> {
  return {
    id: readonly(Type.Number()),
    name: readonly(nullableString()),
    type: readonly(nullableString()),
    is_revenue: readonly(Type.Union([Type.Boolean(), Type.Null()])),
    stages: readonly(Type.Array(Type.Unknown())),
  };
}

/**
 * Pipeline Stages (`GET /pipeline_stages`). Read-only; the FK target of
 * `Opportunities.pipeline_stage_id`. Each stage belongs to a pipeline.
 */
function pipelineStagesProperties(): Record<string, TSchema> {
  return {
    id: readonly(Type.Number()),
    name: readonly(nullableString()),
    pipeline_id: readonly(foreignKey('pipelines')),
    win_probability: readonly(nullableNumber()),
  };
}

const REFERENCE_PROPERTY_BUILDERS: Record<CopperReferenceEntityType, () => Record<string, TSchema>> = {
  pipelines: pipelinesProperties,
  pipeline_stages: pipelineStagesProperties,
};

/**
 * Build a {@link BaseJsonTableSpec} for a read-only Copper reference table. Every
 * field is read-only (pull-only table); records are stored verbatim, so any field
 * not declared here is still kept on disk.
 */
export function buildCopperReferenceTableSpec(id: EntityId, refType: CopperReferenceEntityType): BaseJsonTableSpec {
  const config = COPPER_REFERENCE_ENTITY_CONFIG[refType];
  const schema = Type.Object(REFERENCE_PROPERTY_BUILDERS[refType](), {
    $id: `copper/${refType}`,
    title: config.displayName,
  });
  pinRequiredToIdOnly(schema);

  return {
    id,
    slug: id.wsId,
    name: config.displayName,
    schema,
    idPath: dotPath('id'),
    titlePath: dotPath(config.titleField),
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}
