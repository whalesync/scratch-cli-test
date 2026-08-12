import { Type } from '@sinclair/typebox';
import {
  X_SCRATCH_AGENT_INSTRUCTIONS,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_LAST_MODIFIED_FIELD,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { BaseJsonTableSpec, EntityId, dotPath } from '../../types';
import { INTERCOM_UNIX_TIMESTAMP_DATA_TYPE, intercomForeignKeyLinkedTableId } from './intercom-types';

/**
 * Schema options for a Unix-epoch timestamp Intercom reports as a bare integer. See
 * {@link INTERCOM_UNIX_TIMESTAMP_DATA_TYPE} — the default view turns an annotated field into a real
 * date column instead of a raw number.
 */
function unixTimestampOptions(description: string): Record<string, unknown> {
  return {
    description,
    [X_SCRATCH_READONLY]: true,
    [X_SCRATCH_CONNECTOR_DATA_TYPE]: INTERCOM_UNIX_TIMESTAMP_DATA_TYPE,
  };
}

/**
 * The foreign-key annotation for a `parent_id` that names a Help Center collection.
 *
 * Both link fields are single-valued: an article has at most one parent, and so does a collection.
 * Article `parent_id` is a NUMBER while a collection's own `id` is a STRING — mirrored verbatim
 * from the API, and harmless because foreign-key resolution compares by string.
 *
 * Articles carry one caveat: `parent_type` may be `'section'` rather than `'collection'`, and
 * sections are not a table this connector syncs. A section-parented article's `parent_id` therefore
 * names no record in the Collections folder, which the shared FK step reports as an unresolved link
 * — it warns, leaves that one link empty, and syncs the rest of the record (the DEV-11222 default).
 * That is strictly better than the alternative of publishing the raw id into a number column, where
 * it is a relation nobody can follow (DEV-11285).
 */
const PARENT_COLLECTION_FOREIGN_KEY = {
  linkedTableId: intercomForeignKeyLinkedTableId('collections'),
  linkedTableRemoteId: ['collections'],
  isSingleValued: true,
} as const;

// ---------------------------------------------------------------------------
// Articles (static schema)
// ---------------------------------------------------------------------------

/**
 * Build a BaseJsonTableSpec for the Intercom Articles table.
 */
export function buildIntercomArticlesJsonTableSpec(id: EntityId): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      id: Type.String({ description: 'Article ID', [X_SCRATCH_READONLY]: true }),
      workspace_id: Type.String({ description: 'Workspace ID', [X_SCRATCH_READONLY]: true }),
      title: Type.String({ description: 'Article title' }),
      description: Type.Union([Type.String(), Type.Null()], { description: 'Article description' }),
      body: Type.Union([Type.String(), Type.Null()], {
        description: 'Article body (HTML)',
        contentMediaType: 'text/html',
      }),
      author_id: Type.Number({ description: 'Author admin ID (must be a valid teammate)' }),
      state: Type.Union([Type.Literal('published'), Type.Literal('draft')], {
        description: 'Article state',
      }),
      url: Type.Union([Type.String(), Type.Null()], {
        description: 'Public URL',
        [X_SCRATCH_READONLY]: true,
      }),
      parent_id: Type.Union([Type.Number(), Type.Null()], {
        description: 'Parent collection or section ID',
        [X_SCRATCH_FOREIGN_KEY_OPTIONS]: PARENT_COLLECTION_FOREIGN_KEY,
      }),
      parent_ids: Type.Array(Type.Number(), {
        description: 'All parent collection/section IDs',
        [X_SCRATCH_READONLY]: true,
      }),
      parent_type: Type.Union([Type.String(), Type.Null()], {
        description: 'Parent type (collection or section)',
      }),
      // The three fields below are OPTIONAL because `GET /articles` — the list endpoint the pull
      // walks — omits them entirely, while `GET /articles/{id}` returns them (DEV-11286). Declaring
      // them required made every pulled file fail its own schema. `statistics` additionally has
      // three observed shapes for one article (absent from an older list row, `null` on a freshly
      // created one, populated by-id), so it is optional AND nullable.
      default_locale: Type.Optional(Type.String({ description: 'Default locale', [X_SCRATCH_READONLY]: true })),
      translated_content: Type.Optional(
        Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()], {
          description: 'Translated content by locale',
        }),
      ),
      statistics: Type.Optional(
        Type.Union(
          [
            Type.Object(
              {
                type: Type.String({ [X_SCRATCH_READONLY]: true }),
                views: Type.Number({ [X_SCRATCH_READONLY]: true }),
                conversations: Type.Number({ [X_SCRATCH_READONLY]: true }),
                reactions: Type.Number({ [X_SCRATCH_READONLY]: true }),
                happy_reaction_percentage: Type.Number({ [X_SCRATCH_READONLY]: true }),
                neutral_reaction_percentage: Type.Number({ [X_SCRATCH_READONLY]: true }),
                sad_reaction_percentage: Type.Number({ [X_SCRATCH_READONLY]: true }),
              },
              { [X_SCRATCH_READONLY]: true },
            ),
            Type.Null(),
          ],
          { description: 'Article statistics', [X_SCRATCH_READONLY]: true },
        ),
      ),
      created_at: Type.Number(unixTimestampOptions('Creation timestamp (Unix)')),
      updated_at: Type.Number(unixTimestampOptions('Last updated timestamp (Unix)')),
    },
    {
      $id: 'intercom/articles',
      title: 'Articles',
    },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Articles',
    schema,
    idPath: dotPath('id'),
    titlePath: dotPath('title'),
    mainContentPath: dotPath('body'),
    slugPath: dotPath('title'),
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Collections (static schema)
// ---------------------------------------------------------------------------

