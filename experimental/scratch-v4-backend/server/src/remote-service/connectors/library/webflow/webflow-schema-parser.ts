import { Webflow } from 'webflow-api';
import { sanitizeForTableWsId } from '../../ids';
import { TablePreview } from '../../types';

export class WebflowSchemaParser {
  parseTablePreview(
    site: Webflow.Site,
    collection: Webflow.CollectionListArrayItem | Webflow.Collection,
  ): TablePreview {
    return {
      id: {
        wsId: sanitizeForTableWsId(collection.id),
        remoteId: [site.id, collection.id],
      },
      displayName: `${collection.displayName}`,
      metadata: {
        siteId: site.id,
        siteName: site.displayName,
        collectionName: collection.displayName,
      },
    };
  }
}
