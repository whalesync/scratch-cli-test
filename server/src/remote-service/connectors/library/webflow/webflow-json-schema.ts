import { TSchema, Type } from '@sinclair/typebox';
import { ValuePointer } from '@sinclair/typebox/value';
import {
  AssetFieldOptions,
  AssetTableOptions,
  ForeignKeyOptionSchema,
  TransformerTypes,
  X_SCRATCH_ASSET_FIELD,
  X_SCRATCH_ASSET_TABLE,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_LAST_MODIFIED_FIELD,
  X_SCRATCH_READONLY,
  X_SCRATCH_REMOTE_FIELD_ID,
  X_SCRATCH_SUGGESTED_IN_TRANSFORMER,
  X_SCRATCH_SUGGESTED_TRANSFORMER,
} from '@spinner/shared-types';
import _ from 'lodash';
import { BaseJsonTableSpec, DotPath, dotPath, EntityId } from '../../types';
import { escapePointerToken } from '../../utils/json-pointer';
import {
  findWebflowSecondaryLocaleByCmsLocaleId,
  webflowCollectionBasePath,
  webflowEcommerceBasePath,
  webflowSecondaryLocaleFolderName,
  webflowSiteFolderName,
} from './webflow-folder-paths';
import { Collection, Field, FieldType, isWebflowEcommerceCollectionSlug, Site } from './webflow-types';

/**
 * Convert a Webflow field to a TypeBox JSON Schema.
 * Annotates the schema with x-scratch metadata (readonly, foreign key, connector data type).
 */
