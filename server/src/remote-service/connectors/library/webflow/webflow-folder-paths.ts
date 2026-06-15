import { Site } from './webflow-types';

/**
 * The folder segment that groups CMS collections under a site in the v2 (nested)
 * Webflow folder layout: `/<Site>/Collections/<Collection>`.
 *
 * This is the **single source of truth** for the segment string. Both the
 * connector's table-spec builder (Phase 0, new pulls) and the folder-move
 * migration's target-path computation (Phase 1, existing workbooks) reference
 * this constant so the two layouts can never drift (DEV-9698, finding C1).
 */
export const WEBFLOW_COLLECTIONS_FOLDER_SEGMENT = 'Collections';

/**
 * The connector structure version at which Webflow collections are nested under
 * `/<Site>/Collections/`. Accounts pinned below this stay on the flat v1 layout.
 * Mirrors the Webflow connector's `ConnectorRegistration.version` (DEV-10302).
 */
export const WEBFLOW_NESTED_STRUCTURE_VERSION = 2;

/**
 * The connector structure version of the flat v1 layout (`/<Site>/<Collection>`),
 * before collections were grouped under `/<Site>/Collections/`. This is the target
 * a rollback (inverse migration, DEV-9698 T6) restores both `DataFolder.version`
 * and `ConnectorAccount.version` to.
 */
export const WEBFLOW_FLAT_STRUCTURE_VERSION = 1;

/**
 * The site's on-disk folder name (the top segment of every Webflow table path).
 * Matches the legacy expression used by the table-spec builders.
 */
export function webflowSiteFolderName(site: Site): string {
  return site.displayName ?? site.shortName ?? '';
}

/**
 * The `basePath` (folder segments preceding the table's own name) for a Webflow
 * **CMS collection** at a given structure version.
 *
 * - v1 (flat):   `[siteName]`                  → `/<Site>/<Collection>`
 * - v2 (nested): `[siteName, 'Collections']`   → `/<Site>/Collections/<Collection>`
 *
 * Assets and Pages always stay flat at `[siteName]` regardless of version — only
 * collections nest — so they do not use this helper.
 */
export function webflowCollectionBasePath(site: Site, structureVersion: number): string[] {
  const siteName = webflowSiteFolderName(site);
  return structureVersion >= WEBFLOW_NESTED_STRUCTURE_VERSION
    ? [siteName, WEBFLOW_COLLECTIONS_FOLDER_SEGMENT]
    : [siteName];
}
