/**
 * Types for the ClickUp connector.
 *
 * ClickUp is a work-management tool with a Workspace → Space → Folder → List →
 * Task hierarchy. We model each **List** as a table and each **Task** as a
 * record (the Airtable-style dynamic shape: user-defined containers, one
 * endpoint pattern). A list's columns are the standard task fields plus the
 * **Custom Fields** defined on that list, discovered dynamically via
 * `GET /list/{list_id}/field`.
 *
 * Tasks are stored verbatim. The read shape and the write shape differ for a
 * few fields (status/priority are objects on read but a name/int on write) —
 * the connector translates those in `createRecords`/`updateRecords`; the stored
 * file always keeps ClickUp's read shape.
 *
 * Auth is a personal API token (`pk_...`) sent as the raw `Authorization`
 * header (no `Bearer` prefix) — `user_provided_params`, connectable from the CLI.
 *
 * API docs: https://developer.clickup.com/reference
 */

export const CLICKUP_BASE_URL = 'https://api.clickup.com/api/v2';

/** Docs live on a separate v3 API (`/api/v3/workspaces/{teamId}/docs`) — their own codepath. */
export const CLICKUP_BASE_URL_V3 = 'https://api.clickup.com/api/v3';

/**
 * Tasks list endpoint pages at 100 tasks/page and reports `last_page`. This is
 * ClickUp's fixed page size — it is not configurable.
 */
export const CLICKUP_TASK_PAGE_SIZE = 100;

/** Decrypted credentials: ClickUp auth is a single personal API token. */
export interface ClickUpCredentials {
  apiKey: string;
}

/**
 * Resumable pull progress. The task list endpoint is page-based, so we
 * checkpoint the next page to fetch — a stalled job resumes mid-list instead of
 * re-paging from page 0.
 */
export interface ClickUpDownloadProgress {
  [key: string]: string | number | undefined;
  nextPage?: number;
}

// --- Entity kinds (this is a multi-entity connector) ---

/**
 * ClickUp exposes more than one record type. The kind is encoded as the first
 * segment of a table's `remoteId` so `fetchJsonTableSpec`/`pullRecordFiles` can
 * dispatch:
 * - `list`  — a List's **Tasks** (the common dynamic table; `remoteId: ['list', teamId, listId]`).
 * - `users` — the workspace's **Members** (read-only; `remoteId: ['users', teamId]`).
 * - `doc`   — the workspace's **Docs** (read-only, v3 API; `remoteId: ['doc', teamId]`).
 */
export type ClickUpTableKind = 'list' | 'users' | 'doc';

/** Fixed table names for the per-workspace singleton entities (also the path segment). */
export const CLICKUP_USERS_TABLE_NAME = 'Users';
export const CLICKUP_DOCS_TABLE_NAME = 'Docs';

// --- Hierarchy shapes (only the fields we walk to discover lists) ---

export interface ClickUpMember {
  id: number;
  username?: string | null;
  email?: string | null;
  role?: number | null;
  [key: string]: unknown;
}

export interface ClickUpTeam {
  id: string;
  name: string;
  // `GET /team` returns members inline — the source for the Users entity.
  members?: { user: ClickUpMember }[];
}

/** A doc from the v3 `GET /workspaces/{teamId}/docs` endpoint (stored verbatim). */
export interface ClickUpDoc {
  id: string;
  name?: string | null;
  [key: string]: unknown;
}

export interface ClickUpSpace {
  id: string;
  name: string;
}

export interface ClickUpFolder {
  id: string;
  name: string;
  lists?: ClickUpList[];
}

export interface ClickUpList {
  id: string;
  name: string;
  // Present on `GET /list/{id}` — used to build the Scratch folder path
  // (`/{Space}/{Folder}/{List}/…`). Folderless lists sit in a `hidden` folder
  // that must be excluded from the path.
  space?: { id: string; name: string };
  folder?: { id: string; name: string; hidden?: boolean };
}

/**
 * A custom field definition from `GET /list/{list_id}/field`. Drives the
 * dynamic portion of a list's schema and the id→name/type legend surfaced to
 * agents on the verbatim `custom_fields` array.
 *
 * `type` is one of ClickUp's field types: `text`, `textarea`, `number`,
 * `currency`, `date`, `drop_down`, `labels`, `checkbox`, `url`, `email`,
 * `phone`, `rating`, `tasks` (relationship), `users`, `location`, `formula`
 * (computed/read-only), `automatic_progress`, `manual_progress`, …
 */
export interface ClickUpCustomFieldDefinition {
  id: string;
  name: string;
  type: string;
  type_config?: Record<string, unknown> | null;
}

/**
 * ClickUp custom field types whose value is server-computed and cannot be
 * written back (the API rejects writes to them).
 */
export const CLICKUP_READONLY_CUSTOM_FIELD_TYPES = new Set<string>(['formula', 'automatic_progress', 'rollup']);

/**
 * Priority is an object on read (`{ id, priority, color, orderindex }`) but an
 * integer on write. ClickUp's fixed mapping (1 = Urgent … 4 = Low).
 */
export const CLICKUP_PRIORITY_NAME_TO_INT: Record<string, number> = {
  urgent: 1,
  high: 2,
  normal: 3,
  low: 4,
};
