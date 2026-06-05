/**
 * Local, hand-authored mirror of the subset of the Webflow Data API v2 types the
 * connector uses. These replace the vendored `webflow-api` SDK types (DEV-9754).
 *
 * Fidelity contract: every field name here matches the wire JSON exactly (the
 * Webflow v2 API is already camelCase and the old SDK applied no key renames to
 * any of these types), so a record built from a raw axios `response.data` is
 * byte-identical to what the SDK used to commit. The ONE transform the SDK
 * applied was coercing a handful of `date()`-typed fields (`Asset` /  `Page`
 * `createdOn`/`lastUpdated`) into `Date` objects, which then re-serialized to a
 * canonical `new Date(x).toISOString()` string on disk. `WebflowApiClient`
 * reproduces that normalization for exactly those fields. `CollectionItem` date
 * fields were typed `string` by the SDK (never coerced), so they pass through
 * verbatim. Date-typed fields are therefore modelled here as ISO `string`s — the
 * client returns strings, not `Date`s.
 */

// Ecommerce collection slugs to filter out (these are auto-created by Webflow when ecommerce is enabled)
export const WEBFLOW_ECOMMERCE_COLLECTION_SLUGS = ['products', 'categories', 'skus'];

// Predefined metadata column IDs
export const WEBFLOW_IS_DRAFT_COLUMN_ID = 'isDraft';
export const WEBFLOW_IS_ARCHIVED_COLUMN_ID = 'isArchived';
export const WEBFLOW_LAST_PUBLISHED_COLUMN_ID = 'lastPublished';
export const WEBFLOW_LAST_UPDATED_COLUMN_ID = 'lastUpdated';
export const WEBFLOW_CREATED_ON_COLUMN_ID = 'createdOn';

/**
 * Table ID prefix for Webflow site-level pages tables.
 */
export const WEBFLOW_PAGES_TABLE_ID_PREFIX = '__pages__';

// ---------------------------------------------------------------------------
// Field types
// ---------------------------------------------------------------------------

/**
 * Webflow CMS field types. Runtime const + matching string-literal union,
 * mirroring the SDK's `Webflow.FieldType` (member name === wire string value).
 * `webflow-json-schema.ts` switches on these members, so this must stay a
 * runtime value, not just a type.
 */
export const FieldType = {
  Color: 'Color',
  DateTime: 'DateTime',
  Email: 'Email',
  ExtFileRef: 'ExtFileRef',
  File: 'File',
  Image: 'Image',
  Link: 'Link',
  MultiImage: 'MultiImage',
  MultiReference: 'MultiReference',
  Number: 'Number',
  Option: 'Option',
  Phone: 'Phone',
  PlainText: 'PlainText',
  Reference: 'Reference',
  RichText: 'RichText',
  Switch: 'Switch',
  VideoLink: 'VideoLink',
} as const;
export type FieldType = (typeof FieldType)[keyof typeof FieldType];

/**
 * Webflow returns validation metadata as an open object whose keys depend on the
 * field type (`collectionId`, `options`, `format`, `maxLength`, …). The connector
 * reads individual keys via lodash `_.get`, so we keep this as a raw object.
 */
export type WebflowFieldValidations = Record<string, unknown>;

/** The details of a field in a collection. */
export interface Field {
  /** Unique identifier for a Field */
  id: string;
  /** Whether a field is required in a collection */
  isRequired: boolean;
  /** Whether the field is editable */
  isEditable?: boolean;
  /** The field type */
  type: FieldType;
  /** Slug of the field in the site URL structure */
  slug?: string;
  /** The display name of the field */
  displayName: string;
  /** Help text shown to anyone filling out this field */
  helpText?: string;
  /** Type-specific validation metadata */
  validations?: WebflowFieldValidations;
}

// ---------------------------------------------------------------------------
// Sites & collections
// ---------------------------------------------------------------------------

export interface Domain {
  id: string;
  url?: string;
  lastPublished?: string;
}

export interface Locale {
  id?: string;
  cmsLocaleId?: string;
  enabled?: boolean;
  displayName?: string;
  displayImageId?: string;
  redirect?: boolean;
  subdirectory?: string;
  tag?: string;
}

