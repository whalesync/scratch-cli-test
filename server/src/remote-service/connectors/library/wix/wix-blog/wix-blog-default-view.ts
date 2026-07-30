import { TableView, TableViewCol, TransformerTypes } from '@spinner/shared-types';
import { BaseJsonTableSpec } from '../../../types';
import { WIX_MEDIA_URI_PATTERN, WIX_MEDIA_URI_REPLACEMENT } from './wix-blog-media';
import { WixBlogTableKey, wixBlogForeignKeyTo, wixBlogTableKeyFromEntityId } from './wix-blog-tables';

/**
 * Default views for the Wix Blog connector's four tables.
 *
 * Wix Blog shipped with no default view at all, which meant the create-schema plan fell back to raw
 * schema flattening: 32 columns for a 26-key post, each nested object exported as the container AND
 * every child (`richContent` + `nodes` + `metadata`), child columns named after their bare leaf
 * segment (`nodes`, `settings`, `wixMedia`), dates typed as text despite `format: 'date-time'`, and a
 * cover image that arrived as an unusable `wix:image://` URI. This file is the editorial layer that
 * fixes all of it (DEV-11114, DEV-11119, DEV-11120, DEV-11121, DEV-11122).
 *
 * Two conventions worth knowing before editing:
 *
 * - **A column's `type` decides the destination column type.** `inferLogicalFieldType` only honours
 *   `format: 'date-time'`, `format: 'uri'` and scalar-array joins when a view supplies the hint;
 *   without one, every string lands as plain text and every array/object lands as text *with a
 *   downgrade warning*. So `type: 'date'` here is what makes Supabase emit `timestamptz` instead of
 *   `text`, and declaring a scalar array as `type: 'string'` + a join transformer is what turns a
 *   scary "Can't unpack this array field" note into a clean mapping.
 * - **Only listed, non-hidden columns reach the plan.** Anything omitted or `hidden: true` is not
 *   exported, which is exactly how the duplicate parent/child columns are suppressed. Hidden columns
 *   remain available for a user to switch on in the grid.
 *
 * Rich content is *stored* as Wix natively provides it — the raw Ricos document — and *rendered* to
 * HTML on the way out by the `Content` column's `ricos_to_html` codec. The distinction matters: the
 * Directive governs the bytes on disk, and a codec is the view layer adapting to the data rather
 * than the other way round. `toCore` runs on the export path only, so the grid still edits the
 * record's real shape.
 */
export function buildWixBlogDefaultView(spec: BaseJsonTableSpec): TableView | undefined {
  const table: WixBlogTableKey = wixBlogTableKeyFromEntityId(spec.id) ?? 'posts';
  switch (table) {
    case 'posts':
      return { name: 'Default', cols: buildPostCols() };
    case 'categories':
      return { name: 'Default', cols: buildCategoryCols() };
    case 'tags':
      return { name: 'Default', cols: buildTagCols() };
    case 'members':
      return { name: 'Default', cols: buildMemberCols() };
  }
}

// ── shared column helpers ────────────────────────────────────────────────────

/**
 * A scalar array rendered as one comma-separated string.
 *
 * Declaring `type: 'string'` up front is what routes the field to the clean `mapped` branch of
 * `inferLogicalFieldType` instead of the `downgraded` array branch, so the user isn't warned that a
 * field "couldn't be unpacked" when comma-joining it was always the intended outcome (the same
 * approach as Pipedrive's `label_ids` and Webflow's plain-text fields).
 */
function joinedScalarArrayCol(
  path: string,
  name: string,
  opts?: { hidden?: boolean; readonly?: boolean },
): TableViewCol {
  return {
    kind: 'col',
    path,
    name,
    type: 'string',
    displayTransformer: { type: 'jsonpath', options: { expression: '$[*]', arrayHandling: 'join_comma' } },
    ...(opts?.readonly ? { readonly: true } : {}),
    ...(opts?.hidden ? { hidden: true } : {}),
  };
}

function dateCol(path: string, name: string, opts?: { hidden?: boolean }): TableViewCol {
  return {
    kind: 'col',
    path,
    name,
    type: 'date',
    readonly: true,
    ...(opts?.hidden ? { hidden: true } : {}),
  };
}

// ── Blog Posts ───────────────────────────────────────────────────────────────

