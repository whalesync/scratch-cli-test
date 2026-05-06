import { Type, type TSchema } from '@sinclair/typebox';
import { X_SCRATCH_CONNECTOR_DATA_TYPE, X_SCRATCH_READONLY, X_SCRATCH_REMOTE_FIELD_ID } from '@spinner/shared-types';
import { BaseJsonTableSpec, EntityId, idPath } from '../../types';
import { AffinityApiClient } from './affinity-api-client';
import { AffinityEntityType, AffinityFieldMetadata, AffinityList, AffinityValueType } from './affinity-types';

// ---------------------------------------------------------------------------
// Reusable sub-schemas for interaction types
// ---------------------------------------------------------------------------

const personDataSchema = Type.Object({
  id: Type.Number(),
  firstName: Type.Union([Type.String(), Type.Null()]),
  lastName: Type.Union([Type.String(), Type.Null()]),
  primaryEmailAddress: Type.Union([Type.String(), Type.Null()]),
  type: Type.Union([Type.String(), Type.Null()]),
});

/**
 * Build a TypeBox schema fragment for an Affinity field's `value` object,
 * matching the `FieldValue` discriminated union from the v2 OpenAPI spec.
 *
 * The exact `data` shape depends on the field's `valueType`. We model the
 * primitives precisely and fall back to a permissive object for the structured
 * variants (location, dropdown, etc.) so the connector keeps working as
 * Affinity adds shape variants.
 */
function valueSchemaForType(valueType: AffinityValueType): TSchema {
  switch (valueType) {
    case 'text':
    case 'filterable-text':
      return Type.Object({
        type: Type.Literal(valueType),
        data: Type.Union([Type.String(), Type.Null()]),
      });

    case 'filterable-text-multi':
      return Type.Object({
        type: Type.Literal('filterable-text-multi'),
        data: Type.Array(Type.String()),
      });

    case 'number':
    case 'formula-number':
      return Type.Object({
        type: Type.Literal(valueType),
        data: Type.Union([Type.Number(), Type.Null()]),
      });

    case 'number-multi':
      return Type.Object({
        type: Type.Literal('number-multi'),
        data: Type.Array(Type.Number()),
      });

    case 'datetime':
      return Type.Object({
        type: Type.Literal('datetime'),
        data: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
      });

    case 'dropdown':
    case 'ranked-dropdown':
    case 'company':
    case 'person':
    case 'location':
    case 'interaction':
      return Type.Object({
        type: Type.Literal(valueType),
        data: Type.Union([Type.Object({}, { additionalProperties: true }), Type.Null()]),
      });

    case 'dropdown-multi':
    case 'company-multi':
    case 'person-multi':
    case 'location-multi':
      return Type.Object({
        type: Type.Literal(valueType),
        data: Type.Array(Type.Object({}, { additionalProperties: true })),
      });

    default:
      // Defensive: unknown valueType in the future API will pass through as-is.
      return Type.Unknown();
  }
}

/**
 * Build a schema for one entry in `entity.fields` (after the array → keyed
 * object transformation done at pull time). The shape mirrors the API's
 * `Field` schema, with `value` narrowed by the field's known `valueType`.
 */
function fieldEntrySchema(metadata: AffinityFieldMetadata): TSchema {
  const valueSchema = valueSchemaForType(metadata.valueType);
  return Type.Object(
    {
      id: Type.Literal(metadata.id),
      name: Type.String(),
      type: Type.Literal(metadata.type),
      enrichmentSource: Type.Union([Type.String(), Type.Null()]),
      value: Type.Union([valueSchema, Type.Null()]),
    },
    {
      description: metadata.name,
      [X_SCRATCH_REMOTE_FIELD_ID]: metadata.id,
      [X_SCRATCH_CONNECTOR_DATA_TYPE]: metadata.valueType,
    },
  );
}

