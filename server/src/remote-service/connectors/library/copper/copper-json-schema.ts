import { Type, type TSchema } from '@sinclair/typebox';
import { X_SCRATCH_AGENT_INSTRUCTIONS, X_SCRATCH_FOREIGN_KEY_OPTIONS, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { BaseJsonTableSpec, EntityId, idPath } from '../../types';
import { COPPER_ENTITY_CONFIG, CopperCustomFieldDefinition, CopperEntityType } from './copper-types';

/**
 * Builds the JSON schema for each Copper entity.
 *
 * Copper has no system-field metadata endpoint, so the system fields below are
 * declared statically (the "hardcode only when the API offers no introspection"
 * rule). User-defined custom fields ARE discovered dynamically via
 * `GET /custom_field_definitions`; they live on each record as the verbatim
 * `custom_fields: [{ custom_field_definition_id, value }]` array and are stored
 * as-is. (Expanding each custom field into its own editable column — and the
 * `Connect`/computed read-only handling — is the R1 contract-test follow-up.)
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

const customFieldsSchema = (): TSchema =>
  Type.Array(
    Type.Object({
      custom_field_definition_id: Type.Number(),
      value: Type.Unknown(),
    }),
  );

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
    custom_fields: customFieldsSchema(),
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
    custom_fields: customFieldsSchema(),
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
    custom_fields: customFieldsSchema(),
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
    custom_fields: customFieldsSchema(),
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
    custom_fields: customFieldsSchema(),
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
    custom_fields: customFieldsSchema(),
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
 * field definitions are surfaced to agents as an id→name legend on the
 * `custom_fields` array (so an LLM editing the file knows what each
 * `custom_field_definition_id` means) without reshaping the stored data.
 */
export function buildCopperJsonTableSpec(
  id: EntityId,
  entityType: CopperEntityType,
  customFieldDefinitions: CopperCustomFieldDefinition[],
): BaseJsonTableSpec {
  const config = COPPER_ENTITY_CONFIG[entityType];
  const properties = ENTITY_PROPERTY_BUILDERS[entityType]();

  if (customFieldDefinitions.length > 0 && properties.custom_fields) {
    const legend = customFieldDefinitions.map((def) => `${def.id}=${def.name} (${def.data_type})`).join(', ');
    properties.custom_fields = {
      ...properties.custom_fields,
      [X_SCRATCH_AGENT_INSTRUCTIONS]:
        `Each entry's custom_field_definition_id maps to: ${legend}. ` +
        `Connect-type and computed custom fields are read-only.`,
    };
  }

  const schema = Type.Object(properties, {
    $id: `copper/${entityType}`,
    title: config.displayName,
  });

  return {
    id,
    slug: id.wsId,
    name: config.displayName,
    schema,
    idColumnRemoteId: idPath('id'),
    titleColumnRemoteId: [config.titleField],
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}