/**
 * Resolve Wix's internal media URI to a public image URL. The pattern is shared with `extractAssets`
 * via `wix-blog-media.ts` so the grid, the export and the asset extractor can't disagree.
 */
const WIX_MEDIA_URI_TO_HTTPS_URL = {
  type: TransformerTypes.ReplaceRegex,
  options: { pattern: WIX_MEDIA_URI_PATTERN, replacement: WIX_MEDIA_URI_REPLACEMENT },
} as const;

function buildPostCols(): TableViewCol[] {
  return [
    { kind: 'col', path: 'title', name: 'Title', type: 'string' },
    // The post body. Stored verbatim as the Ricos document Wix returns, and rendered to HTML on the
    // way out by the `ricos_to_html` codec — without it the body reached every destination as a
    // multi-thousand-character JSON blob (DEV-11114). `richtext` maps to a long-text destination
    // column so the rendered HTML isn't crammed into a single-line field.
    {
      kind: 'col',
      path: 'richContent',
      name: 'Content',
      type: 'richtext',
      codec: { toCore: { type: TransformerTypes.RicosToHtml } },
    },
    { kind: 'col', path: 'excerpt', name: 'Excerpt', type: 'string' },
    {
      kind: 'col',
      path: 'media.wixMedia.image',
      name: 'Cover image',
      type: 'url',
      codec: { toCore: WIX_MEDIA_URI_TO_HTTPS_URL },
    },
    { kind: 'col', path: 'status', name: 'Status', type: 'string', readonly: true },
    { kind: 'col', path: 'featured', name: 'Featured', type: 'checkbox' },
    // Write-once, not read-only: Wix rejects a create with no author ("Missing post owner
    // information") but assigns the author itself thereafter, so the only moment this is settable is
    // while the post is still local (DEV-11128).
    {
      kind: 'col',
      path: 'memberId',
      name: 'Author',
      type: 'string',
      writeOnce: true,
      foreignKey: wixBlogForeignKeyTo('members', { isSingleValued: true }),
    },
    {
      kind: 'col',
      path: 'categoryIds',
      name: 'Categories',
      type: 'string',
      foreignKey: wixBlogForeignKeyTo('categories'),
    },
    { kind: 'col', path: 'tagIds', name: 'Tags', type: 'string', foreignKey: wixBlogForeignKeyTo('tags') },
    joinedScalarArrayCol('hashtags', 'Hashtags'),
    {
      kind: 'col',
      path: 'relatedPostIds',
      name: 'Related posts',
      type: 'string',
      foreignKey: wixBlogForeignKeyTo('posts'),
    },
    dateCol('editedDate', 'Last edited'),
    dateCol('_createdDate', 'Created'),
    dateCol('firstPublishedDate', 'First published'),
    { kind: 'col', path: 'seoSlug', name: 'Slug', type: 'string' },
    { kind: 'col', path: 'minutesToRead', name: 'Minutes to read', type: 'number', readonly: true },
    { kind: 'col', path: 'commentingEnabled', name: 'Comments enabled', type: 'checkbox' },
    { kind: 'col', path: 'language', name: 'Language', type: 'string' },

    // ── Available but off by default: identifiers, Wix bookkeeping, and the raw SEO blob. ──
    { kind: 'col', path: '_id', name: 'Post ID', type: 'string', readonly: true, hidden: true },
    joinedScalarArrayCol('slugs', 'Assigned slugs', { hidden: true, readonly: true }),
    { kind: 'col', path: 'previewTextParagraph', name: 'Preview text', type: 'string', readonly: true, hidden: true },
    {
      kind: 'col',
      path: 'hasUnpublishedChanges',
      name: 'Has unpublished changes',
      type: 'checkbox',
      readonly: true,
      hidden: true,
    },
    {
      kind: 'col',
      path: 'mostRecentContributorId',
      name: 'Last edited by',
      type: 'string',
      readonly: true,
      hidden: true,
      foreignKey: wixBlogForeignKeyTo('members', { isSingleValued: true }),
    },
    joinedScalarArrayCol('pricingPlanIds', 'Pricing plan IDs', { hidden: true }),
    { kind: 'col', path: 'media.displayed', name: 'Cover image shown', type: 'checkbox', hidden: true },
    { kind: 'col', path: 'media.custom', name: 'Custom cover image', type: 'checkbox', hidden: true },
    // Wix's SEO payload is an arbitrary head-tag AST (`{type, children, props}`) with no single
    // scalar worth plucking, so it stays an opaque blob — off by default rather than three columns
    // of JSON.
    { kind: 'col', path: 'seoData', name: 'SEO data', type: 'object', hidden: true },
  ];
}

