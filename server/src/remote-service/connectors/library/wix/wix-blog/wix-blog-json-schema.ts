import { Type } from '@sinclair/typebox';
import { ValuePointer } from '@sinclair/typebox/value';
import {
  ForeignKeyOptionSchema,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_LAST_MODIFIED_FIELD,
  X_SCRATCH_READONLY,
  X_SCRATCH_WRITE_ONCE,
} from '@spinner/shared-types';
import { BaseJsonTableSpec, EntityId, dotPath } from '../../../types';
import { escapePointerToken } from '../../../utils/json-pointer';
import { WixBlogTableKey, wixBlogForeignKeyTo, wixBlogTableKeyFromEntityId } from './wix-blog-tables';

/**
 * Build the BaseJsonTableSpec for whichever table `id` names.
 *
 * Every schema here describes the shape the **Wix SDK** returns, not the REST envelope: the SDK
 * renames `id`/`createdDate`/`updatedDate` to `_id`/`_createdDate`/`_updatedDate` and flattens
 * `media.wixMedia.image` from an object to a `wix:image://` URI string. Records are stored verbatim
 * (Connector Prime Directive), so the schema has to match the SDK.
 *
 * Only fields Wix actually returns are declared. Six fields that belong to the *published* `Post`
 * entity rather than the `DraftPost` we pull — `wordCount`, `lastPublishedDate`, `slug`, `url`,
 * `heroImage`, `translationId` — used to be declared here and were empty on 100% of records,
 * producing dead columns on every destination and a hero-image asset annotation that could never
 * fire (DEV-11117). They are deliberately absent.
 */
export function buildWixBlogJsonTableSpec(id: EntityId): BaseJsonTableSpec {
  const table = wixBlogTableKeyFromEntityId(id);
  switch (table) {
    case 'categories':
      return buildCategoriesTableSpec(id);
    case 'tags':
      return buildTagsTableSpec(id);
    case 'members':
      return buildMembersTableSpec(id);
    case 'posts':
    case undefined:
    default:
      // An unrecognized id predates the multi-table split; treat it as the posts table so an
      // existing data folder keeps resolving to the schema it was created with.
      return buildPostsTableSpec(id);
  }
}

// ── Blog Posts ───────────────────────────────────────────────────────────────

