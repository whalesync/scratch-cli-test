import { sanitizeForTableWsId } from '../../ids';
import { TablePreview } from '../../types';
import { webflowCollectionBasePath } from './webflow-folder-paths';
import { Collection, CollectionListArrayItem, Site } from './webflow-types';

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
}
