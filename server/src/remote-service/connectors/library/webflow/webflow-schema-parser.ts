import { sanitizeForTableWsId } from '../../ids';
import { TablePreview } from '../../types';
import {
  webflowCollectionBasePath,
  webflowSecondaryLocaleBasePath,
  webflowSecondaryLocaleFolderName,
} from './webflow-folder-paths';
import { Collection, CollectionListArrayItem, Locale, Site } from './webflow-types';

export class WebflowSchemaParser {
  /**
   * Build the table-picker preview for a CMS collection. `parentPath` groups the
   * collection under the folder it will actually land in after pull, so the
   * picker tree matches the post-pull tree. For v2 (nested) accounts that is
   * `<Site>/Collections`; for v1 it is `<Site>`. Assets/Pages previews are built
   * inline in the connector and always stay flat at `<Site>`.
   */
  parseTablePreview(site: Site, collection: CollectionListArrayItem | Collection, structureVersion = 1): TablePreview {
    return {
      id: {
        wsId: sanitizeForTableWsId(collection.id),
        remoteId: [site.id, collection.id],
      },
      displayName: `${collection.displayName}`,
      parentPath: webflowCollectionBasePath(site, structureVersion).join('/'),
      metadata: {
        siteId: site.id,
        siteName: site.displayName,
        collectionName: collection.displayName,
      },
    };
  }

  /**
   * Build the table-picker preview for a collection's **secondary locale**
   * (DEV-10529). It groups under the primary collection (`parentPath` = the
   * collection's own folder) so the picker tree matches the post-pull layout,
   * where the locale folder nests inside the collection:
   * `/<Site>/Collections/<Collection>/<Locale>`.
   *
   * Creates and deletes are disabled: in Webflow a localized variant is added or
   * removed together with its primary item (they share one item id), so per-locale
   * create/delete is ambiguous and would touch the shared item. Editing and
   * publishing localized field *values* is the supported operation.
   */
  parseSecondaryLocaleTablePreview(
    site: Site,
    collection: CollectionListArrayItem | Collection,
    locale: Locale,
    structureVersion = 1,
  ): TablePreview {
    const localeName = webflowSecondaryLocaleFolderName(locale);
    return {
      id: {
        wsId: sanitizeForTableWsId(`${collection.id}_${locale.cmsLocaleId ?? ''}`),
        remoteId: [site.id, collection.id, locale.cmsLocaleId ?? ''],
      },
      displayName: localeName,
      parentPath: webflowSecondaryLocaleBasePath(site, `${collection.displayName}`, structureVersion).join('/'),
      disabledCreates: true,
      disabledDeletes: true,
      disabledReason:
        'Secondary locale: items are added or removed in the primary locale (Webflow localizes them automatically). Here you can edit and publish localized field values.',
      metadata: {
        siteId: site.id,
        siteName: site.displayName,
        collectionName: collection.displayName,
        cmsLocaleId: locale.cmsLocaleId,
        localeName,
      },
    };
  }
}
