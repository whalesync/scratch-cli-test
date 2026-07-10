/**
 * The fixed **standalone-pages table** (DEV-10568).
 *
 * Backs up every standalone (non-database) Notion page the integration can see
 * into one flat folder — one verbatim page object per file. Files are named
 * from the page title like database tables (via `titlePath`; the framework
 * appends the page id on a duplicate title, falls back to the id for untitled
 * pages, and keeps an existing file's name sticky across pulls), while record
 * *identity* stays the page id (`idPath`).
 * Enumeration uses Notion's Search endpoint filtered to `object: 'page'`; pages
 * owned by a database (parent `database_id` / `data_source_id`) are rows of the
 * existing database tables and are excluded. The page's `parent` pointer is
 * preserved verbatim in each file, so the page hierarchy can be derived later
 * as a *view* without a re-pull — the flat folder is the permanent storage
 * layout, never a stepping stone to folder nesting.
 *
 * Writes: the table supports the full surface Notion's public API offers for
 * standalone pages — **title edits** (the only writable property a page
 * outside a database has), **deletes** (trash, like database rows), and
 * **creates**, where the new record file's own `parent.page_id` names the
 * destination (Notion inserts the `child_page` block into the parent itself;
 * workspace-level creates are impossible through the public API and fail
 * fast). Page body content (`page_content`) stays read-only — the same as
 * database tables, where the block-write machinery is not wired up either.
 *
 * This module owns everything specific to that table: the sentinel table id,
 * the table preview, the hand-built table spec (Notion has no introspectable
 * schema covering "all pages", so per the "hardcode a schema only when the API
 * offers no introspection" rule the system fields are curated here), and the
 * database-row exclusion predicate. The connector dispatches to these on
 * `id.remoteId[0]` — the only table-id slot that survives the DataFolder
 * round-trip through the database.
 */
import type { DataSourceObjectResponse, PageObjectResponse } from '@notionhq/client';
import { Type, type TSchema } from '@sinclair/typebox';
import {
  AssetFieldOptions,
  TransformerTypes,
  X_SCRATCH_ASSET_FIELD,
  X_SCRATCH_READONLY,
  X_SCRATCH_SUGGESTED_TRANSFORMER,
} from '@spinner/shared-types';
import { sanitizeForTableWsId } from '../../ids';
import { BaseJsonTableSpec, EntityId, TablePreview, dotPath } from '../../types';
import { buildNotionStandalonePagesDefaultView } from './notion-default-view';
import { notionPropertyToJsonSchema } from './notion-json-schema';

/**
 * Sentinel table id for the standalone-pages backup table. Lives in
 * `remoteId[0]` (and therefore also becomes the reconstructed `wsId`) because
 * only `remoteId` survives the DataFolder round-trip through the database —
 * see the "Fixed vs. user-defined tables" section of the connector guide. A
 * real Notion table id is always a UUID, so the sentinel can never collide.
 */
export const NOTION_STANDALONE_PAGES_TABLE_ID = 'WS_STANDALONE_PAGES';

export const NOTION_STANDALONE_PAGES_DISPLAY_NAME = 'Page Tree';

/** True when a folder/table id addresses the standalone-pages backup table. */
export function isNotionStandalonePagesTable(id: EntityId): boolean {
  return id.remoteId[0] === NOTION_STANDALONE_PAGES_TABLE_ID;
}

/**
 * True when a page returned by Search is owned by a database — i.e. it is a
 * row of a Notion database (parent `database_id` on older API versions,
 * `data_source_id` under 2025-09-03+; Search can return either depending on
 * when the page was indexed), not a standalone page. Database rows belong to
 * the existing per-database tables and are excluded from the backup.
 * Standalone pages carry `workspace`, `page_id`, or `block_id` parents.
 */
export function isDatabaseOwnedNotionPage(page: PageObjectResponse): boolean {
  const parentType: string = page.parent.type;
  return parentType === 'database_id' || parentType === 'data_source_id';
}

/** The fixed table preview offered alongside the searched databases. */
export function buildNotionStandalonePagesTablePreview(): TablePreview {
  return {
    id: { wsId: NOTION_STANDALONE_PAGES_TABLE_ID, remoteId: [NOTION_STANDALONE_PAGES_TABLE_ID] },
    displayName: NOTION_STANDALONE_PAGES_DISPLAY_NAME,
    infoNote:
      'A backup of every standalone page this connection can see — pages that live in the workspace or under ' +
      'other pages, not rows of a database. One file per page; each page keeps its parent pointer, so the tree ' +
      'can be rebuilt. Pulls that include page content can take a while on large workspaces.',
    metadata: { notionType: 'standalone_pages' },
  };
}

