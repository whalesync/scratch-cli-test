import { Type, type TSchema } from '@sinclair/typebox';
import {
  X_SCRATCH_AGENT_INSTRUCTIONS,
  X_SCRATCH_ARRAY_KEYED_BY,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { BaseJsonTableSpec, EntityId, dotPath } from '../../types';
import { AffinityApiClient } from './affinity-api-client';
import {
  X_SCRATCH_AFFINITY_FIELDS_BY_ID,
  buildAffinityFieldSchemasById,
  buildAffinityFieldsArrayKeyedByOptions,
  isReadOnlyAffinityField,
} from './affinity-fields';
import { AffinityEntityType, AffinityFieldMetadata, AffinityList, AffinityValueType } from './affinity-types';

// wsIds of the tenant tables that FK fields point at. These mirror the
// `TENANT_*_ID` sentinels in affinity-connector.ts (which sets each tenant
// table's `id.wsId` to exactly these strings); kept as literals here to avoid a
// circular import (the connector imports the build functions from this file).
const PEOPLE_TABLE_WS_ID = 'persons';
const COMPANIES_TABLE_WS_ID = 'companies';
const OPPORTUNITIES_TABLE_WS_ID = 'opportunities';

// Record "basics" (firstName/lastName/emailAddresses on persons; name/domain on
// companies; name on opportunities) are **writable via the v1 API** (DEV-10298
// phase 2) — the connector routes their edits through v1 `PUT` while field
// values go through v2. They are intentionally NOT read-only on the tenant
// People/Companies/Opportunities tables. Server-derived siblings stay
// read-only: `primaryEmailAddress` (first of `emailAddresses`), `domains`,
// `isGlobal`, `type`, `id`, `listId`. The writable keys must match
// `*_WRITABLE_BASIC_KEYS` in affinity-write-translation.ts. (List-entry-wrapped
// entities keep basics read-only — edit basics on the tenant tables.)

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
export function valueSchemaForType(valueType: AffinityValueType): TSchema {
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
 * Build the `value` union for a verbatim `fields` element. A record mixes value
 * shapes across field types in one array, so the element `value` accepts any of
 * the discovered fields' `valueType` shapes (via {@link valueSchemaForType}),
 * plus a permissive `{ type, data }` fallback (covers a future/unknown field
 * type the metadata fetch didn't cover) and `null` (empty field). Duplicate
 * valueTypes are collapsed. The per-column renderer type comes from the
 * `x-scratch-array-keyed-by` annotation, not this schema.
 */
function buildFieldElementValueSchema(fieldMetadata: AffinityFieldMetadata[]): TSchema {
  const seenValueTypes = new Set<string>();
  const valueUnionMembers: TSchema[] = [];
  for (const metadata of fieldMetadata) {
    if (seenValueTypes.has(metadata.valueType)) continue;
    seenValueTypes.add(metadata.valueType);
    valueUnionMembers.push(valueSchemaForType(metadata.valueType));
  }
  // Permissive fallback + null so a verbatim record always validates.
  valueUnionMembers.push(Type.Object({ type: Type.String(), data: Type.Unknown() }, { additionalProperties: true }));
  valueUnionMembers.push(Type.Null());
  return Type.Union(valueUnionMembers);
}

/**
 * Build the verbatim `fields` array property, annotated with
 * `x-scratch-array-keyed-by` so the generic engines expand each element into its
 * own editable column addressed by its `id` — the WHOLE element is the value
 * (no `valuePath`). The element is typed permissively (`additionalProperties:
 * true`, a permissive `value` union) because one record mixes field shapes; the
 * per-field `valueType` + read-only bit the write layer / default view need are
 * carried in the {@link X_SCRATCH_AFFINITY_FIELDS_BY_ID} map. Stored exactly as
 * Affinity returns it — no array→object reshape on disk.
 */
function buildFieldsArrayProperty(fieldMetadata: AffinityFieldMetadata[]): TSchema {
  const elementSchema = Type.Object(
    {
      id: Type.String({ [X_SCRATCH_READONLY]: true }),
      name: Type.Optional(Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true })),
      type: Type.Optional(Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true })),
      enrichmentSource: Type.Optional(Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true })),
      value: buildFieldElementValueSchema(fieldMetadata),
    },
    { additionalProperties: true },
  );
  return Type.Array(elementSchema, {
    description: 'Affinity field values, stored verbatim as `[{ id, name, type, enrichmentSource, value }]`.',
    [X_SCRATCH_ARRAY_KEYED_BY]: buildAffinityFieldsArrayKeyedByOptions(fieldMetadata),
    [X_SCRATCH_AFFINITY_FIELDS_BY_ID]: buildAffinityFieldSchemasById(fieldMetadata),
  });
}

