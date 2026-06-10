import { Type, type TSchema } from '@sinclair/typebox';
import { X_SCRATCH_AGENT_INSTRUCTIONS, X_SCRATCH_FOREIGN_KEY_OPTIONS, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { BaseJsonTableSpec, EntityId, idPath } from '../../types';
import { customFieldColumnKey } from './copper-custom-fields';
import { buildCopperDefaultView } from './copper-default-view';
import { COPPER_ENTITY_CONFIG, CopperCustomFieldDefinition, CopperEntityType } from './copper-types';

/**
 * Builds the JSON schema for each Copper entity.
 *
 * Copper has no system-field metadata endpoint, so the system fields below are
 * declared statically (the "hardcode only when the API offers no introspection"
 * rule). User-defined custom fields ARE discovered dynamically via
 * `GET /custom_field_definitions`.
 *
 * Copper returns custom-field values as a verbatim
 * `custom_fields: [{ custom_field_definition_id, value }]` array, but a Scratch
 * view can't make an array element an editable column. So the connector reshapes
 * that array into a keyed object (`{ cf_<id>: value }`, see
 * {@link reshapeCustomFieldsArrayToObject}) and this schema declares one typed
 * sub-property per definition — one editable column each — gathered under a
 * "Custom Fields" banner in the {@link buildCopperDefaultView default view}.
 */

// --- Field helpers ---

const nullableString = (): TSchema => Type.Union([Type.String(), Type.Null()]);
const nullableNumber = (): TSchema => Type.Union([Type.Number(), Type.Null()]);

/** Mark a field read-only (computed / system-managed — never sent on write). */
function readonly(schema: TSchema): TSchema {
  return { ...schema, [X_SCRATCH_READONLY]: true };
}

/** A numeric foreign key pointing at another Copper entity table (by wsId). */
function foreignKey(linkedTableId: CopperEntityType): TSchema {
  return Type.Union([Type.Number(), Type.Null()], {
    [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId },
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

/** Copper custom-field data types that Copper computes / won't accept on write. */
function isReadonlyCopperCustomField(definition: CopperCustomFieldDefinition): boolean {
  return definition.is_computed === true || definition.data_type === 'Connect';
}

/** Permissive (nullable) schema for one Copper custom field, typed from its `data_type`. */
function schemaForCopperCustomFieldDataType(definition: CopperCustomFieldDefinition): TSchema {
  const annotations: Record<string, unknown> = { title: definition.name };
  if (definition.available_options && definition.available_options.length > 0) {
    annotations.description = `${definition.name} (options: ${definition.available_options
      .map((option) => option.name)
      .join(' | ')})`;
  }
  if (isReadonlyCopperCustomField(definition)) annotations[X_SCRATCH_READONLY] = true;

  switch (definition.data_type) {
    case 'Checkbox':
      return Type.Union([Type.Boolean(), Type.Null()], annotations);
    case 'Float':
    case 'Currency':
    case 'Percentage':
      return Type.Union([Type.Number(), Type.Null()], annotations);
    case 'MultiSelect':
      return Type.Union([Type.Array(Type.Unknown()), Type.Null()], annotations);
    case 'String':
    case 'Text':
    case 'URL':
      return Type.Union([Type.String(), Type.Null()], annotations);
    // Dropdown (option id), Date (epoch) and Connect (relation reference) are
    // stored verbatim — permissive, exact value shapes confirmed in Pass 2.
    default:
      return Type.Union([Type.Unknown(), Type.Null()], annotations);
  }
}

/**
 * Build the keyed `custom_fields` object property: one typed sub-property per
 * discovered definition (keyed by `cf_<id>`), so the client renders each as its
 * own column. No `x-scratch-*` extension on the object → the column builder
 * expands the sub-properties; `additionalProperties: true` keeps any custom
 * field a definition omitted (stored verbatim).
 */
function buildCustomFieldsObjectProperty(definitions: CopperCustomFieldDefinition[]): TSchema {
  const fieldProperties: Record<string, TSchema> = {};
  for (const definition of definitions) {
    fieldProperties[customFieldColumnKey(definition.id)] = schemaForCopperCustomFieldDataType(definition);
  }
  return Type.Optional(
    Type.Object(fieldProperties, {
      additionalProperties: true,
      description: 'Custom field values, keyed by `cf_<definitionId>` (see agent instructions for the legend).',
    }),
  );
}

/** Agent-readable legend: each custom field's column key, name, type and options. */
function buildCustomFieldsAgentInstructions(definitions: CopperCustomFieldDefinition[]): string {
  if (definitions.length === 0) {
    return 'Custom field values are stored under the `custom_fields` object, keyed by `cf_<definitionId>`. This account has no custom fields defined.';
  }
  const fieldLines = definitions.map((definition) => {
    const optionsSuffix =
      definition.available_options && definition.available_options.length > 0
        ? `, options: ${definition.available_options.map((option) => option.name).join(' | ')}`
        : '';
    const readonlySuffix = isReadonlyCopperCustomField(definition) ? ', read-only' : '';
    return `- ${definition.name} (custom_fields key: ${customFieldColumnKey(definition.id)}, definition id: ${definition.id}, type: ${definition.data_type}${optionsSuffix}${readonlySuffix})`;
  });
  return (
    'Custom field values are stored under the `custom_fields` object, keyed by `cf_<definitionId>`. ' +
    'Each key maps to one Copper custom-field definition below; the value shape depends on the field type. ' +
    'Custom-field definitions for this account:\n' +
    fieldLines.join('\n')
  );
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
    pipeline_id: nullableNumber(),
    pipeline_stage_id: nullableNumber(),
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
 * Build a {@link BaseJsonTableSpec} for a Copper entity. The discovered custom
 * field definitions become one typed sub-property each on the keyed
 * `custom_fields` object (so each renders as its own editable column), an
 * id→name legend at the schema root for agents, and a "Custom Fields" banner
 * group in the default view.
 */
export function buildCopperJsonTableSpec(
  id: EntityId,
  entityType: CopperEntityType,
  customFieldDefinitions: CopperCustomFieldDefinition[],
): BaseJsonTableSpec {
  const config = COPPER_ENTITY_CONFIG[entityType];
  const properties = ENTITY_PROPERTY_BUILDERS[entityType]();

  // Custom fields are reshaped from Copper's array into a keyed object on pull
  // (see copper-custom-fields.ts); declare one typed sub-property per definition.
  properties.custom_fields = buildCustomFieldsObjectProperty(customFieldDefinitions);

  const schema = Type.Object(properties, {
    $id: `copper/${entityType}`,
    title: config.displayName,
    // Field key→name/type/options legend for agents, at the schema ROOT so it
    // does not turn `custom_fields` into an opaque leaf column.
    [X_SCRATCH_AGENT_INSTRUCTIONS]: buildCustomFieldsAgentInstructions(customFieldDefinitions),
  });

  return {
    id,
    slug: id.wsId,
    name: config.displayName,
    schema,
    idColumnRemoteId: idPath('id'),
    titleColumnRemoteId: [config.titleField],
    basePath: [],
    // System fields flat; custom fields grouped under a "Custom Fields" banner.
    defaultView: buildCopperDefaultView(properties, customFieldDefinitions),
    generatedAt: new Date().toISOString(),
  };
}
