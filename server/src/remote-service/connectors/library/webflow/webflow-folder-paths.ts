import { Locale, Site } from './webflow-types';

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

/**
 * The on-disk folder name for a Webflow **secondary locale** — the leaf segment
 * of a per-locale collection table's path (DEV-10529). Prefer the human-friendly
 * `displayName` ("Spanish (Spain)"); fall back through `tag` ("es-ES"),
 * `subdirectory` ("es"), then the locale ids so the segment is never empty.
 */
export function webflowSecondaryLocaleFolderName(locale: Locale): string {
  return locale.displayName || locale.tag || locale.subdirectory || locale.cmsLocaleId || locale.id || '';
}

/**
 * The `basePath` (folder segments preceding the table's own name) for a Webflow
 * **secondary-locale** CMS collection table (DEV-10529). The locale folder nests
 * one level *inside* its primary collection folder, so its base path is the
 * primary collection's full path and its leaf name is the locale name:
 *
 *   - v2 (nested): `/<Site>/Collections/<Collection>/<Locale>`
 *   - v1 (flat):   `/<Site>/<Collection>/<Locale>`
 *
 * The leaf `<Locale>` is supplied separately as the table-spec `name`
 * (`webflowSecondaryLocaleFolderName`), so this returns everything up to and
 * including the primary collection's own folder.
 */
export function webflowSecondaryLocaleBasePath(
  site: Site,
  collectionDisplayName: string,
  structureVersion: number,
): string[] {
  return [...webflowCollectionBasePath(site, structureVersion), collectionDisplayName];
}

/**
 * Find a site's secondary locale by its `cmsLocaleId` — the dimension that
 * distinguishes a per-locale collection table (`remoteId[2]`) from the primary.
 * Returns `undefined` if the locale no longer exists on the site.
 */
export function findWebflowSecondaryLocaleByCmsLocaleId(site: Site, cmsLocaleId: string): Locale | undefined {
  return site.locales?.secondary?.find((locale) => locale.cmsLocaleId === cmsLocaleId);
}
