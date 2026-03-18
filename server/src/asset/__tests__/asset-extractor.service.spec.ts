import { Service } from '@spinner/shared-types';
import { hashUrl, hashUrlPath } from '../../remote-service/connectors/asset-extraction-helpers';
import { Connector } from '../../remote-service/connectors/connector';
import { AssetExtractorService } from '../asset-extractor.service';
import { AssetExtractionInput, ConnectorAssetExtractionInput, ConnectorAssetResult } from '../asset.types';

/**
 * Minimal mock connector that delegates extractAssets to a provided function.
 * Avoids importing real connector classes which trigger circular dependencies in tests.
 */
function createMockConnector(
  extractAssetsFn: (input: ConnectorAssetExtractionInput) => ConnectorAssetResult[],
): Connector {
  return { extractAssets: extractAssetsFn } as unknown as Connector;
}

describe('AssetExtractorService', () => {
  let service: AssetExtractorService;

  beforeEach(() => {
    service = new AssetExtractorService();
  });

  describe('wrapping and deduplication', () => {
    it('should add workbookId, service, and dataFolderId from input', () => {
      const connector = createMockConnector(() => [{ remoteAssetId: 'asset_1', url: 'https://example.com/file.jpg' }]);

      const input: AssetExtractionInput = {
        workbookId: 'wb_1',
        service: Service.AIRTABLE,
        dataFolderId: 'df_1',
        recordFilePath: 'folder/record.json',
        recordContent: {},
        schema: {},
      };

      const result = service.extractAssets(connector, input);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        workbookId: 'wb_1',
        service: Service.AIRTABLE,
        dataFolderId: 'df_1',
        remoteAssetId: 'asset_1',
        url: 'https://example.com/file.jpg',
      });
    });

    it('should deduplicate entries by remoteAssetId', () => {
      const connector = createMockConnector(() => [
        { remoteAssetId: 'dup_1', url: 'https://example.com/a.jpg' },
        { remoteAssetId: 'dup_1', url: 'https://example.com/a.jpg' },
        { remoteAssetId: 'unique_2', url: 'https://example.com/b.jpg' },
      ]);

      const result = service.extractAssets(connector, {
        workbookId: 'wb_1',
        service: Service.AIRTABLE,
        recordFilePath: 'record.json',
        recordContent: {},
        schema: {},
      });

      expect(result).toHaveLength(2);
      expect(result[0].remoteAssetId).toBe('dup_1');
      expect(result[1].remoteAssetId).toBe('unique_2');
    });

    it('should pass recordContent, schema, and recordRemoteId to the connector', () => {
      let capturedInput: ConnectorAssetExtractionInput | undefined;
      const connector = createMockConnector((input) => {
        capturedInput = input;
        return [];
      });

      service.extractAssets(connector, {
        workbookId: 'wb_1',
        service: Service.NOTION,
        dataFolderId: 'df_1',
        recordFilePath: 'record.json',
        recordRemoteId: 'rec_123',
        recordContent: { id: 'page_1' },
        schema: { properties: {} },
      });

      expect(capturedInput).toEqual({
        recordContent: { id: 'page_1' },
        schema: { properties: {} },
        recordRemoteId: 'rec_123',
      });
    });

    it('should return empty array when connector returns no assets', () => {
      const connector = createMockConnector(() => []);

      const result = service.extractAssets(connector, {
        workbookId: 'wb_1',
        service: Service.AIRTABLE,
        recordFilePath: 'record.json',
        recordContent: {},
        schema: {},
      });

      expect(result).toHaveLength(0);
    });
  });

  describe('hash functions', () => {
    it('should produce consistent hashes for the same URL', () => {
      const hash1 = hashUrl('https://example.com/file.jpg');
      const hash2 = hashUrl('https://example.com/file.jpg');
      expect(hash1).toBe(hash2);
    });

    it('should hash only the path for expiring URLs', () => {
      const hash1 = hashUrlPath('https://example.com/file.jpg?token=abc');
      const hash2 = hashUrlPath('https://example.com/file.jpg?token=xyz');
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different URLs', () => {
      const hash1 = hashUrl('https://example.com/file1.jpg');
      const hash2 = hashUrl('https://example.com/file2.jpg');
      expect(hash1).not.toBe(hash2);
    });
  });
});