/**
 * Build the inner `entity` schema for a list entry, which differs by entity
 * type (Company, Person, OpportunityWithFields). The discovered list-fields are
 * mounted under `entity.fields` as a keyed object so each field can be addressed
 * by its remote id (e.g. `entity.fields.field-1234`).
 */
function buildEntitySchema(entityType: AffinityEntityType, fieldsByKey: Record<string, TSchema>): TSchema {
  const fieldsObject = Type.Object(fieldsByKey, {
    description: 'Affinity fields keyed by field id',
    additionalProperties: false,
  });

  switch (entityType) {
    case 'company':
      return Type.Object({
        id: Type.Number({ [X_SCRATCH_READONLY]: true }),
        name: Type.Union([Type.String(), Type.Null()]),
        domain: Type.Union([Type.String(), Type.Null()]),
        domains: Type.Array(Type.String()),
        isGlobal: Type.Boolean({ [X_SCRATCH_READONLY]: true }),
        fields: fieldsObject,
      });

    case 'person':
      return Type.Object({
        id: Type.Number({ [X_SCRATCH_READONLY]: true }),
        firstName: Type.Union([Type.String(), Type.Null()]),
        lastName: Type.Union([Type.String(), Type.Null()]),
        primaryEmailAddress: Type.Union([Type.String(), Type.Null()]),
        emailAddresses: Type.Array(Type.String()),
        type: Type.Union([Type.String(), Type.Null()]),
        fields: fieldsObject,
      });

    case 'opportunity':
      return Type.Object({
        id: Type.Number({ [X_SCRATCH_READONLY]: true }),
        name: Type.Union([Type.String(), Type.Null()]),
        listId: Type.Number({ [X_SCRATCH_READONLY]: true }),
        fields: fieldsObject,
      });
  }
}

/**
 * Build a `BaseJsonTableSpec` for a single Affinity list. Calls
 * `GET /v2/lists/{listId}/fields` to discover the list's columns dynamically.
 */