/**
 * Agent-readable legend describing the verbatim `fields` array and each field's
 * id / name / type / value-type / read-only status. Mounted at the schema ROOT
 * (like Copper's) so the array isn't an opaque leaf column.
 */
function buildFieldsAgentInstructions(fieldMetadata: AffinityFieldMetadata[], fieldsPathPrefix: string): string {
  const shapeHint =
    `Affinity field values are stored verbatim in the \`${fieldsPathPrefix}\` array as ` +
    '`[{ id, name, type, enrichmentSource, value: { type, data } }]`. Edit a field by its id ' +
    `(path \`${fieldsPathPrefix}.[id=<id>]\`, drilling into \`.value.data\`); never reorder or drop elements.`;
  if (fieldMetadata.length === 0) {
    return `${shapeHint} This table has no Affinity fields defined.`;
  }
  const fieldLines = fieldMetadata.map((metadata) => {
    const readonlySuffix = isReadOnlyAffinityField(metadata.type, metadata.valueType) ? ', read-only' : '';
    return `- ${metadata.name} (id: ${metadata.id}, category: ${metadata.type}, value type: ${metadata.valueType}${readonlySuffix})`;
  });
  return `${shapeHint}\nAffinity field definitions for this table:\n${fieldLines.join('\n')}`;
}

/**
 * Build the inner `entity` schema for a list entry, which differs by entity
 * type (Company, Person, OpportunityWithFields). The discovered list-fields are
 * mounted under `entity.fields` as a verbatim array, annotated with
 * `x-scratch-array-keyed-by` so each field is addressable by its id via the
 * filter path `entity.fields.[id=field-1234]`.
 */
