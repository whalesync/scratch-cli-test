import { Type, type TSchema } from '@sinclair/typebox';
import {
  TransformerTypes,
  VirtualFieldDef,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_READONLY,
  X_SCRATCH_REMOTE_FIELD_ID,
  X_SCRATCH_VIRTUAL_FIELDS,
  X_SCRATCH_WRITE_ONCE,
} from '@spinner/shared-types';
import { sanitizeForTableWsId } from '../../ids';
import { BaseJsonTableSpec, dotPath, EntityId } from '../../types';
import { AttioApiClient } from './attio-api-client';
import { AttioAttribute, AttioAttributeType, STANDARD_OBJECT_DISPLAY, type AttioStandardObject } from './attio-types';
import { ATTIO_VALUE_EXPRESSION } from './attio-value-expressions';

/** Build a virtual field definition for an Attio attribute, if applicable. */
function buildVirtualField(attr: AttioAttribute): VirtualFieldDef[] | undefined {
  const expression = ATTIO_VALUE_EXPRESSION[attr.type];
  if (!expression) return undefined;

  // Map the extracted value to a display type
  const typeMap: Partial<Record<AttioAttributeType, string>> = {
    text: 'string',
    number: 'number',
    checkbox: 'boolean',
    currency: 'number',
    date: 'string',
    timestamp: 'string',
    rating: 'number',
    domain: 'string',
    'email-address': 'string',
    'phone-number': 'string',
    status: 'string',
    select: 'string',
    'record-reference': 'string',
    'actor-reference': 'string',
    location: 'string',
    'personal-name': 'string',
    // The extracted `interacted_at` scalar is a timestamp; the sync editor renders it
    // as a string (dates flatten to their ISO string). See DEV-11052.
    interaction: 'string',
  };

  return [
    {
      displayLabel: attr.title,
      type: typeMap[attr.type] ?? 'string',
      suggestedTransformer: {
        type: TransformerTypes.JSONPath,
        options: { expression, arrayHandling: 'first' as const },
      },
    },
  ];
}

/**
 * Build a TypeBox schema fragment for one entry in an Attio `record.values`
 * array. The shape is intentionally permissive: Attio returns a typed object
 * with `attribute_type`, `active_from`, `active_until`, plus type-specific
 * payload keys (`value`, `option`, `target_record_id`, etc.). Modeling every
 * inner shape brittle-ly would burn the whole appetite — and we round-trip
 * verbatim anyway, so the on-disk file is authoritative.
 *
 * The `CONNECTOR_DATA_TYPE` annotation preserves the attribute type for the
 * client UI and any future field-level transforms. `REMOTE_FIELD_ID` carries
 * the api_slug so syncs can address the field by its remote name.
 *
 * For types where the useful value is buried inside the array element,
 * `X_SCRATCH_VIRTUAL_FIELDS` provides a JSONPath-based extraction so the UI
 * and sync editor can present a clean scalar instead of the raw array.
 */
/**
 * Whether an attribute is read-only — i.e. the Attio API won't accept writes
 * to it, so the UI must not let a user spend an edit publish will silently drop.
 *
 * The precise signal is **`is_writable === false`**, which Attio returns for
 * computed / system-managed fields: `record_id`, `created_at`, `created_by`,
 * the `*_interaction` timestamps, `strongest_connection_*`, `logo_url`,
 * follower counts, etc. Archived attributes are read-only too.
 *
 * Deliberately **not** keyed off `is_system_attribute`: Attio sets that `true`
 * for nearly every standard field, *including fully writable ones* (`name`,
 * `description`, `domains`, the social handles), so using it as a read-only
 * signal would wrongly lock editable fields and waste user edits. Verified
 * live against `/v2/objects/companies/attributes` and a list's attributes on
 * 2026-06-12 (`name`/`description`: sys=true, writable=true; `record_id`/
 * `created_at`: sys=true, writable=false). `is_writable` is optional in the
 * type, so `=== false` (not `!attr.is_writable`) keeps an absent flag writable.
 */
function isAttributeReadonly(attr: AttioAttribute): boolean {
  return attr.is_archived || attr.is_writable === false;
}

