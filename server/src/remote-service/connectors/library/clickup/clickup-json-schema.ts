import { Type, type TSchema } from '@sinclair/typebox';
import { X_SCRATCH_AGENT_INSTRUCTIONS, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { BaseJsonTableSpec, EntityId, idPath } from '../../types';
import { CLICKUP_DOCS_TABLE_NAME, CLICKUP_USERS_TABLE_NAME, ClickUpCustomFieldDefinition } from './clickup-types';

/**
 * Builds the JSON schema for a ClickUp List (its Tasks are the records).
 *
 * The standard task fields are declared statically below — ClickUp's task shape
 * is fixed by the API (the "hardcode only when there's no per-table
 * introspection for these fields" case). The dynamic part is each list's
 * **Custom Fields**, discovered via `GET /list/{list_id}/field`; their values
 * live on each task verbatim as `custom_fields: [{ id, name, type, value }]` and
 * are stored as-is. The discovered definitions are surfaced to agents as an
 * id→name/type legend on the `custom_fields` array (so an LLM editing the file
 * knows what each entry means) without reshaping the stored data.
 *
 * Read vs write shape: `status` and `priority` come back as objects but are
 * written as a name/int; the connector translates on write. The stored file
 * always keeps ClickUp's read shape.
 */

// --- Field helpers ---

const nullableString = (): TSchema => Type.Union([Type.String(), Type.Null()]);
const nullableNumber = (): TSchema => Type.Union([Type.Number(), Type.Null()]);

/** Mark a field read-only (computed / system-managed — never sent on write). */
function readonly(schema: TSchema): TSchema {
  return { ...schema, [X_SCRATCH_READONLY]: true };
}

/** ClickUp's status object: only `status` (the name) is user-settable; the rest is server-managed. */
const statusSchema = (): TSchema =>
  Type.Union([
    Type.Object({
      status: nullableString(),
      id: nullableString(),
      color: nullableString(),
      type: nullableString(),
      orderindex: Type.Unknown(),
    }),
    Type.Null(),
  ]);

/** ClickUp's priority object (read shape). Written as an int 1–4; connector translates. */
const prioritySchema = (): TSchema =>
  Type.Union([
    Type.Object({
      id: nullableString(),
      priority: nullableString(),
      color: nullableString(),
      orderindex: Type.Unknown(),
    }),
    Type.Null(),
  ]);

const userSchema = (): TSchema =>
  Type.Object({
    id: Type.Unknown(),
    username: nullableString(),
    email: nullableString(),
    color: nullableString(),
    profilePicture: nullableString(),
  });

const referenceSchema = (): TSchema => Type.Union([Type.Object({}, { additionalProperties: true }), Type.Null()]);

const customFieldsSchema = (): TSchema =>
  Type.Array(
    Type.Object(
      {
        id: Type.String(),
        name: nullableString(),
        type: nullableString(),
        value: Type.Unknown(),
      },
      { additionalProperties: true },
    ),
  );

/**
 * Standard ClickUp task fields. The editable subset (name, description, status,
 * priority, due_date, start_date, points, time_estimate, custom_fields) is left
 * writable; everything else is system-managed and marked read-only.
 *
 * Deferred to a fast-follow (read-only in v1, documented in STATE.md):
 * `assignees`, `tags`, `watchers`, `parent` — each needs ClickUp's add/rem diff
 * semantics or a separate endpoint to write.
 */
function taskProperties(): Record<string, TSchema> {
  return {
    id: readonly(Type.String()),
    custom_id: readonly(nullableString()),
    custom_item_id: readonly(Type.Unknown()),
    name: nullableString(),
    text_content: readonly(nullableString()),
    description: nullableString(),
    status: statusSchema(),
    priority: prioritySchema(),
    due_date: nullableString(),
    start_date: nullableString(),
    points: nullableNumber(),
    time_estimate: nullableNumber(),
    date_created: readonly(nullableString()),
    date_updated: readonly(nullableString()),
    date_closed: readonly(nullableString()),
    date_done: readonly(nullableString()),
    archived: readonly(Type.Boolean()),
    creator: readonly(userSchema()),
    assignees: readonly(Type.Array(userSchema())),
    group_assignees: readonly(Type.Array(Type.Unknown())),
    watchers: readonly(Type.Array(userSchema())),
    tags: readonly(Type.Array(Type.Unknown())),
    parent: readonly(nullableString()),
    top_level_parent: readonly(nullableString()),
    orderindex: readonly(Type.Unknown()),
    checklists: readonly(Type.Array(Type.Unknown())),
    dependencies: readonly(Type.Array(Type.Unknown())),
    linked_tasks: readonly(Type.Array(Type.Unknown())),
    locations: readonly(Type.Array(Type.Unknown())),
    sharing: readonly(referenceSchema()),
    permission_level: readonly(nullableString()),
    list: readonly(referenceSchema()),
    folder: readonly(referenceSchema()),
    space: readonly(referenceSchema()),
    project: readonly(referenceSchema()),
    team_id: readonly(nullableString()),
    url: readonly(nullableString()),
    custom_fields: customFieldsSchema(),
  };
}

/**
 * Build a {@link BaseJsonTableSpec} for a ClickUp list. `customFieldDefinitions`
 * (discovered per list) become an id→name/type legend on the verbatim
 * `custom_fields` array so agents and the UI know what each entry is, without
 * reshaping the stored data.
 */
export function buildClickUpJsonTableSpec(
  id: EntityId,
  listName: string,
  customFieldDefinitions: ClickUpCustomFieldDefinition[],
  basePath: string[] = [],
): BaseJsonTableSpec {
  const properties = taskProperties();

  if (customFieldDefinitions.length > 0) {
    const legend = customFieldDefinitions.map((def) => `${def.id}=${def.name} (${def.type})`).join(', ');
    properties.custom_fields = {
      ...properties.custom_fields,
      [X_SCRATCH_AGENT_INSTRUCTIONS]:
        `Each entry's id maps to a list Custom Field: ${legend}. ` +
        `Edit an entry's \`value\` to change it; formula/rollup/progress fields are read-only. ` +
        `For a relationship ("tasks") field, the value links to other ClickUp tasks by id.`,
    };
  }

  const schema = Type.Object(properties, {
    $id: `clickup/list/${id.wsId}`,
    title: listName,
  });

  return {
    id,
    slug: id.wsId,
    name: listName,
    schema,
    idColumnRemoteId: idPath('id'),
    titleColumnRemoteId: ['name'],
    mainContentColumnRemoteId: ['description'],
    // Structural hierarchy → folder path: records land at
    // `/{Workspace}/{Space}/{Folder}/{List}/{task}.json` (Space/Folder from `basePath`).
    basePath,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Schema for the **Users** entity (a workspace's members). Read-only reference
 * table — every field is `x-scratch-readonly` (you sync members, you don't
 * create/edit them). Stored verbatim; path `/{Workspace}/Users/{user}.json`.
 */
export function buildClickUpUsersTableSpec(id: EntityId, workspaceName: string): BaseJsonTableSpec {
  const properties: Record<string, TSchema> = {
    id: readonly(Type.Number()),
    username: readonly(nullableString()),
    email: readonly(nullableString()),
    color: readonly(nullableString()),
    initials: readonly(nullableString()),
    role: readonly(Type.Union([Type.Number(), Type.Null()])),
    role_key: readonly(nullableString()),
    profilePicture: readonly(nullableString()),
    date_invited: readonly(nullableString()),
    date_joined: readonly(nullableString()),
    last_active: readonly(nullableString()),
  };
  const schema = Type.Object(properties, { $id: 'clickup/users', title: CLICKUP_USERS_TABLE_NAME });
  return {
    id,
    slug: id.wsId,
    name: CLICKUP_USERS_TABLE_NAME,
    schema,
    idColumnRemoteId: idPath('id'),
    titleColumnRemoteId: ['username'],
    basePath: workspaceName ? [workspaceName] : [],
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Schema for the **Docs** entity (a workspace's docs, from the v3 API).
 * Read-only in v1 (page content/blocks would be a heavy-field hydration
 * fast-follow). Stored verbatim; path `/{Workspace}/Docs/{doc}.json`.
 */
export function buildClickUpDocsTableSpec(id: EntityId, workspaceName: string): BaseJsonTableSpec {
  const properties: Record<string, TSchema> = {
    id: readonly(Type.String()),
    name: readonly(nullableString()),
    parent: readonly(Type.Unknown()),
    type: readonly(Type.Unknown()),
    workspace_id: readonly(nullableString()),
    creator: readonly(Type.Unknown()),
    date_created: readonly(Type.Unknown()),
    date_updated: readonly(Type.Unknown()),
    deleted: readonly(Type.Union([Type.Boolean(), Type.Null()])),
  };
  const schema = Type.Object(properties, { $id: 'clickup/docs', title: CLICKUP_DOCS_TABLE_NAME });
  return {
    id,
    slug: id.wsId,
    name: CLICKUP_DOCS_TABLE_NAME,
    schema,
    idColumnRemoteId: idPath('id'),
    titleColumnRemoteId: ['name'],
    basePath: workspaceName ? [workspaceName] : [],
    generatedAt: new Date().toISOString(),
  };
}
