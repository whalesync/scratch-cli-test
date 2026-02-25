import { sanitizeForTableWsId } from '../../ids';
import { EntityId } from '../../types';
import { WORDPRESS_EXCLUDE_TABLE_SLUGS, WORDPRESS_EXCLUDE_TAXONOMY_SLUGS } from './wordpress-constants';
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
