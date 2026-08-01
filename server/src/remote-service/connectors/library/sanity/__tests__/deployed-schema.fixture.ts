import { SanityDeployedSchemaDocument } from '../sanity-types';

/**
 * A realistic deployed Studio schema document, mirroring the live shape observed on
 * project hkcx2dra (2026-07-31) after `sanity schema deploy`:
 *   - `_type: "system.schema"`, id `_.schemas.<workspaceName>`;
 *   - the `schema` payload is a JSON STRING of the serialized type array;
 *   - field order is the AUTHORED (non-alphabetical) Studio order;
 *   - Sanity OMITS titles equal to its default humanization (`metaTitle`'s declared
 *     "Meta Title" is absent below, exactly as live), and keeps the rest;
 *   - references serialize `to:` targets; arrays serialize member types under `of:`;
 *   - `validation` arrays and editor options ride along and must be ignored.
 */

const SERIALIZED_STUDIO_TYPES = [
  {
    fields: [
      { name: 'name', type: 'string', title: 'Full name' },
      { name: 'role', type: 'string' },
      { name: 'active', type: 'boolean', title: 'Currently active' },
      { name: 'joinedAt', type: 'datetime', title: 'Joined at' },
      { name: 'email', type: 'string', title: 'Email address' },
      {
        validation: [{ level: 'error', rules: [{ flag: 'uri', constraint: { options: { allowRelative: false } } }] }],
        name: 'website',
        type: 'url',
      },
      {
        options: { source: 'name' },
        validation: [{ level: 'error', rules: [{ flag: 'custom' }] }],
        name: 'slug',
        type: 'slug',
      },
      {
        fields: [
          { name: 'street', type: 'string' },
          { name: 'city', type: 'string' },
        ],
        name: 'address',
        type: 'object',
        title: 'Postal address',
      },
      { name: 'location', type: 'geopoint' },
    ],
    name: 'author',
    type: 'document',
  },
  {
    fields: [
      { name: 'title', type: 'string', title: 'Category title' },
      { name: 'description', type: 'text' },
    ],
    name: 'category',
    type: 'document',
  },
  {
    fields: [
      { name: 'title', type: 'string', title: 'Post title' },
      { options: { source: 'title' }, name: 'slug', type: 'slug' },
      { name: 'publishedAt', type: 'datetime', title: 'Published at' },
      { name: 'wordCount', type: 'number', title: 'Word count' },
      { name: 'rating', type: 'number' },
      { name: 'featured', type: 'boolean', title: 'Featured?' },
      { of: [{ type: 'string' }], name: 'tags', type: 'array' },
      { to: [{ type: 'author' }], name: 'author', type: 'reference' },
      {
        of: [{ to: [{ type: 'category' }], type: 'reference', title: 'Reference to category' }],
        name: 'categories',
        type: 'array',
      },
      // Multi-target reference — must stay un-annotated (a Scratch FK links one table).
      { to: [{ type: 'author' }, { type: 'category' }], name: 'relatedContent', type: 'reference' },
      {
        fields: [
          { name: 'metaTitle', type: 'string' }, // declared "Meta Title" — omitted by Sanity as the default humanization
          { name: 'metaDescription', type: 'string' },
        ],
        name: 'seo',
        type: 'object',
        title: 'SEO settings',
      },
      { of: [{ styles: [{ value: 'normal', title: 'Normal' }], type: 'block' }], name: 'body', type: 'array' },
    ],
    name: 'post',
    type: 'document',
    title: 'Blog post',
  },
];

export const DEPLOYED_SCHEMA_DOCUMENT_FIXTURE: SanityDeployedSchemaDocument = {
  _id: '_.schemas.default',
  _type: 'system.schema',
  workspace: { name: 'default', title: 'Scratch test studio' },
  version: '2025-05-01',
  schema: JSON.stringify(SERIALIZED_STUDIO_TYPES),
};
