import { DatabaseObjectResponse, PageObjectResponse } from '@notionhq/client';
import { sanitizeForTableWsId } from '../../ids';
import { TablePreview } from '../../types';
import {
  getDataSourceDisplayName,
  getDataSourceParentDatabaseId,
  NotionDataSourceSearchResult,
} from './notion-data-source-types';

export class NotionSchemaParser {
  parseDatabaseTablePreview(db: DatabaseObjectResponse): TablePreview {
    const displayName = db.title.map((t) => t.plain_text).join('');
    return {
      id: {
        wsId: sanitizeForTableWsId(displayName),
        remoteId: [db.id],
      },
      displayName: displayName,
      metadata: {
        notionType: 'database',
      },
    };
  }

  /**
   * Build a TablePreview from a Notion 2025-09-03 data source search result.
   *
   * `remoteId` is `[databaseId, dataSourceId]` — the same shape the Phase 2
   * backfill writes into existing folders, so the discovery and backfill paths
   * converge. `remoteId[0]` must remain the database id for backward
   * compatibility with code that still uses it (e.g. `pages.create` with the
   * old `database_id` parent, and the resolveDataSourceId cache key).
   *
   * If the data source's parent database id is missing (theoretically the
   * shape always carries it, but the API contract is technically optional),
   * the data source id stands in as `remoteId[0]` and `remoteId[1]` — the
   * fallback keeps the array length-2 invariant so downstream code that
   * destructures both slots doesn't trip.
   */
  parseDataSourceTablePreview(ds: NotionDataSourceSearchResult): TablePreview {
    const displayName = getDataSourceDisplayName(ds);
    const parentDatabaseId = getDataSourceParentDatabaseId(ds);
    const remoteId: string[] = parentDatabaseId ? [parentDatabaseId, ds.id] : [ds.id, ds.id];
    return {
      id: {
        wsId: sanitizeForTableWsId(displayName),
        remoteId,
      },
      displayName,
      metadata: {
        notionType: 'data_source',
      },
    };
  }

  parsePageTablePreview(page: PageObjectResponse): TablePreview {
    let pageTitle: string | undefined = undefined;

    const titleProperty = Object.values(page.properties).find((property) => property.type === 'title');
    if (titleProperty && titleProperty.title.length > 0) {
      pageTitle = titleProperty.title[0].plain_text;
    }

    const displayName = pageTitle ?? page.id;
    return {
      id: {
        wsId: sanitizeForTableWsId(displayName),
        remoteId: [page.id],
      },
      displayName: displayName,
      metadata: {
        notionType: 'page',
      },
    };
  }
}
