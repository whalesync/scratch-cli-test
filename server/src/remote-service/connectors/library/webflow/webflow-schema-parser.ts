import { sanitizeForTableWsId } from '../../ids';
import { TablePreview } from '../../types';
import { Collection, CollectionListArrayItem, Site } from './webflow-types';

export class WebflowSchemaParser {
  parseTablePreview(site: Site, collection: CollectionListArrayItem | Collection): TablePreview {
    return {
      id: {
        wsId: sanitizeForTableWsId(collection.id),
        remoteId: [site.id, collection.id],
      },
      displayName: `${collection.displayName}`,
      parentPath: site.displayName,
      metadata: {
        siteId: site.id,
        siteName: site.displayName,
        collectionName: collection.displayName,
      },
    };
  }
}
