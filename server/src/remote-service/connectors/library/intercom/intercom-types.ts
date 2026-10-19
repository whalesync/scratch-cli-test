/** Every Intercom table type exposed by this connector — a table's wsId is one of these. */
export const INTERCOM_TABLE_TYPES = ['articles', 'collections', 'conversations', 'contacts', 'companies'] as const;

/** String union for the Intercom table types exposed by this connector. */
export type IntercomTableType = (typeof INTERCOM_TABLE_TYPES)[number];

/** Narrow a table wsId to an {@link IntercomTableType}. */
export function isIntercomTableType(tableWsId: string): tableWsId is IntercomTableType {
  return (INTERCOM_TABLE_TYPES as readonly string[]).includes(tableWsId);
}

/**
 * `x-scratch-connector-data-type` marking a field Intercom reports as a Unix-epoch timestamp in
 * SECONDS (`created_at`, `updated_at`, `waiting_since`, `snoozed_until`). Intercom has no ISO date
 * type — every time it reports is a bare integer — so this is a faithful fact about the field, not
 * a display opinion, and it is the only signal that distinguishes `created_at` from a genuine
 * number like `author_id`. The default view reads it to build a real date column backed by an
 * `epoch_to_iso` codec; without it every timestamp exports as a raw number (DEV-11284, the Intercom
 * sibling of Stripe's DEV-11145).
 */
export const INTERCOM_UNIX_TIMESTAMP_DATA_TYPE = 'unix-timestamp-seconds';

/**
 * The `linkedTableId` a foreign-key annotation uses to name an Intercom table. Intercom's tables
 * are the fixed entity types, and a table's `DataFolder.tableId` is `[entityType]` — so the entity
 * type IS the link token, and `linkedTableRemoteId` is the same value wrapped in an array.
 */
export function intercomForeignKeyLinkedTableId(tableType: IntercomTableType): string {
  return tableType;
}

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
// Contacts (read-only)
// ---------------------------------------------------------------------------

/** A stub reference inside one of a contact's nested lists (`tags`, `notes`, `companies`, subscription types). */
export interface IntercomContactNestedListItem {
  type: string;
  id: string;
  url?: string | null;
}

/**
 * One of a contact's nested lists. Intercom inlines at most 10 items and points at `url` for the
 * rest (`has_more`/`total_count` say whether the inlined page is complete).
 */
export interface IntercomContactNestedList {
  type: 'list';
  data: IntercomContactNestedListItem[];
  url: string;
  total_count: number;
  has_more: boolean;
}

/**
 * A contact (a `user` or a `lead`) as returned by `POST /contacts/search` and `GET /contacts/{id}`
 * — the two return the same keys (probed live). Only the fields the connector reads are typed
 * here; the record is stored verbatim with everything else Intercom sends.
 */
export interface IntercomContact {
  type: 'contact';
  id: string;
  workspace_id: string;
  external_id: string | null;
  role: 'user' | 'lead';
  email: string | null;
  name: string | null;
  created_at: number;
  updated_at: number;
  custom_attributes: Record<string, unknown>;
  tags: IntercomContactNestedList;
  notes: IntercomContactNestedList;
  companies: IntercomContactNestedList;
}

/** One attribute definition from `GET /data_attributes?model=contact|company`. */
export interface IntercomDataAttribute {
  type: 'data_attribute';
  /** Present on custom attributes only. */
  id?: number;
  model: 'contact' | 'company';
  /** The key the value is stored under in a record's `custom_attributes` (for a custom attribute). */
  name: string;
  /** Dotted path of the attribute on the record, e.g. `custom_attributes.plan_tier`. */
  full_name: string;
  label: string;
  description?: string | null;
  /**
   * `string`/`integer`/`float`/`boolean`/`date` are documented for 2.11 (2.17 adds `datetime`).
   * `relationship` is undocumented but returned live, and its values never appear in a contact's
   * `custom_attributes`. Typed as an open string so an unknown type is skipped, not a crash.
   */
  data_type: string;
  /** Fixed list of allowed values, when the attribute has one. */
  options?: string[];
  api_writable?: boolean;
  /** True for a user-created (custom) attribute, false for Intercom's built-in ones. */
  custom: boolean;
  archived: boolean;
}

// ---------------------------------------------------------------------------
// Companies (read-only)
// ---------------------------------------------------------------------------

/**
 * A company as returned by `GET /companies/scroll` and `GET /companies/{id}` — the two return the
 * same keys (probed live). Only companies with at least one contact are ever listed. Only the
 * fields the connector reads are typed here; the record is stored verbatim.
 */
export interface IntercomCompany {
  type: 'company';
  id: string;
  company_id: string | null;
  name: string | null;
  created_at: number;
  updated_at: number;
  user_count: number;
  /** `{}` when the company has no plan — never null (probed live). */
  plan: { type?: string; id?: string; name?: string };
  tags: { type: 'tag.list'; tags: Array<{ type: string; id: string; name: string }> };
  custom_attributes: Record<string, unknown>;
}

/**
 * One page of `GET /companies/scroll`. There is no `total_count` and no `pages`; the walk ends on
 * the first empty page, and `scroll_param` names the next page (probed live).
 */
export interface IntercomCompanyScrollPage {
  type: 'list';
  data: IntercomCompany[];
  pages: null;
  total_count: null;
  scroll_param?: string;
}

/** Response of `GET /data_attributes` (not paginated). */
export interface IntercomDataAttributeListResponse {
  type: 'list';
  data: IntercomDataAttribute[];
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
