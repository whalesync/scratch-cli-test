import { CollectionItem } from 'webflow-api/api';

// Ecommerce collection slugs to filter out (these are auto-created by Webflow when ecommerce is enabled)
export const WEBFLOW_ECOMMERCE_COLLECTION_SLUGS = ['products', 'categories', 'skus'];

// Predefined metadata column IDs
export const WEBFLOW_IS_DRAFT_COLUMN_ID = 'isDraft';
export const WEBFLOW_IS_ARCHIVED_COLUMN_ID = 'isArchived';
export const WEBFLOW_LAST_PUBLISHED_COLUMN_ID = 'lastPublished';
export const WEBFLOW_LAST_UPDATED_COLUMN_ID = 'lastUpdated';
export const WEBFLOW_CREATED_ON_COLUMN_ID = 'createdOn';

export type WebflowItemMetadata = Omit<CollectionItem, 'id' | 'fieldData'>;

export const WEBFLOW_METADATA_COLUMNS = [
  WEBFLOW_IS_DRAFT_COLUMN_ID,
  WEBFLOW_IS_ARCHIVED_COLUMN_ID,
  WEBFLOW_LAST_PUBLISHED_COLUMN_ID,
  WEBFLOW_LAST_UPDATED_COLUMN_ID,
  WEBFLOW_CREATED_ON_COLUMN_ID,
] as (keyof WebflowItemMetadata)[];