/**
 * The Workspace Members table's **remote id** (`EntityId.remoteId`), which is what
 * gets persisted as its `DataFolder.tableId` on import. `actor-reference` attributes
 * are foreign keys onto this table, and the create-plan generator resolves a foreign
 * key by matching its `linkedTableId` against each source folder's `tableId`
 * (`schema-builder.service.ts` sets `remoteTableIds` to that folder's
 * `linkedTableIdCandidateTokensForRemoteTableId`). So the FK
 * target MUST be the members table's `remoteId`, NOT its `wsId`.
 *
 * These two diverge ONLY for the members table: `listTables` gives it
 * `{ wsId: 'workspace_members', remoteId: ['members'] }`. For the standard objects
 * they coincide (`wsId === remoteId[0] === api_slug`), which is why record-reference
 * FKs — keyed off the slug — resolve fine. Keying the actor-reference FK off the
 * `wsId` ('workspace_members') instead left it permanently `needs_target`: it could
 * never bind to the Members table even when that table was in the plan, so the field
 * was uncheckable in the Live Export create wizard (DEV-11052). Exported and reused
 * by the connector's `listTables` / `parseAttioTableId` so the two can't drift.
 */
export const ATTIO_MEMBERS_TABLE_REMOTE_ID = ['members'] as const;
const MEMBERS_FOREIGN_KEY_LINKED_TABLE_ID = ATTIO_MEMBERS_TABLE_REMOTE_ID[0];

/**
 * Foreign-key options for an attribute, if it's a relation we can declare:
 *   - **`record-reference`** → the target object's table, but only when the
 *     reference is **single-target** (`config.record_reference.allowed_object_ids`
 *     has exactly one object). Multi-target references are deferred — a single
 *     `linkedTableId` can't express "either of N tables" (P1 / STATE TODO).
 *   - **`actor-reference`** → the Workspace Members table.
 *
 * `objectIdToSlug` maps an Attio object **id** (the config stores ids, not
 * slugs) to its api_slug; the FK's `linkedTableId` is the sanitized slug, which
 * matches how object tables are keyed in `listTables`.
 */
function foreignKeyOptionsForAttribute(
  attr: AttioAttribute,
  objectIdToSlug: Map<string, string>,
): { linkedTableId: string; linkedTableRemoteId?: string[] } | undefined {
  if (attr.type === 'actor-reference') {
    // The Members table's remoteId is `['members']` (ATTIO_MEMBERS_TABLE_REMOTE_ID) —
    // its wsId ('workspace_members') diverges, but linkedTableId already uses the
    // remoteId segment, so linkedTableRemoteId is that same single-element array.
    return {
      linkedTableId: MEMBERS_FOREIGN_KEY_LINKED_TABLE_ID,
      linkedTableRemoteId: [...ATTIO_MEMBERS_TABLE_REMOTE_ID],
    };
  }
  if (attr.type === 'record-reference') {
    const config = attr.config as { record_reference?: { allowed_object_ids?: unknown } } | null;
    const allowed = config?.record_reference?.allowed_object_ids;
    if (Array.isArray(allowed) && allowed.length === 1 && typeof allowed[0] === 'string') {
      const slug = objectIdToSlug.get(allowed[0]);
      // `listTables` gives an object table `remoteId: [api_slug]` (the RAW slug),
      // while its wsId — and this FK's linkedTableId — is the SANITIZED slug. So
      // linkedTableRemoteId must carry the raw slug, not the sanitized token.
      if (slug) return { linkedTableId: sanitizeForTableWsId(slug), linkedTableRemoteId: [slug] };
    }
  }
  return undefined;
}

function valueArraySchemaForAttribute(
  attr: AttioAttribute,
  objectIdToSlug: Map<string, string>,
  opts?: { forceReadonly?: boolean },
): TSchema {
  const valueSchema = Type.Object({}, { additionalProperties: true });
  const virtualFields = buildVirtualField(attr);
  const foreignKey = foreignKeyOptionsForAttribute(attr, objectIdToSlug);

  return Type.Array(valueSchema, {
    description: attr.description ?? attr.title,
    [X_SCRATCH_REMOTE_FIELD_ID]: attr.api_slug,
    [X_SCRATCH_CONNECTOR_DATA_TYPE]: attr.type,
    ...(opts?.forceReadonly || isAttributeReadonly(attr) ? { [X_SCRATCH_READONLY]: true } : {}),
    ...(virtualFields ? { [X_SCRATCH_VIRTUAL_FIELDS]: virtualFields } : {}),
    ...(foreignKey ? { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: foreignKey } : {}),
  });
}

