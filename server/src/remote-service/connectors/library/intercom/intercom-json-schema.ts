import { Type } from '@sinclair/typebox';
import { READONLY_FLAG } from '../../json-schema';
import { BaseJsonTableSpec, EntityId, idPath } from '../../types';

// ---------------------------------------------------------------------------
// Articles (static schema)
// ---------------------------------------------------------------------------

/**
 * Build a BaseJsonTableSpec for the Intercom Articles table.
 */
export function buildIntercomArticlesJsonTableSpec(id: EntityId): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      id: Type.String({ description: 'Article ID', [READONLY_FLAG]: true }),
      workspace_id: Type.String({ description: 'Workspace ID', [READONLY_FLAG]: true }),
      title: Type.String({ description: 'Article title' }),
      description: Type.Union([Type.String(), Type.Null()], { description: 'Article description' }),
      body: Type.Union([Type.String(), Type.Null()], { description: 'Article body (HTML)' }),
      author_id: Type.Number({ description: 'Author admin ID (must be a valid teammate)' }),
      state: Type.Union([Type.Literal('published'), Type.Literal('draft')], {
        description: 'Article state',
      }),
      url: Type.Union([Type.String(), Type.Null()], {
        description: 'Public URL',
        [READONLY_FLAG]: true,
      }),
      parent_id: Type.Union([Type.Number(), Type.Null()], {
        description: 'Parent collection or section ID',
      }),
      parent_ids: Type.Array(Type.Number(), {
        description: 'All parent collection/section IDs',
        [READONLY_FLAG]: true,
      }),
      parent_type: Type.Union([Type.String(), Type.Null()], {
        description: 'Parent type (collection or section)',
      }),
      default_locale: Type.String({ description: 'Default locale', [READONLY_FLAG]: true }),
      translated_content: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()], {
        description: 'Translated content by locale',
      }),
      statistics: Type.Union(
        [
          Type.Object(
            {
              type: Type.String({ [READONLY_FLAG]: true }),
              views: Type.Number({ [READONLY_FLAG]: true }),
              conversations: Type.Number({ [READONLY_FLAG]: true }),
              reactions: Type.Number({ [READONLY_FLAG]: true }),
              happy_reaction_percentage: Type.Number({ [READONLY_FLAG]: true }),
              neutral_reaction_percentage: Type.Number({ [READONLY_FLAG]: true }),
              sad_reaction_percentage: Type.Number({ [READONLY_FLAG]: true }),
            },
            { [READONLY_FLAG]: true },
          ),
          Type.Null(),
        ],
        { description: 'Article statistics', [READONLY_FLAG]: true },
      ),
      created_at: Type.Number({
        description: 'Creation timestamp (Unix)',
        [READONLY_FLAG]: true,
      }),
      updated_at: Type.Number({
        description: 'Last updated timestamp (Unix)',
        [READONLY_FLAG]: true,
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
      id: Type.String({ description: 'Collection ID', [READONLY_FLAG]: true }),
      workspace_id: Type.String({ description: 'Workspace ID', [READONLY_FLAG]: true }),
      name: Type.String({ description: 'Collection name' }),
      description: Type.Union([Type.String(), Type.Null()], { description: 'Collection description' }),
      icon: Type.Union([Type.String(), Type.Null()], { description: 'Icon identifier' }),
      order: Type.Number({ description: 'Sort order', [READONLY_FLAG]: true }),
      url: Type.Union([Type.String(), Type.Null()], {
        description: 'Public URL',
        [READONLY_FLAG]: true,
      }),
      default_locale: Type.String({ description: 'Default locale', [READONLY_FLAG]: true }),
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
        [READONLY_FLAG]: true,
      }),
      updated_at: Type.Number({
        description: 'Last updated timestamp (Unix)',
        [READONLY_FLAG]: true,
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
  };
}

// ---------------------------------------------------------------------------
// Conversations (read-only static schema)
// ---------------------------------------------------------------------------

const authorSchema = Type.Object(
  {
    type: Type.String({ description: 'Author type', [READONLY_FLAG]: true }),
    id: Type.String({ description: 'Author ID', [READONLY_FLAG]: true }),
    name: Type.Union([Type.String(), Type.Null()], { description: 'Author name', [READONLY_FLAG]: true }),
    email: Type.Union([Type.String(), Type.Null()], { description: 'Author email', [READONLY_FLAG]: true }),
  },
  { [READONLY_FLAG]: true },
);

