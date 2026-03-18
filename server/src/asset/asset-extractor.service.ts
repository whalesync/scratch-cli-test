import { Injectable } from '@nestjs/common';
import { Connector } from '../remote-service/connectors/connector';
import { AssetExtractionInput, AssetIndexEntry } from './asset.types';

/**
 * Orchestrates asset extraction by delegating to the connector's `extractAssets` method,
 * then wrapping results with workbook/folder context and deduplicating.
 */
@Injectable()
export class AssetExtractorService {
  extractAssets(connector: Connector, input: AssetExtractionInput): AssetIndexEntry[] {
    const connectorResults = connector.extractAssets({
      recordContent: input.recordContent,
      schema: input.schema,
      recordRemoteId: input.recordRemoteId,
    });

    const entries: AssetIndexEntry[] = [];
    const seen = new Set<string>();

    for (const result of connectorResults) {
      if (seen.has(result.remoteAssetId)) continue;
      seen.add(result.remoteAssetId);
      entries.push({
        ...result,
        workbookId: input.workbookId,
        service: input.service,
        dataFolderId: input.dataFolderId,
      });
    }

    return entries;
  }
}
