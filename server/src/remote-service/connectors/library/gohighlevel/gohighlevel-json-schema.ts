import { Type, type TSchema } from '@sinclair/typebox';
import { X_SCRATCH_AGENT_INSTRUCTIONS, X_SCRATCH_FOREIGN_KEY_OPTIONS, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { BaseJsonTableSpec, EntityId, idPath } from '../../types';
import {
  GoHighLevelCustomFieldDefinition,
  GoHighLevelObjectDefinition,
  GoHighLevelObjectField,
} from './gohighlevel-types';

// --- Shared field helpers -------------------------------------------------

/** Optional string field. */
const optionalString = (description?: string): TSchema =>
  Type.Optional(Type.String(description ? { description } : {}));

/** Optional string field that HighLevel computes and we must not write back. */
const readonlyOptionalString = (description?: string): TSchema =>
  Type.Optional(Type.String({ [X_SCRATCH_READONLY]: true, ...(description ? { description } : {}) }));

/**
 * Build a one-paragraph, agent-readable description of a model's custom fields.
 * The record stores values as a raw `{ id, <valueKey> }` array, so this mapping
 * is the only place an agent (or a human reading schema.json) can learn what
 * each `id` means without a separate API call.
 *
 * @param valueKey `value` for contacts, `fieldValue` for opportunities.
 */
function buildCustomFieldsAgentInstructions(
  definitions: GoHighLevelCustomFieldDefinition[],
  valueKey: 'value' | 'fieldValue',
): string {
  if (definitions.length === 0) {
    return `Custom field values are stored verbatim as a \`{ id, ${valueKey} }\` array. This location has no custom fields defined for this object.`;
  }
  const fieldLines = definitions.map((definition) => {
    const optionsSuffix =
      definition.picklistOptions && definition.picklistOptions.length > 0
        ? `, options: ${definition.picklistOptions.join(' | ')}`
        : '';
    return `- ${definition.name ?? '(unnamed)'} (id: ${definition.id}, key: ${definition.fieldKey ?? '?'}, type: ${definition.dataType ?? '?'}${optionsSuffix})`;
  });
  return (
    `Custom field values are stored verbatim as an array of { id, ${valueKey} } objects, exactly as the HighLevel API returns them. ` +
    `Each \`id\` maps to one of the location custom-field definitions below; the \`${valueKey}\` shape depends on the field type. ` +
    'Custom-field definitions for this location:\n' +
    fieldLines.join('\n')
  );
}

/**
 * The `customFields` property: a faithful `{ id, <valueKey> }` array annotated
 * with the discovered field definitions.
 */
function customFieldsArrayProperty(
  definitions: GoHighLevelCustomFieldDefinition[],
  valueKey: 'value' | 'fieldValue',
): TSchema {
  return Type.Optional(
    Type.Array(Type.Object({ id: Type.String(), [valueKey]: Type.Unknown() }), {
      description: `Custom field values as { id, ${valueKey} } pairs (see agent instructions for field definitions).`,
      [X_SCRATCH_AGENT_INSTRUCTIONS]: buildCustomFieldsAgentInstructions(definitions, valueKey),
    }),
  );
}

// --- Contacts -------------------------------------------------------------

/**
 * Build the Contacts JSON table spec.
 *
 * System fields are enumerated and typed; `additionalProperties: true` keeps any
 * field we did not enumerate (so the stored record stays a faithful copy of the
 * API response). Custom fields are discovered dynamically from the Locations
 * customFields API and surfaced through the `customFields` array's
 * agent-instructions annotation.
 */
export function buildContactsJsonTableSpec(
  id: EntityId,
  contactCustomFieldDefinitions: GoHighLevelCustomFieldDefinition[],
): BaseJsonTableSpec {
  const properties: Record<string, TSchema> = {
    id: Type.String({ [X_SCRATCH_READONLY]: true, description: 'HighLevel contact ID' }),
    locationId: readonlyOptionalString('Sub-account (Location) this contact belongs to'),
    // HighLevel exposes the full name as `contactName` on search responses and
    // `name` on get-by-id — keep both so the title column resolves either way.
    contactName: optionalString('Full contact name (search responses)'),
    name: optionalString('Full contact name'),
    firstName: optionalString(),
    lastName: optionalString(),
    email: optionalString(),
    phone: optionalString(),
    companyName: optionalString(),
    address1: optionalString(),
    city: optionalString(),
    state: optionalString(),
    country: optionalString(),
    postalCode: optionalString(),
    website: optionalString(),
    timezone: optionalString(),
    source: optionalString(),
    type: optionalString(),
    assignedTo: optionalString('User ID this contact is assigned to'),
    dateOfBirth: optionalString(),
    businessId: optionalString(),
    dnd: Type.Optional(Type.Boolean({ description: 'Do-not-disturb flag' })),
    tags: Type.Optional(Type.Array(Type.String())),
    dateAdded: readonlyOptionalString('ISO 8601 creation timestamp'),
    dateUpdated: readonlyOptionalString('ISO 8601 last-updated timestamp'),
    customFields: customFieldsArrayProperty(contactCustomFieldDefinitions, 'value'),
  };

  const schema = Type.Object(properties, {
    $id: 'gohighlevel/contacts',
    title: 'Contacts',
    additionalProperties: true,
  });

  return {
    id,
    slug: id.wsId,
    name: 'Contacts',
    schema,
    idColumnRemoteId: idPath('id'),
    titleColumnRemoteId: ['contactName'],
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

// --- Opportunities --------------------------------------------------------

/**
 * Build the Opportunities JSON table spec. Custom fields are discovered from the
 * Locations customFields API (the `opportunity` model). `pipelineId`/`contactId`
 * are annotated as foreign keys into the Pipelines/Contacts tables.
 */
export function buildOpportunitiesJsonTableSpec(
  id: EntityId,
  opportunityCustomFieldDefinitions: GoHighLevelCustomFieldDefinition[],
): BaseJsonTableSpec {
  const properties: Record<string, TSchema> = {
    id: Type.String({ [X_SCRATCH_READONLY]: true, description: 'HighLevel opportunity ID' }),
    name: optionalString('Opportunity name'),
    monetaryValue: Type.Optional(Type.Number({ description: 'Monetary value' })),
    status: optionalString('Status: open | won | lost | abandoned'),
    pipelineId: Type.Optional(
      Type.String({
        description: 'Pipeline this opportunity belongs to',
        [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'pipelines' },
      }),
    ),
    pipelineStageId: optionalString('Stage within the pipeline'),
    contactId: Type.Optional(
      Type.String({
        description: 'Associated contact',
        [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'contacts' },
      }),
    ),
    assignedTo: optionalString('User ID this opportunity is assigned to'),
    source: optionalString(),
    lostReasonId: optionalString(),
    externalObjectId: optionalString(),
    locationId: readonlyOptionalString('Sub-account (Location)'),
    createdAt: readonlyOptionalString('ISO 8601 creation timestamp'),
    updatedAt: readonlyOptionalString('ISO 8601 last-updated timestamp'),
    lastStatusChangeAt: readonlyOptionalString(),
    lastStageChangeAt: readonlyOptionalString(),
    lastActionDate: readonlyOptionalString(),
    indexVersion: readonlyOptionalString(),
    // Hydrated read-only snapshots / sub-resources (only present when requested).
    contact: Type.Optional(
      Type.Object(
        {},
        {
          additionalProperties: true,
          [X_SCRATCH_READONLY]: true,
          description: 'Hydrated snapshot of the associated contact (read-only).',
        },
      ),
    ),
    followers: Type.Optional(Type.Array(Type.Unknown())),
    notes: Type.Optional(Type.Array(Type.Unknown(), { [X_SCRATCH_READONLY]: true })),
    tasks: Type.Optional(Type.Array(Type.Unknown(), { [X_SCRATCH_READONLY]: true })),
    calendarEvents: Type.Optional(Type.Array(Type.Unknown(), { [X_SCRATCH_READONLY]: true })),
    customFields: customFieldsArrayProperty(opportunityCustomFieldDefinitions, 'fieldValue'),
  };

  const schema = Type.Object(properties, {
    $id: 'gohighlevel/opportunities',
    title: 'Opportunities',
    additionalProperties: true,
  });

  return {
    id,
    slug: id.wsId,
    name: 'Opportunities',
    schema,
    idColumnRemoteId: idPath('id'),
    titleColumnRemoteId: ['name'],
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

// --- Pipelines ------------------------------------------------------------

/**
 * Build the Pipelines JSON table spec. Pipelines are read-only reference data
 * (their IDs/stage IDs are inputs when writing Opportunities), so the schema is
 * static — no dynamic discovery needed.
 */
export function buildPipelinesJsonTableSpec(id: EntityId): BaseJsonTableSpec {
  const stageSchema = Type.Object(
    {
      id: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
      position: Type.Optional(Type.Number()),
    },
    { additionalProperties: true },
  );

  const properties: Record<string, TSchema> = {
    id: Type.String({ [X_SCRATCH_READONLY]: true, description: 'Pipeline ID' }),
    name: optionalString('Pipeline name'),
    stages: Type.Optional(Type.Array(stageSchema, { description: 'Ordered stages in this pipeline' })),
    showInFunnel: Type.Optional(Type.Boolean()),
    showInPieChart: Type.Optional(Type.Boolean()),
    colorRenderMode: optionalString('How pipeline/stage colors are rendered'),
    locationId: readonlyOptionalString('Sub-account (Location)'),
  };

  const schema = Type.Object(properties, {
    $id: 'gohighlevel/pipelines',
    title: 'Pipelines',
    additionalProperties: true,
  });

  return {
    id,
    slug: id.wsId,
    name: 'Pipelines',
    schema,
    idColumnRemoteId: idPath('id'),
    titleColumnRemoteId: ['name'],
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

// --- Custom / standard objects --------------------------------------------

/**
 * Agent-readable description of an object's fields. Record values live in the
 * keyed `properties` bag, so this documents each `fieldKey` → name/type/options.
 */
function buildObjectFieldsAgentInstructions(fields: GoHighLevelObjectField[]): string {
  if (fields.length === 0) {
    return "Record field values are stored verbatim under the `properties` object, keyed by each field's key. This object has no field definitions.";
  }
  const fieldLines = fields.map((field) => {
    const optionsSuffix =
      field.options && field.options.length > 0
        ? `, options: ${field.options.map((option) => option.label ?? option.key ?? '').join(' | ')}`
        : '';
    return `- ${field.name ?? '(unnamed)'} (key: ${field.fieldKey ?? '?'}, type: ${field.dataType ?? '?'}${optionsSuffix})`;
  });
  return (
    'Record field values are stored verbatim under the `properties` object, keyed by each field key, exactly as the HighLevel API returns them. ' +
    'Field definitions for this object:\n' +
    fieldLines.join('\n')
  );
}

/**
 * Build the JSON table spec for a custom/standard object discovered via the
 * Objects API. The schema is permissive (`additionalProperties: true`) and the
 * record's `properties` bag is documented from the object's field definitions —
 * faithful to the raw record, since values are keyed dynamically per object.
 */
export function buildCustomObjectJsonTableSpec(
  id: EntityId,
  objectDefinition: GoHighLevelObjectDefinition,
  fields: GoHighLevelObjectField[],
): BaseJsonTableSpec {
  const displayName = objectDefinition.labels?.plural ?? objectDefinition.labels?.singular ?? id.wsId;

  const properties: Record<string, TSchema> = {
    id: Type.String({ [X_SCRATCH_READONLY]: true, description: 'Record ID' }),
    properties: Type.Object(
      {},
      {
        additionalProperties: true,
        description: 'Field values keyed by field key (see agent instructions for field definitions).',
        [X_SCRATCH_AGENT_INSTRUCTIONS]: buildObjectFieldsAgentInstructions(fields),
      },
    ),
    owner: Type.Optional(Type.Array(Type.String(), { description: 'Owner user IDs' })),
    followers: Type.Optional(Type.Array(Type.String(), { description: 'Follower user IDs' })),
    locationId: readonlyOptionalString('Sub-account (Location)'),
    // Search responses use createdAt/updatedAt; get-by-id uses dateAdded/dateUpdated.
    createdAt: readonlyOptionalString('ISO 8601 creation timestamp (search responses)'),
    updatedAt: readonlyOptionalString('ISO 8601 last-updated timestamp (search responses)'),
    dateAdded: readonlyOptionalString('ISO 8601 creation timestamp (get-by-id responses)'),
    dateUpdated: readonlyOptionalString('ISO 8601 last-updated timestamp (get-by-id responses)'),
  };

  const schema = Type.Object(properties, {
    $id: `gohighlevel/${id.wsId}`,
    title: displayName,
    additionalProperties: true,
  });

  return {
    id,
    slug: id.wsId,
    name: displayName,
    schema,
    idColumnRemoteId: idPath('id'),
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

// --- Generic location-scoped list entities --------------------------------

/**
 * Build a permissive JSON table spec for a generic location-scoped list entity
 * (Users, Conversations, Products, …). We don't enumerate per-entity fields:
 * the record is stored verbatim (`additionalProperties: true`) and only the id
 * column is typed. `idField` is `id` for most, `_id` for products/proposals/blogs.
 */
export function buildGenericEntityJsonTableSpec(id: EntityId, displayName: string, idField: string): BaseJsonTableSpec {
  const properties: Record<string, TSchema> = {
    [idField]: Type.String({ [X_SCRATCH_READONLY]: true, description: 'Record ID' }),
  };

  const schema = Type.Object(properties, {
    $id: `gohighlevel/${id.wsId}`,
    title: displayName,
    additionalProperties: true,
  });

  return {
    id,
    slug: id.wsId,
    name: displayName,
    schema,
    idColumnRemoteId: idPath(idField),
    titleColumnRemoteId: ['name'],
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}