/**
 * Build the table spec for the standalone-pages backup table.
 *
 * The schema mirrors the fixed system-field envelope of
 * `buildNotionJsonTableSpec` (deliberately duplicated rather than extracted:
 * the database spec is pinned byte-for-byte by the live integration snapshot,
 * so the database builder stays untouched), with three differences:
 *
 * - `parent` is the standalone-page union (`page_id` / `workspace` /
 *   `block_id`) — database-owned parents are excluded at pull time.
 * - `properties` holds exactly one property: `title` (the only property a
 *    page outside a database has). It is writable, like on database tables.
 * - Every OTHER field carries `x-scratch-readonly` (system fields, the parent
 *   pointer — the API offers no reparent through `pages.update` — and
 *   `page_content`, read-only here exactly as on database tables), and
 *   `last_edited_time` deliberately does NOT carry the last-modified-field
 *   annotation — the Search endpoint has no modified-since filter, so this
 *   table never advertises incremental pull.
 */
export function buildNotionStandalonePagesTableSpec(id: EntityId): BaseJsonTableSpec {
  const schema = buildStandalonePagesSchema();
  return {
    id,
    slug: id.wsId,
    name: sanitizeForTableWsId(NOTION_STANDALONE_PAGES_DISPLAY_NAME),
    schema,
    idPath: dotPath('id'),
    titlePath: dotPath('properties.title'),
    // The parent pointer preserved in every record is what makes the flat
    // folder a derivable tree — declare it so the CLI/desktop can render a
    // tree view generically. `url` is the page's own Notion link.
    recordTree: {
      parentIdPath: dotPath('parent.page_id'),
      parentKindPath: dotPath('parent.type'),
      recordUrlPath: dotPath('url'),
    },
    agentInstructions:
      'This folder is a backup of every standalone (non-database) Notion page this connection can access — ' +
      'one verbatim Notion page object per file, named after the page title. The folder is flat on disk, but the ' +
      'records form a tree: each page keeps its parent pointer (parent.page_id / parent.type), and synced database ' +
      'folders of this connection can be embedded inside pages. To materialize the tree, prefer the CLI over ' +
      'walking the files yourself: `scratchmd record-tree --folder <connection>/<this folder>` prints JSON ' +
      '{ folder, totalRecords, parseErrors, roots } with nested children, embedded sibling folders, and per-node ' +
      'Notion URLs.',
    basePath: [],
    // No remoteWebUrl: there is no Notion deep link addressing "all pages";
    // per the spec contract we omit it rather than emit a guessed URL.
    generatedAt: new Date().toISOString(),
    defaultView: buildNotionStandalonePagesDefaultView(schema),
  };
}

/**
 * The `properties.title` envelope, built through the same property→schema
 * mapping the database tables use (rich-text span array, the plain-text
 * virtual field for display, and the inbound write-pack hint), from a
 * synthetic property config: a standalone page has no data-source metadata to
 * read, but its title property is always literally keyed and id'd `"title"`.
 * Writable, exactly like a database table's title property.
 */
function buildStandalonePagesTitlePropertySchema(): TSchema {
  const syntheticTitlePropertyConfig = {
    id: 'title',
    name: 'Title',
    type: 'title',
    title: {},
  } as DataSourceObjectResponse['properties'][string];
  return notionPropertyToJsonSchema(syntheticTitlePropertyConfig);
}