function buildEntitySchema(entityType: AffinityEntityType, fieldMetadata: AffinityFieldMetadata[]): TSchema {
  const fieldsArray = buildFieldsArrayProperty(fieldMetadata);

  switch (entityType) {
    case 'company':
      return Type.Object({
        id: Type.Number({ [X_SCRATCH_READONLY]: true }),
        name: Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
        domain: Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
        domains: Type.Array(Type.String(), { [X_SCRATCH_READONLY]: true }),
        isGlobal: Type.Boolean({ [X_SCRATCH_READONLY]: true }),
        fields: fieldsArray,
      });

    case 'person':
      return Type.Object({
        id: Type.Number({ [X_SCRATCH_READONLY]: true }),
        firstName: Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
        lastName: Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
        primaryEmailAddress: Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
        emailAddresses: Type.Array(Type.String(), { [X_SCRATCH_READONLY]: true }),
        type: Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
        fields: fieldsArray,
      });

    case 'opportunity':
      return Type.Object({
        id: Type.Number({ [X_SCRATCH_READONLY]: true }),
        name: Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
        listId: Type.Number({ [X_SCRATCH_READONLY]: true }),
        fields: fieldsArray,
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

  const entitySchema = buildEntitySchema(list.type, fieldMetadata);

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
      // Field id→name/type legend for agents, at the schema ROOT so it does not
      // turn `entity.fields` into an opaque leaf column.
      [X_SCRATCH_AGENT_INSTRUCTIONS]: buildFieldsAgentInstructions(fieldMetadata, 'entity.fields'),
    },
  );

  // Title field varies by entity type — Person uses firstName since lastName is nullable.
  const titlePath = dotPath(list.type === 'person' ? 'entity.firstName' : 'entity.name');

  return {
    id,
    slug: id.wsId,
    name: list.name,
    schema,
    idPath: dotPath('id'),
    titlePath,
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

  const schema = Type.Object(
    {
      id: Type.Number({ description: 'Person id', [X_SCRATCH_READONLY]: true }),
      // Writable basics → v1 PUT /persons (phase 2).
      firstName: Type.Union([Type.String(), Type.Null()]),
      lastName: Type.Union([Type.String(), Type.Null()]),
      // Derived from `emailAddresses` — read-only; edit the array instead.
      primaryEmailAddress: Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
      emailAddresses: Type.Array(Type.String()),
      type: Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
      fields: buildFieldsArrayProperty(fieldMetadata),
    },
    {
      $id: 'affinity/persons',
      title: 'People',
      [X_SCRATCH_AGENT_INSTRUCTIONS]: buildFieldsAgentInstructions(fieldMetadata, 'fields'),
    },
  );

  return {
    id,
    slug: id.wsId,
    name: 'People',
    schema,
    idPath: dotPath('id'),
    // No `entity.` prefix — tenant records are flat. firstName chosen over
    // lastName because lastName is nullable in Affinity.
    titlePath: dotPath('firstName'),
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

  const schema = Type.Object(
    {
      id: Type.Number({ description: 'Company id', [X_SCRATCH_READONLY]: true }),
      // Writable basics → v1 PUT /organizations (phase 2).
      name: Type.Union([Type.String(), Type.Null()]),
      domain: Type.Union([Type.String(), Type.Null()]),
      // `domains` is the server-maintained set (derived from `domain` + enrichment); read-only.
      domains: Type.Array(Type.String(), { [X_SCRATCH_READONLY]: true }),
      isGlobal: Type.Boolean({ [X_SCRATCH_READONLY]: true }),
      fields: buildFieldsArrayProperty(fieldMetadata),
    },
    {
      $id: 'affinity/companies',
      title: 'Companies',
      [X_SCRATCH_AGENT_INSTRUCTIONS]: buildFieldsAgentInstructions(fieldMetadata, 'fields'),
    },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Companies',
    schema,
    idPath: dotPath('id'),
    titlePath: dotPath('name'),
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
      // Writable → v1 PUT /opportunities (phase 2). `listId` stays read-only: it's
      // required on create (which opportunity-type list to create in) but the v2
      // read returns it as the opportunity's home list and it isn't re-targetable here.
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
    idPath: dotPath('id'),
    titlePath: dotPath('name'),
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
      // Included via `includes` query parameter — server-computed previews of
      // the note's associations, not writable as such (association edits go
      // through the note-update endpoint's persons/companies/opportunities
      // arrays, not these preview shapes):
      companiesPreview: Type.Optional(
        Type.Object(
          { data: Type.Array(companyPreviewSchema), totalCount: Type.Number() },
          { [X_SCRATCH_READONLY]: true },
        ),
      ),
      personsPreview: Type.Optional(
        Type.Object({ data: Type.Array(personDataSchema), totalCount: Type.Number() }, { [X_SCRATCH_READONLY]: true }),
      ),
      opportunitiesPreview: Type.Optional(
        Type.Object(
          { data: Type.Array(opportunityPreviewSchema), totalCount: Type.Number() },
          { [X_SCRATCH_READONLY]: true },
        ),
      ),
      repliesCount: Type.Optional(Type.Number({ [X_SCRATCH_READONLY]: true })),
      // Discriminated fields — present on interaction / ai-notetaker types:
      interaction: Type.Optional(
        Type.Object({ id: Type.Number(), type: Type.String() }, { [X_SCRATCH_READONLY]: true }),
      ),
      transcriptId: Type.Optional(Type.Number({ [X_SCRATCH_READONLY]: true })),
      parent: Type.Optional(Type.Object({ id: Type.Number() }, { [X_SCRATCH_READONLY]: true })),
    },
    { $id: 'affinity/notes', title: 'Notes' },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Notes',
    schema,
    idPath: dotPath('id'),
    titlePath: dotPath('type'),
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Users (workspace teammates) — read-only reference table, fixed schema.
// ---------------------------------------------------------------------------

/**
 * Build the table spec for the Users table (`GET /v2/users`). Workspace
 * teammates (the people with Affinity accounts in this org) — a read-only
 * reference entity, distinct from `persons` (CRM contacts). Every field is
 * read-only: the connector never creates/edits/deletes users.
 */
export function buildAffinityUsersTableSpec(id: EntityId): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      id: Type.Number({ description: 'User id', [X_SCRATCH_READONLY]: true }),
      firstName: Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
      lastName: Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
      photoUrl: Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
      primaryEmailAddress: Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
      status: Type.String({ description: 'Account status (e.g. active)', [X_SCRATCH_READONLY]: true }),
      emailAddresses: Type.Array(Type.String(), { [X_SCRATCH_READONLY]: true }),
      role: Type.String({ description: 'Workspace role (e.g. admin)', [X_SCRATCH_READONLY]: true }),
    },
    { $id: 'affinity/users', title: 'Users' },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Users',
    schema,
    idPath: dotPath('id'),
    titlePath: dotPath('firstName'),
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
      // Read-only: the v1 entity-files API has no metadata-update endpoint.
      name: Type.String({ description: 'File name', [X_SCRATCH_READONLY]: true }),
      size: Type.Number({ description: 'File size in bytes', [X_SCRATCH_READONLY]: true }),
      // The attachment's parent entity. These are bare scalar ids (the only
      // clean FK surface in the connector — every other Affinity reference is a
      // decorated object nested inside a field value). Read-only/navigation FKs:
      // entity files have no v1 metadata-update endpoint, so the link can be
      // followed but not re-parented from Scratch.
      person_id: Type.Union([Type.Number(), Type.Null()], {
        [X_SCRATCH_READONLY]: true,
        [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: PEOPLE_TABLE_WS_ID },
      }),
      organization_id: Type.Union([Type.Number(), Type.Null()], {
        [X_SCRATCH_READONLY]: true,
        [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: COMPANIES_TABLE_WS_ID },
      }),
      opportunity_id: Type.Union([Type.Number(), Type.Null()], {
        [X_SCRATCH_READONLY]: true,
        [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: OPPORTUNITIES_TABLE_WS_ID },
      }),
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
    idPath: dotPath('id'),
    titlePath: dotPath('name'),
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}
