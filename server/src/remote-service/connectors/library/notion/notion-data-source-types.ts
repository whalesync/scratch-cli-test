/**
 * Helpers and re-exports for the Notion 2025-09-03 *data source* API. Phase 4
 * of DEV-8910 bumped `@notionhq/client` to 5.22.0, where these endpoints are
 * fully typed — so this module is now a thin layer over the SDK shapes plus
 * two convenience extractors used by the connector and schema parser.
 */

import { type DataSourceObjectResponse, type PartialDataSourceObjectResponse } from '@notionhq/client';

/**
 * Result row from `client.search({ filter: { value: 'data_source' } })`. The
 * SDK union includes the partial shape (id + properties only) for cases where
 * the search endpoint doesn't return a fully hydrated object.
 */
export type NotionDataSourceSearchResult = DataSourceObjectResponse | PartialDataSourceObjectResponse;

/**
 * Best-effort extractor for the parent database id from a data source object.
 *
 * The full `DataSourceObjectResponse.parent` is the *data source's* parent —
 * either a `DatabaseParentResponse` (normal case) or a `DataSourceParentResponse`
 * (for externally synced data sources). Both arms expose `database_id`, so
 * we can read it without narrowing. The `database_parent` field is the
 * database's *own* parent (page / workspace / etc.) and is the wrong choice
 * here. The partial shape from `search` carries neither field, in which case
 * this returns `undefined` and callers fall back to the data source id itself.
 */
export function getDataSourceParentDatabaseId(ds: NotionDataSourceSearchResult | undefined): string | undefined {
  if (!ds || !('parent' in ds) || !ds.parent) return undefined;
  return ds.parent.database_id;
}

/**
 * Best-effort extractor for the display name of a data source.
 * Joins the rich-text `title` array (always present on the full response,
 * absent on the partial shape from `search`). Returns `''` when the data
 * source is partial or the title is empty.
 */
export function getDataSourceDisplayName(ds: NotionDataSourceSearchResult | undefined): string {
  if (!ds || !('title' in ds) || !ds.title || ds.title.length === 0) return '';
  return ds.title.map((t) => t.plain_text).join('');
}
