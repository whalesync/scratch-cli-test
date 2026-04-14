import { Type } from '@sinclair/typebox';
import { ValuePointer } from '@sinclair/typebox/value';
import {
  ASSET_FIELD,
  AssetFieldOptions,
  FOREIGN_KEY_OPTIONS,
  ForeignKeyOptionSchema,
  READONLY_FLAG,
} from '../../../json-schema';
import { BaseJsonTableSpec, EntityId } from '../../../types';

/**
 * Build a BaseJsonTableSpec for Wix Blog draft posts.
 * Generates a JSON Schema describing the raw Wix DraftPost API response format.
 */
export function buildWixBlogJsonTableSpec(id: EntityId): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      _id: Type.Optional(Type.String({ description: 'Unique post identifier', [READONLY_FLAG]: true })),
      title: Type.Optional(Type.String({ description: 'Post title' })),
      excerpt: Type.Optional(Type.String({ description: 'Post excerpt/summary' })),
      featured: Type.Optional(Type.Boolean({ description: 'Featured post flag' })),
      commentingEnabled: Type.Optional(Type.Boolean({ description: 'Comments enabled flag' })),
      minutesToRead: Type.Optional(Type.Integer({ description: 'Estimated reading time', [READONLY_FLAG]: true })),
      wordCount: Type.Optional(Type.Integer({ description: 'Word count', [READONLY_FLAG]: true })),
      firstPublishedDate: Type.Optional(
        Type.String({ description: 'First publish date', format: 'date-time', [READONLY_FLAG]: true }),
      ),
      lastPublishedDate: Type.Optional(
        Type.String({ description: 'Last publish date', format: 'date-time', [READONLY_FLAG]: true }),
      ),
      slug: Type.Optional(Type.String({ description: 'SEO slug', [READONLY_FLAG]: true })),
      seoSlug: Type.Optional(Type.String({ description: 'SEO slug' })),
      url: Type.Optional(Type.String({ description: 'Post URL', format: 'uri', [READONLY_FLAG]: true })),
      status: Type.Optional(Type.String({ description: 'Post status: DRAFT, PUBLISHED, etc.', [READONLY_FLAG]: true })),
      memberId: Type.Optional(
        Type.String({
          description: 'Author member ID',
          [READONLY_FLAG]: true,
          [FOREIGN_KEY_OPTIONS]: { linkedTableId: 'wix_members' },
        }),
      ),
      hashtags: Type.Optional(Type.Array(Type.String(), { description: 'Post hashtags' })),
      categoryIds: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Category IDs',
          [FOREIGN_KEY_OPTIONS]: { linkedTableId: 'wix_blog_categories' },
        }),
      ),
      tagIds: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Tag IDs',
          [FOREIGN_KEY_OPTIONS]: { linkedTableId: 'wix_blog_tags' },
        }),
      ),
      relatedPostIds: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Related post IDs',
          [FOREIGN_KEY_OPTIONS]: { linkedTableId: id.wsId },
        }),
      ),
      pricingPlanIds: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Pricing plan IDs',
          [FOREIGN_KEY_OPTIONS]: { linkedTableId: 'wix_pricing_plans' },
        }),
      ),
      language: Type.Optional(Type.String({ description: 'Post language code' })),
      translationId: Type.Optional(
        Type.String({ description: 'Translation ID for multilingual', [READONLY_FLAG]: true }),
      ),
      richContent: Type.Optional(
        Type.Object(
          {
            nodes: Type.Optional(Type.Array(Type.Unknown(), { description: 'Rich content nodes' })),
            metadata: Type.Optional(Type.Unknown({ description: 'Rich content metadata' })),
          },
          { description: 'Wix Rich Content (Ricos) document' },
        ),
      ),
      heroImage: Type.Optional(
        Type.Object(
          {
            url: Type.Optional(Type.String({ description: 'Image URL', format: 'uri' })),
            height: Type.Optional(Type.Integer({ description: 'Image height' })),
            width: Type.Optional(Type.Integer({ description: 'Image width' })),
            altText: Type.Optional(Type.String({ description: 'Alt text' })),
          },
          {
            description: 'Hero/cover image',
            [ASSET_FIELD]: { idPath: null, urlExpires: false } satisfies AssetFieldOptions,
          },
        ),
      ),
      media: Type.Optional(
        Type.Object(
          {
            wixMedia: Type.Optional(Type.Unknown({ description: 'Wix media reference' })),
            displayed: Type.Optional(Type.Boolean({ description: 'Is media displayed' })),
            custom: Type.Optional(Type.Boolean({ description: 'Is custom media' })),
          },
          { description: 'Post media' },
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
    {
      $id: 'wix-blog/draft-posts',
      title: 'Blog Posts',
    },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Blog Posts',
    schema,
    idColumnRemoteId: '_id',
    titleColumnRemoteId: ['title'],
    mainContentColumnRemoteId: ['richContent'],
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Checks if a field is readonly.
 * @param field - The field name (e.g. "_id", "minutesToRead").
 * @param tableSpec - The table specification.
 * @returns True if the field is readonly, false otherwise.
 */
export function isReadonlyField(field: string, tableSpec: BaseJsonTableSpec): boolean {
  return ValuePointer.Get(tableSpec.schema, `/properties/${field}/${READONLY_FLAG}`) === true;
}

/**
 * Checks if a field is a foreign key.
 * @param field - The field name.
 * @param tableSpec - The table specification.
 * @returns True if the field is a foreign key, false otherwise.
 */
export function isForeignKey(field: string, tableSpec: BaseJsonTableSpec): boolean {
  return ValuePointer.Has(tableSpec.schema, `/properties/${field}/${FOREIGN_KEY_OPTIONS}`) !== undefined;
}

/**
 * Gets the foreign key options for a field if they exist.
 * @param field - The field name.
 * @param tableSpec - The table specification.
 * @returns The foreign key options, or undefined if the field is not a foreign key.
 */
export function getForeignKeyOptions(field: string, tableSpec: BaseJsonTableSpec): ForeignKeyOptionSchema | undefined {
  return ValuePointer.Get(tableSpec.schema, `/properties/${field}/${FOREIGN_KEY_OPTIONS}`) as
    | ForeignKeyOptionSchema
    | undefined;
}