const conversationPartSchema = Type.Object(
  {
    type: Type.String({ [READONLY_FLAG]: true }),
    id: Type.String({ [READONLY_FLAG]: true }),
    part_type: Type.String({ description: 'Part type (comment, note, etc.)', [READONLY_FLAG]: true }),
    body: Type.Union([Type.String(), Type.Null()], { description: 'Part body (HTML)', [READONLY_FLAG]: true }),
    created_at: Type.Number({ description: 'Part creation timestamp (Unix)', [READONLY_FLAG]: true }),
    updated_at: Type.Number({ description: 'Part update timestamp (Unix)', [READONLY_FLAG]: true }),
    author: authorSchema,
  },
  { [READONLY_FLAG]: true },
);

/**
 * Build a BaseJsonTableSpec for the Intercom Conversations table.
 * All fields are read-only.
 */
export function buildIntercomConversationsJsonTableSpec(id: EntityId): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      id: Type.String({ description: 'Conversation ID', [READONLY_FLAG]: true }),
      title: Type.Union([Type.String(), Type.Null()], { description: 'Conversation title', [READONLY_FLAG]: true }),
      state: Type.String({ description: 'State (open, closed, snoozed)', [READONLY_FLAG]: true }),
      open: Type.Boolean({ description: 'Whether the conversation is open', [READONLY_FLAG]: true }),
      read: Type.Boolean({ description: 'Whether the conversation has been read', [READONLY_FLAG]: true }),
      priority: Type.String({ description: 'Priority level', [READONLY_FLAG]: true }),
      admin_assignee_id: Type.Union([Type.Number(), Type.Null()], {
        description: 'Assigned admin ID',
        [READONLY_FLAG]: true,
      }),
      team_assignee_id: Type.Union([Type.String(), Type.Null()], {
        description: 'Assigned team ID',
        [READONLY_FLAG]: true,
      }),
      waiting_since: Type.Union([Type.Number(), Type.Null()], {
        description: 'Timestamp since waiting for admin reply',
        [READONLY_FLAG]: true,
      }),
      snoozed_until: Type.Union([Type.Number(), Type.Null()], {
        description: 'Timestamp when snoozed conversation reopens',
        [READONLY_FLAG]: true,
      }),
      source: Type.Object(
        {
          type: Type.String({ [READONLY_FLAG]: true }),
          id: Type.String({ [READONLY_FLAG]: true }),
          delivered_as: Type.String({ description: 'Delivery method', [READONLY_FLAG]: true }),
          subject: Type.String({ description: 'Subject line', [READONLY_FLAG]: true }),
          body: Type.String({ description: 'Source message body (HTML)', [READONLY_FLAG]: true }),
          author: authorSchema,
          url: Type.Union([Type.String(), Type.Null()], { [READONLY_FLAG]: true }),
          redacted: Type.Boolean({ [READONLY_FLAG]: true }),
        },
        { description: 'The initiating message', [READONLY_FLAG]: true },
      ),
      contacts: Type.Object(
        {
          type: Type.String({ [READONLY_FLAG]: true }),
          contacts: Type.Array(
            Type.Object({
              type: Type.String({ [READONLY_FLAG]: true }),
              id: Type.String({ [READONLY_FLAG]: true }),
            }),
            { [READONLY_FLAG]: true },
          ),
        },
        { description: 'Contacts involved', [READONLY_FLAG]: true },
      ),
      tags: Type.Object(
        {
          type: Type.String({ [READONLY_FLAG]: true }),
          tags: Type.Array(
            Type.Object({
              type: Type.String({ [READONLY_FLAG]: true }),
              id: Type.String({ [READONLY_FLAG]: true }),
              name: Type.String({ [READONLY_FLAG]: true }),
            }),
            { [READONLY_FLAG]: true },
          ),
        },
        { description: 'Associated tags', [READONLY_FLAG]: true },
      ),
      custom_attributes: Type.Record(Type.String(), Type.Unknown(), {
        description: 'Custom attributes',
        [READONLY_FLAG]: true,
      }),
      conversation_rating: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()], {
        description: 'Conversation rating',
        [READONLY_FLAG]: true,
      }),
      statistics: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()], {
        description: 'Conversation statistics',
        [READONLY_FLAG]: true,
      }),
      conversation_parts: Type.Object(
        {
          type: Type.String({ [READONLY_FLAG]: true }),
          conversation_parts: Type.Array(conversationPartSchema, { [READONLY_FLAG]: true }),
          total_count: Type.Number({ [READONLY_FLAG]: true }),
        },
        { description: 'Threaded replies, notes, and events', [READONLY_FLAG]: true },
      ),
      created_at: Type.Number({
        description: 'Creation timestamp (Unix)',
        [READONLY_FLAG]: true,
      }),
      updated_at: Type.Number({
        description: 'Last updated timestamp (Unix)',
        [READONLY_FLAG]: true,
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
  };
}