export function webflowFieldToJsonSchema(field: Field): TSchema {
  const description = field.displayName;
  let schema: TSchema;

  switch (field.type) {
    case FieldType.PlainText:
      schema = Type.String({ description });
      break;

    case FieldType.Reference: {
      const refCollectionId = _.get(field.validations, 'collectionId') as string | undefined;
      schema = Type.String({
        description,
        [X_SCRATCH_FOREIGN_KEY_OPTIONS]: refCollectionId ? { linkedTableId: refCollectionId } : undefined,
      });
      break;
    }

    case FieldType.RichText:
      schema = Type.String({ description, contentMediaType: 'text/html' });
      break;

    case FieldType.Number: {
      const validations = field.validations as { format?: 'decimal' | 'integer' } | undefined;
      if (validations?.format === 'integer') {
        schema = Type.Integer({ description });
      } else {
        schema = Type.Number({ description });
      }
      break;
    }

    case FieldType.Switch:
      schema = Type.Boolean({ description });
      break;

    case FieldType.DateTime:
      schema = Type.String({ description, format: 'date-time' });
      break;

    case FieldType.Email:
      schema = Type.String({ description, format: 'email' });
      break;

    case FieldType.Phone:
      schema = Type.String({ description });
      break;

    case FieldType.Link:
      schema = Type.String({ description, format: 'uri' });
      break;

    case FieldType.VideoLink:
      // A populated Webflow "Video Link" field comes back as an oEmbed *object*
      // (`{ url, metadata: { html, title, thumbnail_url, … } }`) — Webflow enriches the
      // pasted video URL server-side — not the bare URI string a `Link` returns. Model
      // that verbatim object shape (metadata is an opaque passthrough we don't enumerate)
      // while still accepting a bare URI string defensively (e.g. an unresolved embed).
      schema = Type.Union(
        [
          Type.Object({ url: Type.String({ format: 'uri' }), metadata: Type.Optional(Type.Unknown()) }),
          Type.String({ format: 'uri' }),
        ],
        { description },
      );
      break;

    case FieldType.Color:
      schema = Type.String({ description });
      break;

    case FieldType.Option: {
      // Webflow options are in validations.options as array of { id, name }
      const options = _.get(field.validations, 'options', []) as { id: string; name: string }[];
      if (options.length > 0) {
        schema = Type.Union(
          options.map((opt) => Type.Literal(opt.id, { title: opt.name })),
          {
            description,
            [X_SCRATCH_SUGGESTED_TRANSFORMER]: {
              type: TransformerTypes.WebflowOptionIdToValue,
            },
            [X_SCRATCH_SUGGESTED_IN_TRANSFORMER]: {
              type: TransformerTypes.WebflowOption,
            },
          },
        );
      } else {
        schema = Type.String({ description });
      }
      break;
    }

    case FieldType.Image:
    case FieldType.File:
      schema = Type.Object(
        {
          // Webflow returns `alt: null` (and may return `fileId: null`) on a set image,
          // so these sub-fields must accept null, not just be absent (DEV-10453).
          fileId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          url: Type.String({ format: 'uri' }),
          alt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        },
        {
          description,
          [X_SCRATCH_ASSET_FIELD]: { idPath: 'fileId', urlExpires: false } satisfies AssetFieldOptions,
        },
      );
      break;

    case FieldType.MultiImage:
      schema = Type.Array(
        Type.Object({
          // Same null-tolerance as the single Image/File object above (DEV-10453).
          fileId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          url: Type.String({ format: 'uri' }),
          alt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        {
          description,
          [X_SCRATCH_ASSET_FIELD]: { idPath: 'fileId', urlExpires: false } satisfies AssetFieldOptions,
        },
      );
      break;

    case FieldType.MultiReference: {
      const multiRefCollectionId = _.get(field.validations, 'collectionId') as string | undefined;
      schema = Type.Array(Type.String(), {
        description,
        [X_SCRATCH_FOREIGN_KEY_OPTIONS]: multiRefCollectionId ? { linkedTableId: multiRefCollectionId } : undefined,
      });
      break;
    }

    default:
      // Default to unknown for unrecognized types
      schema = Type.Unknown({ description });
      break;
  }

  schema[X_SCRATCH_CONNECTOR_DATA_TYPE] = field.type;
  schema[X_SCRATCH_READONLY] = field.isEditable === false ? true : undefined;
  schema[X_SCRATCH_REMOTE_FIELD_ID] = field.id;
  return schema;
}

/**
 * Wrap an optional Webflow field schema so it also accepts `null`.
 *
 * Webflow returns `null` — not an absent key — for any unset optional field (e.g. an
 * unset `category` MultiReference comes back as `null`, not `[]` or absent). `Type.Optional`
 * alone only allows the key to be absent; it does not permit a present `null`, so the
 * verbatim record fails JSON-Schema conformance ("null is not of type ..."). Wrapping the
 * field in a nullable union fixes that while preserving round-trip fidelity (DEV-10453).
 *
 * The field's `description` and `x-scratch-*` annotations are hoisted onto the union (as a
 * sibling of `anyOf`) so the foreign-key, asset, read-only and table-view lookups — which
 * read them at the field's top level — keep working. The base type inside `anyOf[0]` still
 * carries them too, which the default-view builder's `unwrapOptional` relies on.
 */
function makeWebflowFieldSchemaOptionalNullable(annotatedFieldSchema: TSchema): TSchema {
  const nullableUnion = Type.Union([annotatedFieldSchema, Type.Null()]);
  for (const annotationKey of Object.keys(annotatedFieldSchema)) {
    if (annotationKey === 'description' || annotationKey.startsWith('x-scratch-')) {
      (nullableUnion as Record<string, unknown>)[annotationKey] = (annotatedFieldSchema as Record<string, unknown>)[
        annotationKey
      ];
    }
  }
  return Type.Optional(nullableUnion);
}

/**
 * Build a BaseJsonTableSpec schema from Webflow site and collection data.
 * Converts Webflow field types to JSON Schema types.
 * Uses field slugs as property keys.
 *
 * When `id.remoteId[2]` carries a `cmsLocaleId` (DEV-10529), this is a
 * **secondary-locale** table: the schema is identical to the primary (Webflow
 * localizes field *values*, not field *definitions*), but the folder nests one
 * level inside the primary collection at `/<Site>/Collections/<Collection>/<Locale>`,
 * and the title is suffixed with the locale name. The schema `$id` stays the bare
 * `collectionId` so reference fields (whose item ids are shared across locales)
 * keep resolving against the same collection.
 */
export function buildWebflowJsonTableSpec(
  id: EntityId,
  site: Site,
  collection: Collection,
  structureVersion = 1,
): BaseJsonTableSpec {
  const [, collectionId, cmsLocaleId] = id.remoteId;
  const isSecondaryLocale = Boolean(cmsLocaleId);
  const isEcommerce = isWebflowEcommerceCollectionSlug(collection.slug);
  const secondaryLocale = cmsLocaleId ? findWebflowSecondaryLocaleByCmsLocaleId(site, cmsLocaleId) : undefined;
  // For an unknown/deleted locale, fall back to the cmsLocaleId itself so the
  // folder is never empty-named and pull/publish still target the right locale.
  const localeFolderName = secondaryLocale
    ? webflowSecondaryLocaleFolderName(secondaryLocale) || cmsLocaleId
    : cmsLocaleId;

  const properties: Record<string, TSchema> = {};
  let titlePath: DotPath | undefined;
  let mainContentPath: DotPath | undefined;

  // Add item-level metadata fields (these are present in all Webflow items)
  properties['id'] = Type.String({ description: 'Unique item identifier (read-only)', [X_SCRATCH_READONLY]: true });
  properties['cmsLocaleId'] = Type.Optional(
    Type.String({ description: 'CMS locale identifier (read-only)', [X_SCRATCH_READONLY]: true }),
  );
  properties['lastPublished'] = Type.Optional(
    Type.Union([Type.String({ format: 'date-time' }), Type.Null()], {
      description: 'When the item was last published (read-only)',
      [X_SCRATCH_REMOTE_FIELD_ID]: 'published-on',
      [X_SCRATCH_READONLY]: true,
    }),
  );
  properties['lastUpdated'] = Type.Optional(
    Type.String({
      format: 'date-time',
      description: 'When the item was last updated (read-only)',
      [X_SCRATCH_REMOTE_FIELD_ID]: 'updated-on',
      // The fixed system field incremental pull filters on (`lastUpdated[gte]`).
      // last-modified field is discoverable generically; the actual capability
      // gate is the table type, not this annotation (see webflow-incremental.ts).
      [X_SCRATCH_LAST_MODIFIED_FIELD]: true,
      [X_SCRATCH_READONLY]: true,
    }),
  );
  properties['createdOn'] = Type.Optional(
    Type.String({
      format: 'date-time',
      description: 'When the item was created (read-only)',
      [X_SCRATCH_REMOTE_FIELD_ID]: 'created-on',
      [X_SCRATCH_READONLY]: true,
    }),
  );
  properties['isArchived'] = Type.Optional(
    Type.Boolean({ description: 'Whether the item is archived (default: false)' }),
  );
  properties['isDraft'] = Type.Optional(Type.Boolean({ description: 'Whether the item is a draft (default: false)' }));

  // Add fieldData wrapper to indicate where custom fields are stored
  const fieldDataProperties: Record<string, TSchema> = {};

  for (const field of collection.fields) {
    // Skip fields without a slug
    if (!field.slug) {
      continue;
    }

    const fieldSchema = webflowFieldToJsonSchema(field);

    // Check if field is required using Webflow's isRequired property
    // slug and name fields are always required for Webflow
    const isRequired = field.isRequired || field.slug === 'slug' || field.slug === 'name';

    if (isRequired) {
      fieldDataProperties[field.slug] = fieldSchema;
    } else {
      // Optional fields are excluded from the required array AND must accept null:
      // Webflow returns null for any unset optional field (DEV-10453).
      fieldDataProperties[field.slug] = makeWebflowFieldSchemaOptionalNullable(fieldSchema);
    }

    // Track title column (name field)
    if (field.slug === 'name') {
      titlePath = dotPath(['fieldData', field.slug].join('.'));
    }

    // Track main content column (first RichText field)
    if (!mainContentPath && field.type === FieldType.RichText) {
      mainContentPath = dotPath(['fieldData', field.slug].join('.'));
    }
  }

  // Add fieldData as an object containing all collection-specific fields
  properties['fieldData'] = Type.Object(fieldDataProperties, {
    description: 'Collection-specific field values',
  });

  const schema = Type.Object(properties, {
    $id: collectionId,
    title: isSecondaryLocale ? `${collection.displayName} (${localeFolderName})` : collection.displayName,
  });

  // The folder holding this collection's own records: Ecommerce collections group
  // under /<Site>/Ecommerce/; others under /<Site>/Collections/ (v2) or /<Site>/ (v1).
  const primaryCollectionBasePath = isEcommerce
    ? webflowEcommerceBasePath(site)
    : webflowCollectionBasePath(site, structureVersion);

  return {
    id,
    slug: collection.slug ?? id.wsId,
    // Secondary-locale tables take the locale name as their folder leaf and nest
    // inside the primary collection; primary tables keep the collection name and
    // base path unchanged (DEV-10529).
    name: isSecondaryLocale ? (localeFolderName ?? collection.displayName) : collection.displayName,
    schema,
    titlePath,
    mainContentPath,
    idPath: dotPath('id'),
    slugPath: dotPath('fieldData.slug'),
    // Ecommerce collections (Products/SKUs/Categories) group under
    // /<Site>/Ecommerce/ (DEV-10729); other CMS collections under
    // /<Site>/Collections/ (v2) or flat /<Site>/ (v1) — the latter shared with the
    // folder-move migration. A secondary locale nests one level deeper, inside its
    // primary collection folder either way (DEV-10529).
    basePath: isSecondaryLocale ? [...primaryCollectionBasePath, collection.displayName] : primaryCollectionBasePath,
    structureVersion,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Table ID prefix for Webflow site-level asset tables.
 */
export const WEBFLOW_ASSETS_TABLE_ID_PREFIX = '__assets__';

/**
 * Build a BaseJsonTableSpec schema for Webflow site assets.
 */
export function buildWebflowAssetsJsonTableSpec(id: EntityId, site: Site, structureVersion = 1): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      id: Type.String({ description: 'Unique asset identifier', [X_SCRATCH_READONLY]: true }),
      displayName: Type.String({ description: 'Display name of the asset' }),
      hostedUrl: makeWebflowFieldSchemaOptionalNullable(
        Type.String({
          description: 'Permanent CDN URL for the asset',
          format: 'uri',
          [X_SCRATCH_ASSET_FIELD]: { idPath: null, urlExpires: false } satisfies AssetFieldOptions,
        }),
      ),
      originalFileName: makeWebflowFieldSchemaOptionalNullable(
        Type.String({ description: 'Original file name at upload' }),
      ),
      contentType: makeWebflowFieldSchemaOptionalNullable(Type.String({ description: 'MIME content type' })),
      size: makeWebflowFieldSchemaOptionalNullable(Type.Number({ description: 'File size in bytes' })),
      altText: makeWebflowFieldSchemaOptionalNullable(Type.String({ description: 'Visual description of the asset' })),
      siteId: makeWebflowFieldSchemaOptionalNullable(
        Type.String({ description: 'Site that hosts this asset', [X_SCRATCH_READONLY]: true }),
      ),
      createdOn: makeWebflowFieldSchemaOptionalNullable(
        Type.String({ description: 'When the asset was created', format: 'date-time', [X_SCRATCH_READONLY]: true }),
      ),
      lastUpdated: makeWebflowFieldSchemaOptionalNullable(
        Type.String({
          description: 'When the asset was last updated',
          format: 'date-time',
          [X_SCRATCH_READONLY]: true,
        }),
      ),
    },
    {
      $id: `webflow-assets/${site.id}`,
      title: 'Assets',
      [X_SCRATCH_ASSET_TABLE]: {
        urlPath: 'hostedUrl',
        filenamePath: 'originalFileName',
        mimeTypePath: 'contentType',
        sizePath: 'size',
        widthPath: null,
        heightPath: null,
        altTextPath: 'altText',
        urlExpires: false,
      } satisfies AssetTableOptions,
    },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Assets',
    schema,
    idPath: dotPath('id'),
    titlePath: dotPath('displayName'),
    // Assets always stay flat at /<Site>/Assets regardless of version — only
    // collections nest. Stamp the account's structure version for consistency.
    basePath: [webflowSiteFolderName(site)],
    structureVersion,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Table ID prefix for Webflow site-level pages tables.
 */
export { WEBFLOW_PAGES_TABLE_ID_PREFIX } from './webflow-types';

/**
 * Build a BaseJsonTableSpec schema for Webflow site pages.
 *
 * Editable surface = page settings + the full SEO metadata customers asked for
 * (DEV-9698 T7): `title`, `slug`, `seo.{title,description}`, and
 * `openGraph.{title,titleCopied,description,descriptionCopied}`. These are
 * exactly the writable fields the Webflow Data API's PUT /pages/{id} accepts.
 *
 * Deliberately NOT modelled — the Webflow Data API exposes no such field, so
 * they are Designer-only and out of reach here (same boundary as page body/DOM
 * content): Open Graph image, canonical URL, and the per-page
 * search-visibility / noindex toggle. If a customer needs one of these, it is a
 * Webflow API gap, not a connector omission.
 */
export function buildWebflowPagesJsonTableSpec(id: EntityId, site: Site, structureVersion = 1): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      id: Type.String({ description: 'Unique page identifier', [X_SCRATCH_READONLY]: true }),
      title: makeWebflowFieldSchemaOptionalNullable(Type.String({ description: 'Title of the page' })),
      slug: makeWebflowFieldSchemaOptionalNullable(
        Type.String({ description: 'URL slug of the page (derived from title)' }),
      ),
      publishedPath: makeWebflowFieldSchemaOptionalNullable(
        Type.String({ description: 'Relative path of the published page URL', [X_SCRATCH_READONLY]: true }),
      ),
      parentId: makeWebflowFieldSchemaOptionalNullable(
        Type.String({ description: 'Identifier of the parent folder', [X_SCRATCH_READONLY]: true }),
      ),
      archived: makeWebflowFieldSchemaOptionalNullable(
        Type.Boolean({ description: 'Whether the page has been archived', [X_SCRATCH_READONLY]: true }),
      ),
      draft: makeWebflowFieldSchemaOptionalNullable(
        Type.Boolean({ description: 'Whether the page is a draft', [X_SCRATCH_READONLY]: true }),
      ),
      // Webflow returns the seo/openGraph objects with null sub-fields when unset, so the
      // sub-fields accept null (DEV-10453).
      seo: Type.Optional(
        Type.Object(
          {
            title: makeWebflowFieldSchemaOptionalNullable(
              Type.String({ description: 'SEO title shown in search engine results' }),
            ),
            description: makeWebflowFieldSchemaOptionalNullable(
              Type.String({ description: 'SEO description shown in search engine results' }),
            ),
          },
          { description: 'SEO-related fields for the page' },
        ),
      ),
      openGraph: Type.Optional(
        Type.Object(
          {
            title: makeWebflowFieldSchemaOptionalNullable(Type.String({ description: 'Open Graph title' })),
            titleCopied: makeWebflowFieldSchemaOptionalNullable(
              Type.Boolean({ description: 'Whether the OG title was copied from the SEO title' }),
            ),
            description: makeWebflowFieldSchemaOptionalNullable(Type.String({ description: 'Open Graph description' })),
            descriptionCopied: makeWebflowFieldSchemaOptionalNullable(
              Type.Boolean({ description: 'Whether the OG description was copied from the SEO description' }),
            ),
          },
          { description: 'Open Graph fields for the page' },
        ),
      ),
      createdOn: makeWebflowFieldSchemaOptionalNullable(
        Type.String({ description: 'When the page was created', format: 'date-time', [X_SCRATCH_READONLY]: true }),
      ),
      lastUpdated: makeWebflowFieldSchemaOptionalNullable(
        Type.String({
          description: 'When the page was last updated',
          format: 'date-time',
          [X_SCRATCH_READONLY]: true,
        }),
      ),
    },
    {
      $id: `webflow-pages/${site.id}`,
      title: 'Pages',
    },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Pages',
    schema,
    idPath: dotPath('id'),
    titlePath: dotPath('slug'),
    // Pages always stay flat at /<Site>/Pages regardless of version — only
    // collections nest. Stamp the account's structure version for consistency.
    basePath: [webflowSiteFolderName(site)],
    structureVersion,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Build a BaseJsonTableSpec schema for a Webflow site's **Ecommerce Orders**
 * (DEV-10729), grouped under `/<Site>/Ecommerce/Orders`.
 *
 * Orders carry a large, deeply-nested payload (addresses, purchasedItems,
 * stripeDetails, totals, downloadFiles, …). Rather than enumerate every field —
 * which would risk `enforce_schema` noise whenever Webflow adds one — the object
 * is **permissive** (`additionalProperties: true`, the QuickBooks pattern): the
 * verbatim order validates while only the display-relevant and writable fields are
 * modelled explicitly. The Prime Directive is preserved (nothing is reshaped).
 *
 * Editable surface = exactly the four fields Webflow's `PATCH …/orders/{id}`
 * accepts: `comment`, `shippingProvider`, `shippingTracking`,
 * `shippingTrackingURL`. Everything else is read-only. The identity is `orderId`
 * (orders have no `id`).
 */
export function buildWebflowOrdersJsonTableSpec(id: EntityId, site: Site, structureVersion = 1): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      orderId: Type.String({ description: 'Unique order identifier (read-only)', [X_SCRATCH_READONLY]: true }),
      status: makeWebflowFieldSchemaOptionalNullable(
        Type.String({ description: 'Order status (read-only)', [X_SCRATCH_READONLY]: true }),
      ),
      // Writable fields (the only ones Webflow's Order update accepts).
      comment: makeWebflowFieldSchemaOptionalNullable(Type.String({ description: 'Arbitrary note for your records' })),
      shippingProvider: makeWebflowFieldSchemaOptionalNullable(
        Type.String({ description: 'Company or method used to ship the order' }),
      ),
      shippingTracking: makeWebflowFieldSchemaOptionalNullable(
        Type.String({ description: 'Tracking number for the order shipment' }),
      ),
      shippingTrackingURL: makeWebflowFieldSchemaOptionalNullable(
        Type.String({ description: 'URL to track the order shipment', format: 'uri' }),
      ),
      // Read-only display fields.
      customerInfo: Type.Optional(
        Type.Union(
          [
            Type.Object(
              {
                fullName: makeWebflowFieldSchemaOptionalNullable(Type.String({ description: 'Customer full name' })),
                email: makeWebflowFieldSchemaOptionalNullable(Type.String({ description: 'Customer email' })),
              },
              { additionalProperties: true },
            ),
            Type.Null(),
          ],
          { description: 'Customer contact info (read-only)', [X_SCRATCH_READONLY]: true },
        ),
      ),
      purchasedItemsCount: makeWebflowFieldSchemaOptionalNullable(
        Type.Number({ description: 'Total number of items purchased (read-only)', [X_SCRATCH_READONLY]: true }),
      ),
      acceptedOn: makeWebflowFieldSchemaOptionalNullable(
        Type.String({ description: 'When the order was placed', format: 'date-time', [X_SCRATCH_READONLY]: true }),
      ),
      fulfilledOn: makeWebflowFieldSchemaOptionalNullable(
        Type.String({ description: 'When the order was fulfilled', format: 'date-time', [X_SCRATCH_READONLY]: true }),
      ),
    },
    {
      $id: `webflow-orders/${site.id}`,
      title: 'Orders',
      // Preserve every other order field Webflow returns, verbatim (Prime Directive).
      additionalProperties: true,
    },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Orders',
    schema,
    idPath: dotPath('orderId'),
    titlePath: dotPath('orderId'),
    // Orders group under /<Site>/Ecommerce/ alongside Products/SKUs/Categories.
    basePath: webflowEcommerceBasePath(site),
    structureVersion,
    generatedAt: new Date().toISOString(),
  };
}