function buildPostsTableSpec(id: EntityId): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      _id: Type.Optional(Type.String({ description: 'Unique post identifier', [X_SCRATCH_READONLY]: true })),
      title: Type.Optional(Type.String({ description: 'Post title (max 200 characters)' })),
      excerpt: Type.Optional(Type.String({ description: 'Post excerpt/summary (max 500 characters)' })),
      featured: Type.Optional(Type.Boolean({ description: 'Featured post flag' })),
      commentingEnabled: Type.Optional(Type.Boolean({ description: 'Comments enabled flag' })),
      minutesToRead: Type.Optional(Type.Integer({ description: 'Estimated reading time', [X_SCRATCH_READONLY]: true })),
      status: Type.Optional(
        Type.String({
          description: 'Post status: DRAFT, UNPUBLISHED, PUBLISHED, SCHEDULED',
          [X_SCRATCH_READONLY]: true,
        }),
      ),
      // Wix populates `firstPublishedDate` only once a post has actually been published, so it is
      // empty for pure drafts. `editedDate` and `_createdDate` are the two timestamps present on
      // every record.
      firstPublishedDate: Type.Optional(
        Type.String({ description: 'First publish date', format: 'date-time', [X_SCRATCH_READONLY]: true }),
      ),
      editedDate: Type.Optional(
        Type.String({
          description: 'Last edit date',
          format: 'date-time',
          [X_SCRATCH_READONLY]: true,
          // Wix Query Language supports `$gt`/`$gte` on this field, so it is the driver for a
          // future incremental pull.
          [X_SCRATCH_LAST_MODIFIED_FIELD]: true,
        }),
      ),
      _createdDate: Type.Optional(
        Type.String({ description: 'Creation date', format: 'date-time', [X_SCRATCH_READONLY]: true }),
      ),
      hasUnpublishedChanges: Type.Optional(
        Type.Boolean({ description: 'Draft has edits not yet published', [X_SCRATCH_READONLY]: true }),
      ),
      seoSlug: Type.Optional(Type.String({ description: 'SEO slug (max 100 characters)' })),
      // The live URL slugs Wix has assigned this post. Our schema previously declared a singular
      // `slug`, which the DraftPost API never returns (DEV-11117).
      slugs: Type.Optional(
        Type.Array(Type.String(), { description: 'Assigned URL slugs', [X_SCRATCH_READONLY]: true }),
      ),
      previewTextParagraph: Type.Optional(
        Type.String({ description: 'Wix-generated preview text', [X_SCRATCH_READONLY]: true }),
      ),
      // Write-once rather than read-only. `createDraftPost` rejects a post with no author
      // ("Missing post owner information"), so marking this read-only made a create impossible from
      // Scratch: leave it empty and Wix 400s, set it and the annotation blocks the write. Wix owns
      // the value once the post exists, so it is settable exactly while the record is still local
      // (DEV-11128). `mostRecentContributorId` below stays read-only — Wix always owns that one.
      memberId: Type.Optional(
        Type.String({
          description: 'Author member ID (write-once: settable on create, owned by Wix after)',
          [X_SCRATCH_WRITE_ONCE]: true,
          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: wixBlogForeignKeyTo('members', { isSingleValued: true }),
        }),
      ),
      mostRecentContributorId: Type.Optional(
        Type.String({
          description: 'Member who last edited the post',
          [X_SCRATCH_READONLY]: true,
          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: wixBlogForeignKeyTo('members', { isSingleValued: true }),
        }),
      ),
      hashtags: Type.Optional(
        Type.Array(Type.String(), { description: 'Post hashtags, derived by Wix from #tags in the content' }),
      ),
      categoryIds: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Category IDs (max 10)',
          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: wixBlogForeignKeyTo('categories'),
        }),
      ),
      tagIds: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Tag IDs (max 30)',
          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: wixBlogForeignKeyTo('tags'),
        }),
      ),
      relatedPostIds: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Related post IDs (max 3)',
          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: wixBlogForeignKeyTo('posts'),
        }),
      ),
      // Pricing plans live in a separate Wix app that this connector does not read, so these stay
      // plain ids rather than a foreign key that could never resolve.
      pricingPlanIds: Type.Optional(Type.Array(Type.String(), { description: 'Pricing plan IDs' })),
      language: Type.Optional(Type.String({ description: 'Post language code (BCP-47)' })),
      richContent: Type.Optional(
        Type.Object(
          {
            nodes: Type.Optional(Type.Array(Type.Unknown(), { description: 'Ricos content nodes' })),
            documentStyle: Type.Optional(Type.Unknown({ description: 'Ricos document style' })),
            metadata: Type.Optional(Type.Unknown({ description: 'Ricos document metadata' })),
          },
          { description: 'Wix Rich Content (Ricos) document — the post body' },
        ),
      ),
      media: Type.Optional(
        Type.Object(
          {
            wixMedia: Type.Optional(
              Type.Object(
                {
                  // The SDK returns this as a `wix:image://v1/<mediaId>/...` URI string (the REST
                  // API returns an object instead). The default view resolves it to an https URL.
                  image: Type.Optional(Type.String({ description: 'Wix media image URI' })),
                },
                { description: 'Wix media reference' },
              ),
            ),
            displayed: Type.Optional(Type.Boolean({ description: 'Is media displayed' })),
            custom: Type.Optional(Type.Boolean({ description: 'Is custom media' })),
          },
          { description: 'Post cover media' },
        ),
      ),
      seoData: Type.Optional(
        Type.Object(
          {
            tags: Type.Optional(Type.Array(Type.Unknown(), { description: 'SEO meta tags' })),
            settings: Type.Optional(Type.Unknown({ description: 'SEO settings' })),
          },
          { description: 'SEO data' },
        ),
      ),
    },
    { $id: 'wix-blog/draft-posts', title: 'Blog Posts' },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Blog Posts',
    schema,
    idPath: dotPath('_id'),
    titlePath: dotPath('title'),
    mainContentPath: dotPath('richContent'),
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