/**
 * Build the `values` object schema, keyed by attribute api_slug.
 *
 * `forceReadonly` marks every attribute read-only regardless of Attio's
 * `is_writable` flag — used for the hydrated `parent_record.values` on list
 * tables, where edits belong on the parent object's own table (a list-entry
 * write only ever sends `entry_values`).
 */
function buildValuesSchema(
  attributes: AttioAttribute[],
  objectIdToSlug: Map<string, string>,
  opts?: { forceReadonly?: boolean },
): TSchema {
  const properties: Record<string, TSchema> = {};
  for (const attr of attributes) {
    if (attr.is_archived) continue;
    properties[attr.api_slug] = valueArraySchemaForAttribute(attr, objectIdToSlug, opts);
  }
  return Type.Object(properties, {
    description: 'Attio attribute values, keyed by api_slug',
    additionalProperties: false,
  });
}

/** Map every object's Attio **id** → its api_slug (record-reference configs store ids). */
async function buildObjectIdToSlugMap(client: AttioApiClient): Promise<Map<string, string>> {
  const objects = await client.listObjects();
  return new Map(objects.map((obj) => [obj.id.object_id, obj.api_slug]));
}

/**
 * Build the table spec for one of the three v1 standard objects (companies,
 * people, deals). The attributes list comes from `GET /v2/objects/{slug}/attributes`
 * — including any custom fields the workspace has added.
 */
