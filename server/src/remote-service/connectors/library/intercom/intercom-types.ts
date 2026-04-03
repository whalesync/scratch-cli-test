/** String union for the Intercom table types exposed by this connector. */
export type IntercomTableType = 'articles' | 'collections' | 'conversations';

// ---------------------------------------------------------------------------
// Articles
// ---------------------------------------------------------------------------

/** An article returned by the Intercom API. */
export interface IntercomArticle {
  type: 'article';
  id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  body: string | null;
  author_id: number;
  state: 'published' | 'draft';
  created_at: number;
  updated_at: number;
  url: string | null;
  parent_id: number | null;
  parent_ids: number[];
  parent_type: string | null;
  default_locale: string;
  translated_content: Record<string, unknown> | null;
  statistics: IntercomArticleStatistics | null;
}

export interface IntercomArticleStatistics {
  type: 'article_statistics';
  views: number;
  conversations: number;
  reactions: number;
  happy_reaction_percentage: number;
  neutral_reaction_percentage: number;
  sad_reaction_percentage: number;
}

/** Body for `POST /articles`. */
export interface IntercomCreateArticleRequest {
  title: string;
  author_id: number;
  description?: string;
  body?: string;
  state?: 'published' | 'draft';
  parent_id?: number;
  parent_type?: 'collection' | 'section';
  translated_content?: Record<string, unknown>;
}

/** Body for `PUT /articles/{id}`. */
export interface IntercomUpdateArticleRequest {
  title?: string;
  description?: string;
  body?: string;
  author_id?: number;
  state?: 'published' | 'draft';
  parent_id?: number;
  parent_type?: 'collection' | 'section';
  translated_content?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

/** A collection returned by the Intercom API. */
export interface IntercomCollection {
  type: 'collection';
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
  url: string | null;
  icon: string | null;
  order: number;
  default_locale: string;
  translated_content: Record<string, unknown> | null;
  parent_id: string | null;
  help_center_id: number | null;
}

/** Body for `POST /help_center/collections`. */
export interface IntercomCreateCollectionRequest {
  name: string;
  description?: string;
  translated_content?: Record<string, unknown>;
  icon?: string;
  parent_id?: string;
  help_center_id?: number;
}

/** Body for `PUT /help_center/collections/{id}`. */
export interface IntercomUpdateCollectionRequest {
  name?: string;
  description?: string;
  translated_content?: Record<string, unknown>;
  icon?: string;
  parent_id?: string;
  help_center_id?: number;
}

// ---------------------------------------------------------------------------
// Conversations (read-only)
// ---------------------------------------------------------------------------

/** Author of a conversation source or part. */
export interface IntercomAuthor {
  type: string;
  id: string;
  name: string | null;
  email: string | null;
}

/** The initiating message of a conversation. */
export interface IntercomConversationSource {
  type: string;
  id: string;
  delivered_as: string;
  subject: string;
  body: string;
  author: IntercomAuthor;
  attachments: unknown[];
  url: string | null;
  redacted: boolean;
}

/** A single part (reply, note, or system event) within a conversation. */
export interface IntercomConversationPart {
  type: string;
  id: string;
  part_type: string;
  body: string | null;
  created_at: number;
  updated_at: number;
  author: IntercomAuthor;
  attachments: unknown[];
  redacted: boolean;
}

/** A conversation returned by the Intercom API (full detail from GET). */
export interface IntercomConversation {
  type: 'conversation';
  id: string;
  title: string | null;
  created_at: number;
  updated_at: number;
  waiting_since: number | null;
  snoozed_until: number | null;
  open: boolean;
  state: 'open' | 'closed' | 'snoozed';
  read: boolean;
  priority: 'priority' | 'not_priority';
  admin_assignee_id: number | null;
  team_assignee_id: string | null;
  custom_attributes: Record<string, unknown>;
  source: IntercomConversationSource;
  contacts: { type: string; contacts: Array<{ type: string; id: string }> };
  teammates: { type: string; admins: Array<{ type: string; id: string }> } | null;
  tags: { type: string; tags: Array<{ type: string; id: string; name: string }> };
  conversation_rating: Record<string, unknown> | null;
  statistics: Record<string, unknown> | null;
  conversation_parts: {
    type: string;
    conversation_parts: IntercomConversationPart[];
    total_count: number;
  };
}

/** A conversation list item (from list/search — no conversation_parts). */
export type IntercomConversationListItem = Omit<IntercomConversation, 'conversation_parts'>;

/** Cursor-based paginated response for conversations. */
export interface IntercomCursorPaginatedResponse<T> {
  type: 'conversation.list';
  conversations: T[];
  total_count: number;
  pages: {
    type: 'pages';
    page: number;
    per_page: number;
    total_pages: number;
    next?: { page: number; starting_after: string };
  };
}

// ---------------------------------------------------------------------------
// Paginated responses
// ---------------------------------------------------------------------------

export interface IntercomPaginatedResponse<T> {
  type: 'list';
  data: T[];
  total_count: number;
  pages: {
    type: 'pages';
    page: number;
    per_page: number;
    total_pages: number;
    next?: { page: number; starting_after?: string };
  };
}