const FIELD_DATA_PATH = '/properties/fieldData/properties';

/**
 * Checks if a field is readonly.
 * @param field - The slug of the field to check.
 * @param tableSpec - The table specification.
 * @returns True if the field is readonly, false otherwise.
 */
export function isReadonlyField(field: string, tableSpec: BaseJsonTableSpec): boolean {
  return (
    ValuePointer.Get(tableSpec.schema, `${FIELD_DATA_PATH}/${escapePointerToken(field)}/${X_SCRATCH_READONLY}`) === true
  );
}

/**
 * Checks if a field is a foreign key.
 * @param field - The slug of the field to check.
 * @param tableSpec - The table specification.
 * @returns True if the field is a foreign key, false otherwise.
 */
export function isForeignKey(field: string, tableSpec: BaseJsonTableSpec): boolean {
  return (
    ValuePointer.Has(
      tableSpec.schema,
      `${FIELD_DATA_PATH}/${escapePointerToken(field)}/${X_SCRATCH_FOREIGN_KEY_OPTIONS}`,
    ) !== undefined
  );
}

/**
 * Gets the foreign key options for a field if they exist.
 * @param field - The slug of the field to check.
 * @param tableSpec - The table specification.
 * @returns The foreign key options, or undefined if the field is not a foreign key.
 */
export function getForeignKeyOptions(field: string, tableSpec: BaseJsonTableSpec): ForeignKeyOptionSchema | undefined {
  return ValuePointer.Get(
    tableSpec.schema,
    `${FIELD_DATA_PATH}/${escapePointerToken(field)}/${X_SCRATCH_FOREIGN_KEY_OPTIONS}`,
  ) as ForeignKeyOptionSchema | undefined;
}