// ── Categories ───────────────────────────────────────────────────────────────

function buildCategoriesTableSpec(id: EntityId): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      _id: Type.Optional(Type.String({ description: 'Unique category identifier', [X_SCRATCH_READONLY]: true })),
      label: Type.Optional(Type.String({ description: 'Category label shown to readers' })),
      title: Type.Optional(Type.String({ description: 'Category page title' })),
      description: Type.Optional(Type.String({ description: 'Category description' })),
      slug: Type.Optional(Type.String({ description: 'URL slug', [X_SCRATCH_READONLY]: true })),
      language: Type.Optional(Type.String({ description: 'Category language code (BCP-47)' })),
      postCount: Type.Optional(Type.Integer({ description: 'Number of posts', [X_SCRATCH_READONLY]: true })),
      displayPosition: Type.Optional(Type.Integer({ description: 'Sort position; -1 means hidden from the menu' })),
      translationId: Type.Optional(
        Type.String({ description: 'Groups translations of one category', [X_SCRATCH_READONLY]: true }),
      ),
      _updatedDate: Type.Optional(
        Type.String({
          description: 'Last update date',
          format: 'date-time',
          [X_SCRATCH_READONLY]: true,
          [X_SCRATCH_LAST_MODIFIED_FIELD]: true,
        }),
      ),
    },
    { $id: 'wix-blog/categories', title: 'Categories' },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Categories',
    schema,
    idPath: dotPath('_id'),
    titlePath: dotPath('label'),
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

// ── Tags ─────────────────────────────────────────────────────────────────────

function buildTagsTableSpec(id: EntityId): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      _id: Type.Optional(Type.String({ description: 'Unique tag identifier', [X_SCRATCH_READONLY]: true })),
      label: Type.Optional(Type.String({ description: 'Tag label shown to readers' })),
      slug: Type.Optional(Type.String({ description: 'URL slug', [X_SCRATCH_READONLY]: true })),
      language: Type.Optional(Type.String({ description: 'Tag language code (BCP-47)' })),
      postCount: Type.Optional(Type.Integer({ description: 'Number of posts', [X_SCRATCH_READONLY]: true })),
      publishedPostCount: Type.Optional(
        Type.Integer({ description: 'Number of published posts', [X_SCRATCH_READONLY]: true }),
      ),
      translationId: Type.Optional(
        Type.String({ description: 'Groups translations of one tag', [X_SCRATCH_READONLY]: true }),
      ),
      _createdDate: Type.Optional(
        Type.String({ description: 'Creation date', format: 'date-time', [X_SCRATCH_READONLY]: true }),
      ),
      _updatedDate: Type.Optional(
        Type.String({
          description: 'Last update date',
          format: 'date-time',
          [X_SCRATCH_READONLY]: true,
          [X_SCRATCH_LAST_MODIFIED_FIELD]: true,
        }),
      ),
    },
    { $id: 'wix-blog/tags', title: 'Tags' },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Tags',
    schema,
    idPath: dotPath('_id'),
    titlePath: dotPath('label'),
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

// ── Members ──────────────────────────────────────────────────────────────────