// ── Categories ───────────────────────────────────────────────────────────────

function buildCategoryCols(): TableViewCol[] {
  return [
    { kind: 'col', path: 'label', name: 'Label', type: 'string' },
    { kind: 'col', path: 'title', name: 'Page title', type: 'string' },
    { kind: 'col', path: 'description', name: 'Description', type: 'string' },
    { kind: 'col', path: 'slug', name: 'Slug', type: 'string', readonly: true },
    { kind: 'col', path: 'postCount', name: 'Posts', type: 'number', readonly: true },
    { kind: 'col', path: 'displayPosition', name: 'Menu position', type: 'number' },
    { kind: 'col', path: 'language', name: 'Language', type: 'string' },
    dateCol('_updatedDate', 'Last updated'),
    { kind: 'col', path: '_id', name: 'Category ID', type: 'string', readonly: true, hidden: true },
    { kind: 'col', path: 'translationId', name: 'Translation group', type: 'string', readonly: true, hidden: true },
  ];
}

// ── Tags ─────────────────────────────────────────────────────────────────────

function buildTagCols(): TableViewCol[] {
  return [
    { kind: 'col', path: 'label', name: 'Label', type: 'string' },
    { kind: 'col', path: 'slug', name: 'Slug', type: 'string', readonly: true },
    { kind: 'col', path: 'postCount', name: 'Posts', type: 'number', readonly: true },
    { kind: 'col', path: 'publishedPostCount', name: 'Published posts', type: 'number', readonly: true },
    { kind: 'col', path: 'language', name: 'Language', type: 'string' },
    dateCol('_createdDate', 'Created'),
    dateCol('_updatedDate', 'Last updated'),
    { kind: 'col', path: '_id', name: 'Tag ID', type: 'string', readonly: true, hidden: true },
    { kind: 'col', path: 'translationId', name: 'Translation group', type: 'string', readonly: true, hidden: true },
  ];
}

// ── Members ──────────────────────────────────────────────────────────────────

function buildMemberCols(): TableViewCol[] {
  return [
    // Wix nests the useful member fields two levels down (`profile.*`, `contact.*`). Surfacing the
    // leaves as named top-level columns is the whole point of this view — without it a destination
    // gets columns literally called `nickname`, `photo` and `customFields`.
    { kind: 'col', path: 'profile.nickname', name: 'Name', type: 'string' },
    { kind: 'col', path: 'loginEmail', name: 'Email', type: 'string' },
    { kind: 'col', path: 'contact.firstName', name: 'First name', type: 'string' },
    { kind: 'col', path: 'contact.lastName', name: 'Last name', type: 'string' },
    { kind: 'col', path: 'profile.photo.url', name: 'Photo', type: 'url' },
    { kind: 'col', path: 'status', name: 'Status', type: 'string' },
    { kind: 'col', path: 'privacyStatus', name: 'Profile privacy', type: 'string' },
    { kind: 'col', path: 'activityStatus', name: 'Activity', type: 'string' },
    dateCol('lastLoginDate', 'Last login'),
    dateCol('_createdDate', 'Joined'),
    dateCol('_updatedDate', 'Last updated'),

    { kind: 'col', path: '_id', name: 'Member ID', type: 'string', readonly: true, hidden: true },
    { kind: 'col', path: 'profile.slug', name: 'Profile slug', type: 'string', hidden: true },
    { kind: 'col', path: 'profile.title', name: 'Profile title', type: 'string', hidden: true },
    { kind: 'col', path: 'loginEmailVerified', name: 'Email verified', type: 'checkbox', hidden: true },
    { kind: 'col', path: 'contactId', name: 'Contact ID', type: 'string', readonly: true, hidden: true },
    joinedScalarArrayCol('contact.phones', 'Phones', { hidden: true }),
    joinedScalarArrayCol('contact.emails', 'Emails', { hidden: true }),
    { kind: 'col', path: 'contact.addresses', name: 'Addresses', type: 'object', hidden: true },
    { kind: 'col', path: 'contact.customFields', name: 'Contact custom fields', type: 'object', hidden: true },
  ];
}
