/**
 * Minimal type shapes for the Notion 2025-09-03 *data source* API responses.
 *
 * Reuses the property-map shape from the SDK v3 `DatabaseObjectResponse` since
 * individual property definitions (title / rich_text / select / etc.) did not
 * change in 2025-09-03 — only their owning container did, moving from the
 * database to the data source. When the SDK is bumped to v5 (Phase 4) these
 * shapes are replaced by the SDK's `DataSourceObjectResponse` and
 * `QueryDataSourceResponse` exports.
 */

import type { DatabaseObjectResponse, PageObjectResponse } from '@notionhq/client';

/** A Notion rich-text array, matching the database `title` rich-text shape. */
type NotionRichTextLike = Array<{ plain_text: string }>;

/**
 * The full data source object returned by `GET /v1/data_sources/{id}`.
 *
 * The `properties` map is structurally identical to `DatabaseObjectResponse.properties`
 * in the SDK v3 typings, so we reuse it directly.
 */
export interface NotionDataSourceObjectResponse {
  object: 'data_source';
  id: string;
  name?: string;
  title?: NotionRichTextLike;
  database_parent?: { type: 'database_id'; database_id: string };
  parent?: { type: 'database_id'; database_id: string };
  properties: DatabaseObjectResponse['properties'];
}

/**
 * A `search({ filter: { value: 'data_source' } })` result element. The shape
 * mirrors `NotionDataSourceObjectResponse` but the body is sometimes sparser.
 */
export interface NotionDataSourceSearchResult {
  object: 'data_source';
  id: string;
  name?: string;
  title?: NotionRichTextLike;
  database_parent?: { type: 'database_id'; database_id: string };
  parent?: { type: 'database_id'; database_id: string };
}

/** The body of `POST /v1/data_sources/{id}/query`, mirrors `databases.query`. */
export interface NotionQueryDataSourceResponse {
  object: 'list';
  results: Array<PageObjectResponse | { object: string; id: string }>;
  next_cursor: string | null;
  has_more: boolean;
}

/**
 * Best-effort extractor for the parent database id from a data source object.
 * Notion exposes the back-pointer as either `database_parent` (2025-09-03
 * canonical shape) or `parent` (compatibility shape) depending on endpoint.
 */
export function getDataSourceParentDatabaseId(
  ds: { database_parent?: { database_id?: string }; parent?: { database_id?: string } } | undefined,
): string | undefined {
  return ds?.database_parent?.database_id ?? ds?.parent?.database_id;
}

/**
 * Best-effort extractor for the display name of a data source. Falls back from
 * the rich-text `title` (when present) to the simple `name` string.
 */
export function getDataSourceDisplayName(ds: { name?: string; title?: NotionRichTextLike } | undefined): string {
  if (ds?.title && ds.title.length > 0) {
    return ds.title.map((t) => t.plain_text).join('');
  }
  return ds?.name ?? '';
}