export interface Locales {
  primary?: Locale;
  secondary?: Locale[];
}

export type SiteDataCollectionType = 'always' | 'optOut' | 'disabled';

export interface Site {
  /** Unique identifier for the Site */
  id: string;
  /** Unique identifier for the Workspace */
  workspaceId?: string;
  /** Date the Site was created (ISO string) */
  createdOn?: string;
  /** Name given to the Site */
  displayName?: string;
  /** Slugified version of the name */
  shortName?: string;
  /** Date the Site was last published (ISO string) */
  lastPublished?: string;
  /** Date the Site was last updated (ISO string) */
  lastUpdated?: string;
  /** URL of a generated image for the Site */
  previewUrl?: string;
  /** Site timezone set under Site Settings */
  timeZone?: string;
  /** The ID of the parent folder the Site exists in */
  parentFolderId?: string;
  customDomains?: Domain[];
  locales?: Locales;
  dataCollectionEnabled?: boolean;
  dataCollectionType?: SiteDataCollectionType;
}

/** A collection object, including its fields (returned by `getCollection`). */
export interface Collection {
  /** Unique identifier for the Collection */
  id: string;
  /** Name given to the Collection */
  displayName: string;
  /** The name of one item in the Collection */
  singularName: string;
  /** Slug of the Collection in the site URL structure */
  slug?: string;
  /** Date the Collection was created (ISO string) */
  createdOn?: string;
  /** Date the Collection was last updated (ISO string) */
  lastUpdated?: string;
  /** The list of fields in the Collection */
  fields: Field[];
}

/** An element of the `listCollections` result array (no `fields`). */
export interface CollectionListArrayItem {
  /** Unique identifier for the Collection */
  id: string;
  /** Name given to the Collection */
  displayName?: string;
  /** The name of one item in the Collection */
  singularName?: string;
  /** Slug of the Collection in the site URL structure */
  slug?: string;
  /** Date the Collection was created (ISO string) */
  createdOn?: string;
  /** Date the Collection was last updated (ISO string) */
  lastUpdated?: string;
}

/** Wrapper returned by `listSites`. */
export interface SiteList {
  sites?: Site[];
}

/** Wrapper returned by `listCollections`. */
export interface CollectionList {
  collections?: CollectionListArrayItem[];
}

// ---------------------------------------------------------------------------
// Collection items
// ---------------------------------------------------------------------------

/**
 * The custom field values of an item. `name`/`slug` are the only well-known
 * keys; everything else is an arbitrary user-defined field slug, preserved
 * verbatim (the SDK used `.passthrough()` for this object).
 */
export interface CollectionItemFieldData {
  name?: string;
  slug?: string;
  [key: string]: unknown;
}

export interface CollectionItem {
  /** Unique identifier for the Item */
  id?: string;
  /** Identifier for the locale of the CMS item */
  cmsLocaleId?: string;
  /** Date the item was last published (ISO string) */
  lastPublished?: string;
  /** Date the item was last updated (ISO string) */
  lastUpdated?: string;
  /** Date the item was created (ISO string) */
  createdOn?: string;
  /** Whether the item is archived */
  isArchived?: boolean;
  /** Whether the item is a draft */
  isDraft?: boolean;
  fieldData: CollectionItemFieldData;
}

export interface CollectionItemWithIdInputFieldData {
  name?: string;
  slug?: string;
  [key: string]: unknown;
}

/** Element type of the `items` array in update requests. */
export interface CollectionItemWithIdInput {
  /** Unique identifier for the Item */
  id: string;
  cmsLocaleId?: string;
  lastPublished?: string;
  lastUpdated?: string;
  createdOn?: string;
  isArchived?: boolean;
  isDraft?: boolean;
  fieldData?: CollectionItemWithIdInputFieldData;
}

export interface CollectionItemListPagination {
  limit?: number;
  offset?: number;
  total?: number;
}

/** Wrapper returned by `listCollectionItems`. */
export interface CollectionItemList {
  items?: CollectionItem[];
  pagination?: CollectionItemListPagination;
}

