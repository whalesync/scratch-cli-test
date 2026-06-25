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
import { BaseJsonTableSpec, EntityId, idPath } from '../../types';
import { AttioApiClient } from './attio-api-client';
import { buildAttioDefaultView, LIST_VIEW_CONFIG, OBJECT_VIEW_CONFIG } from './attio-default-view';
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
 * The `id.wsId` of the Workspace Members table (see `buildAttioMembersTableSpec`
 * and the connector's `listTables`). `actor-reference` attributes are FKs onto
 * it. Must stay in sync with both sites.
 */
const MEMBERS_TABLE_WS_ID = 'workspace_members';

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
): { linkedTableId: string } | undefined {
  if (attr.type === 'actor-reference') {
    return { linkedTableId: MEMBERS_TABLE_WS_ID };
  }
  if (attr.type === 'record-reference') {
    const config = attr.config as { record_reference?: { allowed_object_ids?: unknown } } | null;
    const allowed = config?.record_reference?.allowed_object_ids;
    if (Array.isArray(allowed) && allowed.length === 1 && typeof allowed[0] === 'string') {
      const slug = objectIdToSlug.get(allowed[0]);
      if (slug) return { linkedTableId: sanitizeForTableWsId(slug) };
    }
  }
  return undefined;
}

function valueArraySchemaForAttribute(attr: AttioAttribute, objectIdToSlug: Map<string, string>): TSchema {
  const valueSchema = Type.Object({}, { additionalProperties: true });
  const virtualFields = buildVirtualField(attr);
  const foreignKey = foreignKeyOptionsForAttribute(attr, objectIdToSlug);

  return Type.Array(valueSchema, {
    description: attr.description ?? attr.title,
    [X_SCRATCH_REMOTE_FIELD_ID]: attr.api_slug,
    [X_SCRATCH_CONNECTOR_DATA_TYPE]: attr.type,
    ...(isAttributeReadonly(attr) ? { [X_SCRATCH_READONLY]: true } : {}),
    ...(virtualFields ? { [X_SCRATCH_VIRTUAL_FIELDS]: virtualFields } : {}),
    ...(foreignKey ? { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: foreignKey } : {}),
  });
}

/** Build the `values` object schema, keyed by attribute api_slug. */
function buildValuesSchema(attributes: AttioAttribute[], objectIdToSlug: Map<string, string>): TSchema {
  const properties: Record<string, TSchema> = {};
  for (const attr of attributes) {
    if (attr.is_archived) continue;
    properties[attr.api_slug] = valueArraySchemaForAttribute(attr, objectIdToSlug);
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

  const viewConfig = OBJECT_VIEW_CONFIG[objectSlug] ?? { valuesKey: 'values' };

  return {
    id,
    slug: id.wsId,
    name: resolvedDisplay.plural,
    schema,
    idColumnRemoteId: idPath('id.record_id'),
    // All three v1 objects (companies, people, deals) expose a `name` attribute
    // suitable for filenames — for people it's the `personal-name` type, for
    // companies/deals it's plain text.
    titleColumnRemoteId: ['values', 'name'],
    basePath: [],
    generatedAt: new Date().toISOString(),
    defaultView: buildAttioDefaultView(schema, viewConfig),
  };
}

/**
 * Build the table spec for a list. The schema only describes list-scoped
 * attributes (from `GET /v2/lists/{slug}/attributes`) — e.g. a deal's stage in
 * *this* pipeline. The parent record's own attributes are *not* embedded; the
 * parent objects (companies/people/deals) are already first-class tables in
 * the workbook, so duplicating their data here would only churn diffs.
 *
 * Joining a list entry back to its parent happens at read time via
 * `parent_record_id`. List entries are deliberately thin: stage + pointer.
 */
export async function buildAttioListTableSpec(
  id: EntityId,
  listSlug: string,
  listName: string,
  client: AttioApiClient,
): Promise<BaseJsonTableSpec> {
  const listAttributes = await client.listListAttributes(listSlug);
  const objectIdToSlug = await buildObjectIdToSlugMap(client);
  const entryValuesSchema = buildValuesSchema(listAttributes, objectIdToSlug);

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
    },
    { $id: `attio/list-${listSlug}`, title: listName },
  );

  return {
    id,
    slug: id.wsId,
    name: listName,
    schema,
    idColumnRemoteId: idPath('id.entry_id'),
    // List entries don't carry a name of their own; the parent_record_id is
    // the closest stable identifier for filenames + display.
    titleColumnRemoteId: ['parent_record_id'],
    basePath: ['Lists'],
    generatedAt: new Date().toISOString(),
    defaultView: buildAttioDefaultView(schema, LIST_VIEW_CONFIG),
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
    idColumnRemoteId: idPath('id.workspace_member_id'),
    titleColumnRemoteId: ['email_address'],
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
 * exists remotely (DEV-10408). `linked_records` / `assignees` are arrays
 * (leaves in the grid; editable as whole-array replacements through the raw file).
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
    idColumnRemoteId: idPath('id.task_id'),
    titleColumnRemoteId: ['content_plaintext'],
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}
