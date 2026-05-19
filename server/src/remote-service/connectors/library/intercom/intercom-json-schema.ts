import { Type } from '@sinclair/typebox';
import { X_SCRATCH_LAST_MODIFIED_FIELD, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { BaseJsonTableSpec, EntityId, idPath } from '../../types';
import { buildIntercomDefaultView } from './intercom-default-view';

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
      body: Type.Union([Type.String(), Type.Null()], { description: 'Article body (HTML)' }),
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
      }),
      parent_ids: Type.Array(Type.Number(), {
        description: 'All parent collection/section IDs',
        [X_SCRATCH_READONLY]: true,
      }),
      parent_type: Type.Union([Type.String(), Type.Null()], {
        description: 'Parent type (collection or section)',
      }),
      default_locale: Type.String({ description: 'Default locale', [X_SCRATCH_READONLY]: true }),
      translated_content: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()], {
        description: 'Translated content by locale',
      }),
      statistics: Type.Union(
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
      created_at: Type.Number({
        description: 'Creation timestamp (Unix)',
        [X_SCRATCH_READONLY]: true,
      }),
      updated_at: Type.Number({
        description: 'Last updated timestamp (Unix)',
        [X_SCRATCH_READONLY]: true,
      }),
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
    idColumnRemoteId: idPath('id'),
    titleColumnRemoteId: ['title'],
    mainContentColumnRemoteId: ['body'],
    slugFieldPath: 'title',
    basePath: [],
    generatedAt: new Date().toISOString(),
    defaultView: buildIntercomDefaultView(schema, 'articles'),
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
      }),
      help_center_id: Type.Union([Type.Number(), Type.Null()], {
        description: 'Help Center ID',
      }),
      created_at: Type.Number({
        description: 'Creation timestamp (Unix)',
        [X_SCRATCH_READONLY]: true,
      }),
      updated_at: Type.Number({
        description: 'Last updated timestamp (Unix)',
        [X_SCRATCH_READONLY]: true,
      }),
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
    idColumnRemoteId: idPath('id'),
    titleColumnRemoteId: ['name'],
    slugFieldPath: 'name',
    basePath: [],
    generatedAt: new Date().toISOString(),
    defaultView: buildIntercomDefaultView(schema, 'collections'),
  };
}

// ---------------------------------------------------------------------------
// Conversations (read-only static schema)
// ---------------------------------------------------------------------------

const authorSchema = Type.Object(
  {
    type: Type.String({ description: 'Author type', [X_SCRATCH_READONLY]: true }),
    id: Type.String({ description: 'Author ID', [X_SCRATCH_READONLY]: true }),
    name: Type.Union([Type.String(), Type.Null()], { description: 'Author name', [X_SCRATCH_READONLY]: true }),
    email: Type.Union([Type.String(), Type.Null()], { description: 'Author email', [X_SCRATCH_READONLY]: true }),
  },
  { [X_SCRATCH_READONLY]: true },
);

const conversationPartSchema = Type.Object(
  {
    type: Type.String({ [X_SCRATCH_READONLY]: true }),
    id: Type.String({ [X_SCRATCH_READONLY]: true }),
    part_type: Type.String({ description: 'Part type (comment, note, etc.)', [X_SCRATCH_READONLY]: true }),
    body: Type.Union([Type.String(), Type.Null()], { description: 'Part body (HTML)', [X_SCRATCH_READONLY]: true }),
    created_at: Type.Number({ description: 'Part creation timestamp (Unix)', [X_SCRATCH_READONLY]: true }),
    updated_at: Type.Number({ description: 'Part update timestamp (Unix)', [X_SCRATCH_READONLY]: true }),
    author: authorSchema,
  },
  { [X_SCRATCH_READONLY]: true },
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
      waiting_since: Type.Union([Type.Number(), Type.Null()], {
        description: 'Timestamp since waiting for admin reply',
        [X_SCRATCH_READONLY]: true,
      }),
      snoozed_until: Type.Union([Type.Number(), Type.Null()], {
        description: 'Timestamp when snoozed conversation reopens',
        [X_SCRATCH_READONLY]: true,
      }),
      source: Type.Object(
        {
          type: Type.String({ [X_SCRATCH_READONLY]: true }),
          id: Type.String({ [X_SCRATCH_READONLY]: true }),
          delivered_as: Type.String({ description: 'Delivery method', [X_SCRATCH_READONLY]: true }),
          subject: Type.String({ description: 'Subject line', [X_SCRATCH_READONLY]: true }),
          body: Type.String({ description: 'Source message body (HTML)', [X_SCRATCH_READONLY]: true }),
          author: authorSchema,
          url: Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true }),
          redacted: Type.Boolean({ [X_SCRATCH_READONLY]: true }),
        },
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
      created_at: Type.Number({
        description: 'Creation timestamp (Unix)',
        [X_SCRATCH_READONLY]: true,
      }),
      // Annotated as the last-modified field so the UI's last-modified-field
      // picker surfaces it. The connector hardcodes `updated_at` and gates
      // incremental on the conversations table (Notion/Linear-style "hardcoded
      // field, annotated for UI"). Articles/Collections are deliberately not
      // annotated — they have no server-side incremental path.
      updated_at: Type.Number({
        description: 'Last updated timestamp (Unix)',
        [X_SCRATCH_READONLY]: true,
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
    idColumnRemoteId: idPath('id'),
    titleColumnRemoteId: ['title'],
    slugFieldPath: 'source.subject',
    basePath: [],
    generatedAt: new Date().toISOString(),
    defaultView: buildIntercomDefaultView(schema, 'conversations'),
  };
}