/**
 * Build a BaseJsonTableSpec for the Intercom Collections table.
 */
export function buildIntercomCollectionsJsonTableSpec(id: EntityId): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      id: Type.String({ description: 'Collection ID', [X_SCRATCH_READONLY]: true }),
      workspace_id: Type.String({ description: 'Workspace ID', [X_SCRATCH_READONLY]: true }),
      name: Type.String({ description: 'Collection name' }),
      description: Type.Union([Type.String(), Type.Null()], { description: 'Collection description' }),
      icon: Type.Union([Type.String(), Type.Null()], { description: 'Icon identifier' }),
      order: Type.Number({ description: 'Sort order', [X_SCRATCH_READONLY]: true }),
      url: Type.Union([Type.String(), Type.Null()], {
        description: 'Public URL',
        [X_SCRATCH_READONLY]: true,
      }),
      default_locale: Type.String({ description: 'Default locale', [X_SCRATCH_READONLY]: true }),
      translated_content: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()], {
        description: 'Translated content by locale',
      }),
      parent_id: Type.Union([Type.String(), Type.Null()], {
        description: 'Parent collection ID (null for top-level)',
        [X_SCRATCH_FOREIGN_KEY_OPTIONS]: PARENT_COLLECTION_FOREIGN_KEY,
      }),
      help_center_id: Type.Union([Type.Number(), Type.Null()], {
        description: 'Help Center ID',
      }),
      created_at: Type.Number(unixTimestampOptions('Creation timestamp (Unix)')),
      updated_at: Type.Number(unixTimestampOptions('Last updated timestamp (Unix)')),
    },
    {
      $id: 'intercom/collections',
      title: 'Collections',
    },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Collections',
    schema,
    idPath: dotPath('id'),
    titlePath: dotPath('name'),
    slugPath: dotPath('name'),
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Conversations (read-only static schema)
// ---------------------------------------------------------------------------

const authorSchema = Type.Object(
  {
    type: Type.String({
      description: 'Author type',
      [X_SCRATCH_READONLY]: true,
      [X_SCRATCH_AGENT_INSTRUCTIONS]:
        'Author `type` is one of "user", "admin", or "bot". "user" and "admin" represent human participants and are almost always what matters; "bot" entries come from automated flows and are usually safe to skip when summarizing a conversation or picking a representative message.',
    }),
    id: Type.String({ description: 'Author ID', [X_SCRATCH_READONLY]: true }),
    name: Type.Union([Type.String(), Type.Null()], { description: 'Author name', [X_SCRATCH_READONLY]: true }),
    email: Type.Union([Type.String(), Type.Null()], { description: 'Author email', [X_SCRATCH_READONLY]: true }),
  },
  {
    [X_SCRATCH_READONLY]: true,
  },
);

const conversationPartSchema = Type.Object(
  {
    type: Type.String({ [X_SCRATCH_READONLY]: true }),
    id: Type.String({ [X_SCRATCH_READONLY]: true }),
    part_type: Type.String({ description: 'Part type (comment, note, etc.)', [X_SCRATCH_READONLY]: true }),
    body: Type.Union([Type.String(), Type.Null()], {
      description: 'Part body (HTML)',
      contentMediaType: 'text/html',
      [X_SCRATCH_READONLY]: true,
      [X_SCRATCH_AGENT_INSTRUCTIONS]: 'HTML does not have a consistent root element',
    }),
    created_at: Type.Number(unixTimestampOptions('Part creation timestamp (Unix)')),
    updated_at: Type.Number(unixTimestampOptions('Part update timestamp (Unix)')),
    author: authorSchema,
  },
  {
    [X_SCRATCH_READONLY]: true,
    [X_SCRATCH_AGENT_INSTRUCTIONS]:
      'Conversation parts represent many event types that may not be user-facing (assignment changes, tag updates, notes, replies, etc.). Use the `part_type` to determine if the part is user-facing and relevant to the task',
  },
);

/**
 * Build a BaseJsonTableSpec for the Intercom Conversations table.
 * All fields are read-only.
 */
