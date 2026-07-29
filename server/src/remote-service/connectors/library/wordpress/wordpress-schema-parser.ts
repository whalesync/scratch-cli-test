import { sanitizeForTableWsId } from '../../ids';
import { EntityId } from '../../types';
import {
  WORDPRESS_EXCLUDE_TABLE_SLUGS,
  WORDPRESS_EXCLUDE_TAXONOMY_SLUGS,
  WORDPRESS_PARENT_COLUMN_ID,
} from './wordpress-constants';
import { WordPressGetTaxonomiesApiResponse, WordPressGetTypesApiResponse } from './wordpress-types';

export enum WORDPRESS_RICH_TEXT_TARGET {
  // Default:
  HTML = 'html',
  MARKDOWN = 'markdown',
}

/**
 * Parse the table IDs and display names from the WordPress Types API.
 * The table ID matches the REST endpoint so we can use it directly in subsequent requests.
 */
export function parseTableInfoFromTypes(
  typesResponse: WordPressGetTypesApiResponse,
): { id: EntityId; displayName: string }[] {
  return Object.entries(typesResponse)
    .filter(
      ([, typeData]) =>
        typeData.rest_base && typeData.name && !WORDPRESS_EXCLUDE_TABLE_SLUGS.includes(typeData.slug ?? ''),
    )
    .map(([, typeData]) => {
      return {
        id: {
          wsId: sanitizeForTableWsId(typeData.rest_base),
          remoteId: [typeData.rest_base],
        },
        displayName: typeData.name,
      };
    });
}

/**
 * Parse the table IDs and display names from the WordPress Taxonomies API.
 * Filters out internal WordPress taxonomies via WORDPRESS_EXCLUDE_TAXONOMY_SLUGS.
 */
export function parseTableInfoFromTaxonomies(
  taxonomiesResponse: WordPressGetTaxonomiesApiResponse,
): { id: EntityId; displayName: string }[] {
  return Object.entries(taxonomiesResponse)
    .filter(
      ([, taxData]) => taxData.rest_base && taxData.name && !WORDPRESS_EXCLUDE_TAXONOMY_SLUGS.includes(taxData.slug),
    )
    .map(([, taxData]) => {
      return {
        id: {
          wsId: sanitizeForTableWsId(taxData.rest_base),
          remoteId: [taxData.rest_base],
        },
        displayName: taxData.name,
      };
    });
}

/**
 * Build the SELF-REFERENTIAL `parent` foreign key for a hierarchical collection.
 *
 * WordPress exposes a `parent` field — the id of another record in the SAME collection —
 * on hierarchical post types (Pages) and hierarchical taxonomies (Categories); flat ones
 * (Posts, Tags) have no parent. Undeclared, it exported as a bare integer and the whole
 * parent/child hierarchy was lost on every destination (DEV-11094).
 *
 * `hierarchical` is read from WordPress's own types/taxonomies metadata rather than
 * inferred from the presence of the field, so a plugin-registered `parent` on a flat
 * collection isn't mistaken for a hierarchy. Returns an empty list for a flat collection
 * (or one that isn't found), so the caller can always spread the result.
 */
export function buildHierarchicalParentForeignKey(
  tableId: string,
  typesResponse: WordPressGetTypesApiResponse,
  taxonomiesResponse: WordPressGetTaxonomiesApiResponse,
): { remoteColumnId: string; foreignKeyRemoteTableId: string }[] {
  const collectionsByRestBase = [...Object.values(typesResponse), ...Object.values(taxonomiesResponse)];
  const collection = collectionsByRestBase.find((candidate) => candidate.rest_base === tableId);
  if (collection?.hierarchical !== true) {
    return [];
  }
  return [{ remoteColumnId: WORDPRESS_PARENT_COLUMN_ID, foreignKeyRemoteTableId: tableId }];
}

/**
 * Build dynamic foreign key mappings from discovered taxonomies.
 * Each taxonomy's rest_base becomes both the FK column ID on post types
 * and the FK target table ID.
 */
export function buildTaxonomyForeignKeys(
  taxonomiesResponse: WordPressGetTaxonomiesApiResponse,
): { remoteColumnId: string; foreignKeyRemoteTableId: string }[] {
  return Object.entries(taxonomiesResponse)
    .filter(
      ([, taxData]) => taxData.rest_base && taxData.name && !WORDPRESS_EXCLUDE_TAXONOMY_SLUGS.includes(taxData.slug),
    )
    .map(([, taxData]) => ({
      remoteColumnId: taxData.rest_base,
      foreignKeyRemoteTableId: taxData.rest_base,
    }));
}