export async function buildAttioObjectTableSpec(
  id: EntityId,
  objectSlug: string,
  client: AttioApiClient,
  display?: { singular: string; plural: string },
): Promise<BaseJsonTableSpec> {
  const attributes = await client.listObjectAttributes(objectSlug);
  const objectIdToSlug = await buildObjectIdToSlugMap(client);
  const valuesSchema = buildValuesSchema(attributes, objectIdToSlug);
  // Standard objects (companies/people/deals) fall back to the curated labels;
  // every other object (events, products, users, workspaces, custom objects)
  // passes its nouns in from `listObjects`, with the api_slug as a last resort.
  const resolvedDisplay = display ??
    STANDARD_OBJECT_DISPLAY[objectSlug as AttioStandardObject] ?? { singular: objectSlug, plural: objectSlug };

  const schema = Type.Object(
    {
      id: Type.Object(
        {
          workspace_id: Type.String(),
          object_id: Type.String(),
          record_id: Type.String(),
        },
        { [X_SCRATCH_READONLY]: true, description: 'Attio record id triple' },
      ),
      created_at: Type.String({ format: 'date-time', [X_SCRATCH_READONLY]: true }),
      web_url: Type.Optional(Type.String({ [X_SCRATCH_READONLY]: true })),
      values: valuesSchema,
    },
    { $id: `attio/${objectSlug}`, title: resolvedDisplay.plural },
  );

  return {
    id,
    slug: id.wsId,
    name: resolvedDisplay.plural,
    schema,
    idPath: dotPath('id.record_id'),
    titlePath: dotPath(`values.${titleAttributeSlug(attributes)}`),
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Pick the attribute that best serves as an object's human title. Every
 * standard object has a `name` attribute (plain text, or `personal-name` for
 * people); custom objects usually do too, but aren't required to — for those,
 * fall back to the first text-like attribute, and finally to `name` anyway
 * (a missing title value just means the generic filename fallback kicks in).
 */
function titleAttributeSlug(attributes: AttioAttribute[]): string {
  const activeAttributes = attributes.filter((attr) => !attr.is_archived);
  const nameAttribute = activeAttributes.find((attr) => attr.api_slug === 'name');
  if (nameAttribute) return nameAttribute.api_slug;
  const firstTextLikeAttribute = activeAttributes.find((attr) => attr.type === 'text' || attr.type === 'personal-name');
  return firstTextLikeAttribute?.api_slug ?? 'name';
}

/**
 * Build the table spec for a list. Two attribute sets combine into one table:
 *
 *   - **List-scoped attributes** (from `GET /v2/lists/{slug}/attributes`) —
 *     e.g. a deal's stage in *this* pipeline — live under `entry_values` and
 *     are the entry's own writable fields.
 *   - **The parent object's attributes** (from
 *     `GET /v2/objects/{parent}/attributes`) — the fields Attio's own list UI
 *     shows as columns — live under the hydrated, read-only `parent_record`
 *     (see `AttioListEntry.parent_record`; the connector embeds the parent
 *     record verbatim on pull). Declared only for single-parent lists: a
 *     multi-parent list (theoretical in Attio's API) has no one attribute set
 *     to describe, so its entries keep just the pointer fields.
 *
 * `parent_record` is optional — hydration can miss (parent deleted between
 * the entries page and the hydrate query) — and fully read-only: edits to
 * parent fields belong on the parent object's own table, and list-entry
 * writes only ever send `entry_values` (+ the parent pointer on create).
 */
export async function buildAttioListTableSpec(
  id: EntityId,
  listSlug: string,
  listName: string,
  parentObjectSlugs: string[],
  client: AttioApiClient,
): Promise<BaseJsonTableSpec> {
  const listAttributes = await client.listListAttributes(listSlug);
  const objectIdToSlug = await buildObjectIdToSlugMap(client);
  const entryValuesSchema = buildValuesSchema(listAttributes, objectIdToSlug);

  const singleParentObjectSlug = parentObjectSlugs.length === 1 ? parentObjectSlugs[0] : undefined;
  const parentAttributes = singleParentObjectSlug ? await client.listObjectAttributes(singleParentObjectSlug) : [];
  const parentRecordSchema =
    singleParentObjectSlug === undefined
      ? undefined
      : Type.Optional(
          Type.Object(
            {
              id: Type.Object(
                {
                  workspace_id: Type.String(),
                  object_id: Type.String(),
                  record_id: Type.String(),
                },
                { description: 'Attio record id triple of the parent record' },
              ),
              created_at: Type.Optional(Type.String({ format: 'date-time' })),
              web_url: Type.Optional(Type.String()),
              values: buildValuesSchema(parentAttributes, objectIdToSlug, { forceReadonly: true }),
            },
            {
              [X_SCRATCH_READONLY]: true,
              description:
                `The parent ${singleParentObjectSlug} record this entry wraps, hydrated by the connector on pull ` +
                '(the Attio entries API returns only the parent_record_id pointer). Read-only: edit these fields ' +
                'on the parent object table.',
            },
          ),
        );

  const schema = Type.Object(
    {
      id: Type.Object(
        {
          workspace_id: Type.String(),
          list_id: Type.String(),
          entry_id: Type.String(),
        },
        { [X_SCRATCH_READONLY]: true, description: 'Attio list-entry id triple' },
      ),
      // `createListEntry` requires these on the file, so they are editable
      // while the entry is new — but a list entry can't be re-parented, so they
      // are **write-once**: once the entry exists remotely the desktop renders
      // them read-only (combining `x-scratch-write-once` with the row's
      // new-vs-existing state) and the scratch-git validator warns if they are
      // changed on an existing entry. See X_SCRATCH_WRITE_ONCE (DEV-10408).
      parent_record_id: Type.String({ [X_SCRATCH_WRITE_ONCE]: true }),
      parent_object: Type.String({ [X_SCRATCH_WRITE_ONCE]: true }),
      created_at: Type.String({ format: 'date-time', [X_SCRATCH_READONLY]: true }),
      entry_values: entryValuesSchema,
      ...(parentRecordSchema ? { parent_record: parentRecordSchema } : {}),
    },
    { $id: `attio/list-${listSlug}`, title: listName },
  );

  // The parent record's `name` attribute is the natural human identifier for
  // an entry (it's what Attio's own list UI leads with). Fall back to the
  // parent_record_id pointer when the parent object has no `name` attribute
  // (possible for custom objects) or the list is multi-parent.
  const parentHasNameAttribute = parentAttributes.some((attr) => attr.api_slug === 'name' && !attr.is_archived);
  const titlePath = parentHasNameAttribute ? dotPath('parent_record.values.name') : dotPath('parent_record_id');

  return {
    id,
    slug: id.wsId,
    name: listName,
    schema,
    idPath: dotPath('id.entry_id'),
    titlePath,
    basePath: ['Lists'],
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Build the table spec for workspace members (`GET /v2/workspace_members`).
 *
 * Members have a **fixed, flat shape** and Attio exposes no attribute-discovery
 * endpoint for them, so the schema is hardcoded from the API's documented
 * fields (the sanctioned exception to dynamic discovery). The whole record is
 * **read-only** — members are a reference directory we sync, not something the
 * connector creates/edits/deletes (the `TablePreview` also marks all writes
 * disabled). Path: `/Workspace Members/{member}.json` (basePath `[]`), kept
 * distinct from the standard `users` *object* at `/Users/`.
 */
export function buildAttioMembersTableSpec(id: EntityId): BaseJsonTableSpec {
  const ro = { [X_SCRATCH_READONLY]: true } as const;
  const schema = Type.Object(
    {
      id: Type.Object(
        { workspace_id: Type.String(), workspace_member_id: Type.String() },
        { ...ro, description: 'Attio workspace-member id' },
      ),
      first_name: Type.String(ro),
      last_name: Type.String(ro),
      email_address: Type.String(ro),
      avatar_url: Type.Union([Type.String(), Type.Null()], ro),
      access_level: Type.String(ro),
      created_at: Type.String({ format: 'date-time', ...ro }),
    },
    { $id: 'attio/workspace-members', title: 'Workspace Members' },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Workspace Members',
    schema,
    idPath: dotPath('id.workspace_member_id'),
    titlePath: dotPath('email_address'),
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Build the table spec for tasks (`GET /v2/tasks`). Hardcoded shape (no
 * attribute-discovery endpoint), distinct from the object `values[]` envelope.
 *
 * Read-only: `id`, `completed_at`, `created_by_actor`, `created_at` (all
 * system-set). `content_plaintext` is settable on create but **immutable on
 * update** (Attio rejects content changes), so it is marked **write-once**
 * (`x-scratch-write-once`): editable while the task is new, read-only once it
 * exists remotely (DEV-10408). `assignees` is a multi-valued `actor-reference`,
 * so it carries a foreign key onto the Workspace Members table (like the object
 * `actor-reference` attributes) — DEV-11052. `linked_records` is a multi-target
 * relation (its `target_object` varies per row), which a single `linkedTableId`
 * can't express, so it stays a plain array leaf.
 */
export function buildAttioTasksTableSpec(id: EntityId): BaseJsonTableSpec {
  const ro = { [X_SCRATCH_READONLY]: true } as const;
  const schema = Type.Object(
    {
      id: Type.Object({ workspace_id: Type.String(), task_id: Type.String() }, { ...ro, description: 'Attio task id' }),
      content_plaintext: Type.String({
        description: 'Task content (write-once: settable on create, immutable after)',
        [X_SCRATCH_WRITE_ONCE]: true,
      }),
      is_completed: Type.Boolean(),
      completed_at: Type.Union([Type.String({ format: 'date-time' }), Type.Null()], ro),
      deadline_at: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
      linked_records: Type.Array(
        Type.Object({ target_object: Type.String(), target_record_id: Type.String() }, { additionalProperties: true }),
      ),
      assignees: Type.Array(
        Type.Object(
          { referenced_actor_type: Type.String(), referenced_actor_id: Type.String() },
          { additionalProperties: true },
        ),
        {
          // Assignees are workspace members: declare the FK so Live Export / sync
          // treats it as a relation onto the Members table instead of opaque text.
          // Multi-valued (a task can have several assignees).
          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
            linkedTableId: MEMBERS_FOREIGN_KEY_LINKED_TABLE_ID,
            // Members table's full remoteId (`['members']`), matching listTables.
            linkedTableRemoteId: [...ATTIO_MEMBERS_TABLE_REMOTE_ID],
            isSingleValued: false,
          },
        },
      ),
      created_by_actor: Type.Union([Type.Object({}, { additionalProperties: true }), Type.Null()], ro),
      created_at: Type.String({ format: 'date-time', ...ro }),
    },
    { $id: 'attio/tasks', title: 'Tasks' },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Tasks',
    schema,
    idPath: dotPath('id.task_id'),
    titlePath: dotPath('content_plaintext'),
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}