export function buildIntercomConversationsJsonTableSpec(id: EntityId): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      id: Type.String({ description: 'Conversation ID', [X_SCRATCH_READONLY]: true }),
      title: Type.Union([Type.String(), Type.Null()], {
        description: 'Conversation title',
        [X_SCRATCH_READONLY]: true,
      }),
      state: Type.String({ description: 'State (open, closed, snoozed)', [X_SCRATCH_READONLY]: true }),
      open: Type.Boolean({ description: 'Whether the conversation is open', [X_SCRATCH_READONLY]: true }),
      read: Type.Boolean({ description: 'Whether the conversation has been read', [X_SCRATCH_READONLY]: true }),
      priority: Type.String({ description: 'Priority level', [X_SCRATCH_READONLY]: true }),
      admin_assignee_id: Type.Union([Type.Number(), Type.Null()], {
        description: 'Assigned admin ID',
        [X_SCRATCH_READONLY]: true,
      }),
      team_assignee_id: Type.Union([Type.String(), Type.Null()], {
        description: 'Assigned team ID',
        [X_SCRATCH_READONLY]: true,
      }),
      waiting_since: Type.Union(
        [Type.Number(), Type.Null()],
        unixTimestampOptions('Timestamp since waiting for admin reply'),
      ),
      snoozed_until: Type.Union(
        [Type.Number(), Type.Null()],
        unixTimestampOptions('Timestamp when snoozed conversation reopens'),
      ),
      // NULLABLE: the API returns `source: null` on real conversations, from both the list and the
      // by-id endpoint. Declared as a bare object it made every such record fail its own schema, and
      // the object→text downgrade turned the null into an empty string at every destination
      // (DEV-11286).
      source: Type.Union(
        [
          Type.Object(
            {
              type: Type.String({ [X_SCRATCH_READONLY]: true }),
              id: Type.String({ [X_SCRATCH_READONLY]: true }),
              delivered_as: Type.String({ description: 'Delivery method', [X_SCRATCH_READONLY]: true }),
              subject: Type.String({ description: 'Subject line', [X_SCRATCH_READONLY]: true }),
              body: Type.String({
                description: 'Source message body (HTML)',
                contentMediaType: 'text/html',
                [X_SCRATCH_READONLY]: true,
              }),
              author: authorSchema,
              url: Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
              redacted: Type.Boolean({ [X_SCRATCH_READONLY]: true }),
            },
            { [X_SCRATCH_READONLY]: true },
          ),
          Type.Null(),
        ],
        { description: 'The initiating message', [X_SCRATCH_READONLY]: true },
      ),
      contacts: Type.Object(
        {
          type: Type.String({ [X_SCRATCH_READONLY]: true }),
          contacts: Type.Array(
            Type.Object({
              type: Type.String({ [X_SCRATCH_READONLY]: true }),
              id: Type.String({ [X_SCRATCH_READONLY]: true }),
            }),
            { [X_SCRATCH_READONLY]: true },
          ),
        },
        { description: 'Contacts involved', [X_SCRATCH_READONLY]: true },
      ),
      tags: Type.Object(
        {
          type: Type.String({ [X_SCRATCH_READONLY]: true }),
          tags: Type.Array(
            Type.Object({
              type: Type.String({ [X_SCRATCH_READONLY]: true }),
              id: Type.String({ [X_SCRATCH_READONLY]: true }),
              name: Type.String({ [X_SCRATCH_READONLY]: true }),
            }),
            { [X_SCRATCH_READONLY]: true },
          ),
        },
        { description: 'Associated tags', [X_SCRATCH_READONLY]: true },
      ),
      custom_attributes: Type.Record(Type.String(), Type.Unknown(), {
        description: 'Custom attributes',
        [X_SCRATCH_READONLY]: true,
      }),
      conversation_rating: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()], {
        description: 'Conversation rating',
        [X_SCRATCH_READONLY]: true,
      }),
      statistics: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()], {
        description: 'Conversation statistics',
        [X_SCRATCH_READONLY]: true,
      }),
      conversation_parts: Type.Object(
        {
          type: Type.String({ [X_SCRATCH_READONLY]: true }),
          conversation_parts: Type.Array(conversationPartSchema, { [X_SCRATCH_READONLY]: true }),
          total_count: Type.Number({ [X_SCRATCH_READONLY]: true }),
        },
        { description: 'Threaded replies, notes, and events', [X_SCRATCH_READONLY]: true },
      ),
      created_at: Type.Number(unixTimestampOptions('Creation timestamp (Unix)')),
      // Annotated as the last-modified field so the UI's last-modified-field
      // picker surfaces it. The connector hardcodes `updated_at` and gates
      // incremental on the conversations table (Notion/Linear-style "hardcoded
      // field, annotated for UI"). Articles/Collections are deliberately not
      // annotated — they have no server-side incremental path.
      updated_at: Type.Number({
        ...unixTimestampOptions('Last updated timestamp (Unix)'),
        [X_SCRATCH_LAST_MODIFIED_FIELD]: true,
      }),
    },
    {
      $id: 'intercom/conversations',
      title: 'Conversations',
    },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Conversations',
    schema,
    idPath: dotPath('id'),
    titlePath: dotPath('title'),
    slugPath: dotPath('source.subject'),
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}