export async function buildAffinityJsonTableSpec(
  id: EntityId,
  list: AffinityList,
  client: AffinityApiClient,
): Promise<BaseJsonTableSpec> {
  const fieldMetadata = await client.listListFields(list.id);

  const fieldsByKey: Record<string, TSchema> = {};
  for (const fm of fieldMetadata) {
    fieldsByKey[fm.id] = fieldEntrySchema(fm);
  }

  const entitySchema = buildEntitySchema(list.type, fieldsByKey);

  const schema = Type.Object(
    {
      id: Type.Number({ description: 'List entry id', [X_SCRATCH_READONLY]: true }),
      type: Type.Literal(list.type, { description: 'Entity type', [X_SCRATCH_READONLY]: true }),
      listId: Type.Number({ description: 'List id', [X_SCRATCH_READONLY]: true }),
      createdAt: Type.String({
        format: 'date-time',
        description: 'When the entry was added to the list',
        [X_SCRATCH_READONLY]: true,
      }),
      creatorId: Type.Union([Type.Number(), Type.Null()], {
        description: 'User who added the entry to the list',
        [X_SCRATCH_READONLY]: true,
      }),
      entity: entitySchema,
    },
    {
      $id: `affinity/list-${list.id}`,
      title: list.name,
    },
  );

  // Title field varies by entity type — Person uses firstName since lastName is nullable.
  const titleColumnRemoteId = list.type === 'person' ? ['entity', 'firstName'] : ['entity', 'name'];

  return {
    id,
    slug: id.wsId,
    name: list.name,
    schema,
    idColumnRemoteId: idPath('id'),
    titleColumnRemoteId,
    // Nest user-created lists under a top-level "Lists" folder in the workbook
    // tree. Mirrors the `parentPath: 'Lists'` grouping in the picker — but the
    // workbook hierarchy is actually controlled by `basePath`, not `parentPath`,
    // so both have to be set to keep the picker and the workbook tree consistent.
    basePath: ['Lists'],
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Tenant-wide tables — built from `GET /v2/persons` / `/v2/companies` /
// `/v2/opportunities`. These records are FLAT (no `entity` wrapper, unlike
// list-entries), so the schema mounts entity properties at the top level
// instead of under `.entity`.
//
// All three live at the workbook tree root (basePath: []), matching their
// top-level position in the picker.
// ---------------------------------------------------------------------------

/**
 * Build the table spec for the tenant-wide People table. Field metadata comes
 * from `/v2/persons/fields` (NB: not `/metadata/fields` despite what Affinity's
 * docs claim — that path 404s).
 */
export async function buildAffinityPersonsTableSpec(
  id: EntityId,
  client: AffinityApiClient,
): Promise<BaseJsonTableSpec> {
  const fieldMetadata = await client.listPersonFields();

  const fieldsByKey: Record<string, TSchema> = {};
  for (const fm of fieldMetadata) {
    fieldsByKey[fm.id] = fieldEntrySchema(fm);
  }

  const schema = Type.Object(
    {
      id: Type.Number({ description: 'Person id', [X_SCRATCH_READONLY]: true }),
      firstName: Type.Union([Type.String(), Type.Null()]),
      lastName: Type.Union([Type.String(), Type.Null()]),
      primaryEmailAddress: Type.Union([Type.String(), Type.Null()]),
      emailAddresses: Type.Array(Type.String()),
      type: Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
      fields: Type.Object(fieldsByKey, {
        description: 'Affinity fields keyed by field id',
        additionalProperties: false,
      }),
    },
    { $id: 'affinity/persons', title: 'People' },
  );

  return {
    id,
    slug: id.wsId,
    name: 'People',
    schema,
    idColumnRemoteId: idPath('id'),
    // No `entity.` prefix — tenant records are flat. firstName chosen over
    // lastName because lastName is nullable in Affinity.
    titleColumnRemoteId: ['firstName'],
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Build the table spec for the tenant-wide Companies table. Field metadata
 * comes from `/v2/companies/fields` (same docs caveat as persons).
 */
export async function buildAffinityCompaniesTableSpec(
  id: EntityId,
  client: AffinityApiClient,
): Promise<BaseJsonTableSpec> {
  const fieldMetadata = await client.listCompanyFields();

  const fieldsByKey: Record<string, TSchema> = {};
  for (const fm of fieldMetadata) {
    fieldsByKey[fm.id] = fieldEntrySchema(fm);
  }

  const schema = Type.Object(
    {
      id: Type.Number({ description: 'Company id', [X_SCRATCH_READONLY]: true }),
      name: Type.Union([Type.String(), Type.Null()]),
      domain: Type.Union([Type.String(), Type.Null()]),
      domains: Type.Array(Type.String()),
      isGlobal: Type.Boolean({ [X_SCRATCH_READONLY]: true }),
      fields: Type.Object(fieldsByKey, {
        description: 'Affinity fields keyed by field id',
        additionalProperties: false,
      }),
    },
    { $id: 'affinity/companies', title: 'Companies' },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Companies',
    schema,
    idColumnRemoteId: idPath('id'),
    titleColumnRemoteId: ['name'],
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Build the table spec for the tenant-wide Opportunities table. Unlike persons
 * and companies, this is a fixed three-column schema — Affinity v2's
 * `/v2/opportunities` endpoint returns only `id` / `name` / `listId` and there
 * is no metadata-fields endpoint. Per-list custom fields on opportunities are
 * only available through `GET /v2/lists/{listId}/list-entries`.
 */
export function buildAffinityOpportunitiesTableSpec(id: EntityId): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      id: Type.Number({ description: 'Opportunity id', [X_SCRATCH_READONLY]: true }),
      name: Type.Union([Type.String(), Type.Null()]),
      listId: Type.Number({
        description: 'Id of the list this opportunity belongs to',
        [X_SCRATCH_READONLY]: true,
      }),
    },
    { $id: 'affinity/opportunities', title: 'Opportunities' },
  );

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

// ---------------------------------------------------------------------------
// Notes — fixed-schema table, no custom field metadata endpoint.
// ---------------------------------------------------------------------------

/**
 * Build the table spec for the tenant-wide Notes table (`GET /v2/notes`).
 * Notes are fetched with `includes=companiesPreview,personsPreview,
 * opportunitiesPreview,repliesCount` so they carry rich relationship data.
 */
export function buildAffinityNotesTableSpec(id: EntityId): BaseJsonTableSpec {
  const mentionSchema = Type.Object({
    id: Type.Number(),
    type: Type.String(),
    person: personDataSchema,
  });

  const companyPreviewSchema = Type.Object({
    id: Type.Number(),
    name: Type.String(),
    domain: Type.Union([Type.String(), Type.Null()]),
  });

  const opportunityPreviewSchema = Type.Object({
    id: Type.Number(),
    name: Type.String(),
    listId: Type.Number(),
  });

  const schema = Type.Object(
    {
      id: Type.Number({ description: 'Note id', [X_SCRATCH_READONLY]: true }),
      type: Type.String({ description: 'Note type discriminator', [X_SCRATCH_READONLY]: true }),
      content: Type.Object({ html: Type.Union([Type.String(), Type.Null()]) }),
      creator: Type.Union([personDataSchema, Type.Null()], { [X_SCRATCH_READONLY]: true }),
      mentions: Type.Array(mentionSchema, { [X_SCRATCH_READONLY]: true }),
      createdAt: Type.String({ format: 'date-time', [X_SCRATCH_READONLY]: true }),
      updatedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()], { [X_SCRATCH_READONLY]: true }),
      // Included via `includes` query parameter:
      companiesPreview: Type.Optional(
        Type.Object({ data: Type.Array(companyPreviewSchema), totalCount: Type.Number() }),
      ),
      personsPreview: Type.Optional(Type.Object({ data: Type.Array(personDataSchema), totalCount: Type.Number() })),
      opportunitiesPreview: Type.Optional(
        Type.Object({ data: Type.Array(opportunityPreviewSchema), totalCount: Type.Number() }),
      ),
      repliesCount: Type.Optional(Type.Number()),
      // Discriminated fields — present on interaction / ai-notetaker types:
      interaction: Type.Optional(Type.Object({ id: Type.Number(), type: Type.String() })),
      transcriptId: Type.Optional(Type.Number()),
      parent: Type.Optional(Type.Object({ id: Type.Number() })),
    },
    { $id: 'affinity/notes', title: 'Notes' },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Notes',
    schema,
    idColumnRemoteId: idPath('id'),
    titleColumnRemoteId: ['type'],
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Entity Files (v1 API)
// ---------------------------------------------------------------------------

/**
 * Build the table spec for the Entity Files table (`GET /entity-files`, v1 API).
 * Entity files are attachments uploaded to persons, organizations, or opportunities.
 */
export function buildAffinityEntityFilesTableSpec(id: EntityId): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      id: Type.Number({ description: 'Entity file id', [X_SCRATCH_READONLY]: true }),
      name: Type.String({ description: 'File name' }),
      size: Type.Number({ description: 'File size in bytes', [X_SCRATCH_READONLY]: true }),
      person_id: Type.Union([Type.Number(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
      organization_id: Type.Union([Type.Number(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
      opportunity_id: Type.Union([Type.Number(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
      uploader_id: Type.Number({ [X_SCRATCH_READONLY]: true }),
      created_at: Type.String({ format: 'date-time', [X_SCRATCH_READONLY]: true }),
    },
    { $id: 'affinity/entity-files', title: 'Entity Files' },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Entity Files',
    schema,
    idColumnRemoteId: idPath('id'),
    titleColumnRemoteId: ['name'],
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}