function buildStandalonePagesSchema(): TSchema {
  return Type.Object(
    {
      object: Type.Literal('page', { description: 'Object type', [X_SCRATCH_READONLY]: true }),
      id: Type.String({ description: 'Unique page identifier', [X_SCRATCH_READONLY]: true }),
      created_time: Type.String({
        description: 'Page creation time',
        format: 'date-time',
        [X_SCRATCH_READONLY]: true,
      }),
      last_edited_time: Type.String({
        description: 'Last edit time',
        format: 'date-time',
        [X_SCRATCH_READONLY]: true,
      }),
      created_by: Type.Object(
        {
          object: Type.Literal('user'),
          id: Type.String(),
        },
        { description: 'User who created the page', [X_SCRATCH_READONLY]: true },
      ),
      last_edited_by: Type.Object(
        {
          object: Type.Literal('user'),
          id: Type.String(),
        },
        { description: 'User who last edited the page', [X_SCRATCH_READONLY]: true },
      ),
      cover: Type.Optional(
        Type.Union(
          [
            Type.Object({
              type: Type.Literal('external'),
              external: Type.Object({ url: Type.String({ format: 'uri' }) }),
            }),
            Type.Object({
              type: Type.Literal('file'),
              file: Type.Object({ url: Type.String({ format: 'uri' }), expiry_time: Type.String() }),
            }),
            Type.Null(),
          ],
          {
            [X_SCRATCH_ASSET_FIELD]: { idPath: null, urlExpires: true } satisfies AssetFieldOptions,
            [X_SCRATCH_READONLY]: true,
          },
        ),
      ),
      icon: Type.Optional(
        Type.Union(
          [
            Type.Object({
              type: Type.Literal('emoji'),
              emoji: Type.String(),
            }),
            Type.Object({
              type: Type.Literal('external'),
              external: Type.Object({ url: Type.String({ format: 'uri' }) }),
            }),
            Type.Object({
              type: Type.Literal('file'),
              file: Type.Object({ url: Type.String({ format: 'uri' }), expiry_time: Type.String() }),
            }),
            // Built-in Notion named icon, e.g. { type: 'icon', icon: { name: 'light-bulb', color: 'orange' } }.
            // Carries no URL, so it is not an extractable asset (extractUrl skips it).
            Type.Object({
              type: Type.Literal('icon'),
              icon: Type.Object({ name: Type.String(), color: Type.Optional(Type.String()) }),
            }),
            // Custom uploaded emoji, e.g. { type: 'custom_emoji', custom_emoji: { id, name, url } }.
            // `url` is a real Notion-hosted asset URL, extracted like file/external icons.
            Type.Object({
              type: Type.Literal('custom_emoji'),
              custom_emoji: Type.Object({
                id: Type.String(),
                name: Type.Optional(Type.String()),
                url: Type.String({ format: 'uri' }),
              }),
            }),
            Type.Null(),
          ],
          {
            [X_SCRATCH_ASSET_FIELD]: { idPath: null, urlExpires: true } satisfies AssetFieldOptions,
            [X_SCRATCH_READONLY]: true,
          },
        ),
      ),
      parent: Type.Union(
        [
          Type.Object({
            type: Type.Literal('page_id'),
            page_id: Type.String(),
          }),
          Type.Object({
            type: Type.Literal('workspace'),
            workspace: Type.Literal(true),
          }),
          Type.Object({
            type: Type.Literal('block_id'),
            block_id: Type.String(),
          }),
        ],
        {
          description: 'Parent pointer (page, workspace, or block) — the page-tree edge preserved in the data',
          [X_SCRATCH_READONLY]: true,
        },
      ),
      // Trash / archive state. Notion renamed these across API versions:
      // 2025-09-03 emitted `archived`; 2026-03-11 stopped emitting it and uses
      // `in_trash` (the renamed soft-delete) plus a distinct `is_archived`. All
      // three are optional so the envelope faithfully describes a record pulled
      // under either version.
      archived: Type.Optional(
        Type.Boolean({
          description: 'Is page archived (legacy; absent under 2026-03-11+)',
          [X_SCRATCH_READONLY]: true,
        }),
      ),
      in_trash: Type.Optional(Type.Boolean({ description: 'Is page in trash', [X_SCRATCH_READONLY]: true })),
      is_archived: Type.Optional(
        Type.Boolean({ description: 'Is page archived (2026-03-11+)', [X_SCRATCH_READONLY]: true }),
      ),
      page_content: Type.Optional(
        Type.Array(Type.Unknown(), {
          description: 'Page body content (Notion blocks)',
          [X_SCRATCH_SUGGESTED_TRANSFORMER]: { type: TransformerTypes.NotionToHtml },
          [X_SCRATCH_READONLY]: true,
        }),
      ),
      properties: Type.Object(
        { title: buildStandalonePagesTitlePropertySchema() },
        { description: 'Page properties (a standalone page carries only its title)' },
      ),
      url: Type.String({ description: 'Page URL', format: 'uri', [X_SCRATCH_READONLY]: true }),
      public_url: Type.Optional(
        Type.Union([Type.String({ format: 'uri' }), Type.Null()], { [X_SCRATCH_READONLY]: true }),
      ),
    },
    {
      $id: `notion/${NOTION_STANDALONE_PAGES_TABLE_ID}`,
      title: NOTION_STANDALONE_PAGES_DISPLAY_NAME,
    },
  );
}