function buildMembersTableSpec(id: EntityId): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      _id: Type.Optional(Type.String({ description: 'Unique member identifier', [X_SCRATCH_READONLY]: true })),
      loginEmail: Type.Optional(Type.String({ description: 'Login email address' })),
      loginEmailVerified: Type.Optional(Type.Boolean({ description: 'Has the login email been verified' })),
      status: Type.Optional(Type.String({ description: 'Member status: PENDING, APPROVED, BLOCKED, OFFLINE' })),
      privacyStatus: Type.Optional(Type.String({ description: 'Profile privacy: PUBLIC or PRIVATE' })),
      activityStatus: Type.Optional(Type.String({ description: 'Activity status: ACTIVE or MUTED' })),
      contactId: Type.Optional(Type.String({ description: 'Linked CRM contact ID', [X_SCRATCH_READONLY]: true })),
      contact: Type.Optional(
        Type.Object(
          {
            firstName: Type.Optional(Type.String({ description: 'First name' })),
            lastName: Type.Optional(Type.String({ description: 'Last name' })),
            phones: Type.Optional(Type.Array(Type.String(), { description: 'Phone numbers' })),
            emails: Type.Optional(Type.Array(Type.String(), { description: 'Email addresses' })),
            addresses: Type.Optional(Type.Array(Type.Unknown(), { description: 'Addresses' })),
            customFields: Type.Optional(Type.Unknown({ description: 'Contact custom fields' })),
          },
          { description: 'CRM contact details' },
        ),
      ),
      profile: Type.Optional(
        Type.Object(
          {
            nickname: Type.Optional(Type.String({ description: 'Display name' })),
            slug: Type.Optional(Type.String({ description: 'Profile URL slug' })),
            title: Type.Optional(Type.String({ description: 'Profile title' })),
            photo: Type.Optional(
              Type.Object(
                {
                  url: Type.Optional(Type.String({ description: 'Photo URL', format: 'uri' })),
                  height: Type.Optional(Type.Integer({ description: 'Photo height' })),
                  width: Type.Optional(Type.Integer({ description: 'Photo width' })),
                  _id: Type.Optional(Type.String({ description: 'Wix media ID' })),
                },
                { description: 'Profile photo' },
              ),
            ),
          },
          { description: 'Public member profile' },
        ),
      ),
      lastLoginDate: Type.Optional(
        Type.String({ description: 'Last login date', format: 'date-time', [X_SCRATCH_READONLY]: true }),
      ),
      _createdDate: Type.Optional(
        Type.String({ description: 'Creation date', format: 'date-time', [X_SCRATCH_READONLY]: true }),
      ),
      _updatedDate: Type.Optional(
        Type.String({
          description: 'Last update date',
          format: 'date-time',
          [X_SCRATCH_READONLY]: true,
          [X_SCRATCH_LAST_MODIFIED_FIELD]: true,
        }),
      ),
    },
    { $id: 'wix-members/members', title: 'Members' },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Members',
    schema,
    idPath: dotPath('_id'),
    // A member's most human-readable label is the profile nickname; Wix always sets one.
    titlePath: dotPath('profile.nickname'),
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

/** The table keys this connector can build a spec for — used by tests and the pull router. */
export const WIX_BLOG_SPEC_BUILDERS: Record<WixBlogTableKey, (id: EntityId) => BaseJsonTableSpec> = {
  posts: buildPostsTableSpec,
  categories: buildCategoriesTableSpec,
  tags: buildTagsTableSpec,
  members: buildMembersTableSpec,
};

/**
 * Checks if a field is readonly.
 * @param field - The field name (e.g. "_id", "minutesToRead").
 * @param tableSpec - The table specification.
 * @returns True if the field is readonly, false otherwise.
 */
export function isReadonlyField(field: string, tableSpec: BaseJsonTableSpec): boolean {
  return ValuePointer.Get(tableSpec.schema, `/properties/${escapePointerToken(field)}/${X_SCRATCH_READONLY}`) === true;
}

/**
 * Checks if a field is a foreign key.
 * @param field - The field name.
 * @param tableSpec - The table specification.
 * @returns True if the field is a foreign key, false otherwise.
 */
export function isForeignKey(field: string, tableSpec: BaseJsonTableSpec): boolean {
  return ValuePointer.Has(
    tableSpec.schema,
    `/properties/${escapePointerToken(field)}/${X_SCRATCH_FOREIGN_KEY_OPTIONS}`,
  );
}

/**
 * Gets the foreign key options for a field if they exist.
 * @param field - The field name.
 * @param tableSpec - The table specification.
 * @returns The foreign key options, or undefined if the field is not a foreign key.
 */
export function getForeignKeyOptions(field: string, tableSpec: BaseJsonTableSpec): ForeignKeyOptionSchema | undefined {
  return ValuePointer.Get(
    tableSpec.schema,
    `/properties/${escapePointerToken(field)}/${X_SCRATCH_FOREIGN_KEY_OPTIONS}`,
  ) as ForeignKeyOptionSchema | undefined;
}