/** Wrapper returned by the live create/update item endpoints. */
export interface CollectionItemListNoPagination {
  items?: CollectionItem[];
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export interface PageSeo {
  title?: string;
  description?: string;
}

export interface PageOpenGraph {
  title?: string;
  titleCopied?: boolean;
  description?: string;
  descriptionCopied?: boolean;
}

export interface Page {
  /** Unique identifier for the Page */
  id: string;
  /** Unique identifier for the Site */
  siteId?: string;
  /** Title of the Page */
  title?: string;
  /** Slug of the Page (derived from title) */
  slug?: string;
  /** Identifier of the parent folder */
  parentId?: string;
  /** Identifier for a linked Collection, if any */
  collectionId?: string;
  /** Date the Page was created (ISO string) */
  createdOn?: string;
  /** Date the Page was most recently updated (ISO string) */
  lastUpdated?: string;
  /** Whether the Page has been archived */
  archived?: boolean;
  /** Whether the Page is a draft */
  draft?: boolean;
  /** Whether the Page supports Page Branching */
  canBranch?: boolean;
  /** Whether the Page is a Branch of another Page */
  isBranch?: boolean;
  /** If the Page is a Branch, the ID of the Branch */
  branchId?: string;
  /** SEO-related fields for the Page */
  seo?: PageSeo;
  /** Open Graph fields for the Page */
  openGraph?: PageOpenGraph;
  /** Unique ID of the page locale */
  localeId?: string;
  /** Relative path of the published page URL */
  publishedPath?: string;
}

export interface PageList {
  pages?: Page[];
  pagination?: CollectionItemListPagination;
}

/** Request body for `updatePageSettings`. */
export interface PageMetadataWrite {
  localeId?: string;
  title?: string;
  slug?: string;
  seo?: PageSeo;
  openGraph?: PageOpenGraph;
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export interface AssetVariant {
  hostedUrl: string;
  originalFileName: string;
  displayName: string;
  format: string;
  width: number;
  height?: number;
  quality: number;
  error?: string;
}

export interface Asset {
  /** Unique identifier for this asset */
  id?: string;
  /** File format type (MIME) */
  contentType?: string;
  /** Size in bytes */
  size?: number;
  /** Identifier for the site that hosts this asset */
  siteId?: string;
  /** Link to the asset */
  hostedUrl?: string;
  /** Original file name at the time of upload */
  originalFileName?: string;
  /** Display name of the asset */
  displayName: string;
  /** Date the asset metadata was last updated (ISO string) */
  lastUpdated?: string;
  /** Date the asset metadata was created (ISO string) */
  createdOn?: string;
  /** Responsive asset variants created by Webflow */
  variants?: AssetVariant[];
  /** The visual description of the asset */
  altText?: string;
}

export interface AssetList {
  assets?: Asset[];
  pagination?: CollectionItemListPagination;
}

/**
 * The create-asset metadata response. `uploadDetails` holds the S3 presigned
 * POST policy fields under their exact wire (S3) key names — they are appended
 * to the upload form verbatim.
 */
export interface AssetUpload {
  uploadDetails?: Record<string, string>;
  contentType?: string;
  id?: string;
  parentFolder?: string;
  uploadUrl?: string;
  assetUrl?: string;
  hostedUrl?: string;
  originalFileName?: string;
  createdOn?: string;
  lastUpdated?: string;
}

// ---------------------------------------------------------------------------
// Derived helpers (kept from the previous SDK-backed module)
// ---------------------------------------------------------------------------

export type WebflowItemMetadata = Omit<CollectionItem, 'id' | 'fieldData'>;

export const WEBFLOW_METADATA_COLUMNS = [
  WEBFLOW_IS_DRAFT_COLUMN_ID,
  WEBFLOW_IS_ARCHIVED_COLUMN_ID,
  WEBFLOW_LAST_PUBLISHED_COLUMN_ID,
  WEBFLOW_LAST_UPDATED_COLUMN_ID,
  WEBFLOW_CREATED_ON_COLUMN_ID,
] as (keyof WebflowItemMetadata)[];
