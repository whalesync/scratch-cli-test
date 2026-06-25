import { TSchema } from '@sinclair/typebox';
import { BaseJsonTableSpec, ConnectorFile, dotPath } from '../../../types';

// Break the connector-registry circular import chain (same shape as the
// incremental connector spec).
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'WordPress'),
}));

const mockBatchRequest = jest.fn();
const mockUpdateRecord = jest.fn();
const mockDeleteRecord = jest.fn();

jest.mock('../wordpress-http-client', () => ({
  WordPressHttpClient: jest.fn().mockImplementation(() => ({
    batchRequest: mockBatchRequest,
    updateRecord: mockUpdateRecord,
    deleteRecord: mockDeleteRecord,
  })),
}));

import { WordPressConnector } from '../wordpress-connector';

/** Minimal table spec — update/delete only read `id.remoteId[0]` (the tableId). */
function specForTable(tableId: string): BaseJsonTableSpec {
  return {
    id: { wsId: tableId, remoteId: [tableId] },
    slug: tableId,
    name: tableId,
    idPath: dotPath('id'),
    schema: { properties: {} } as unknown as TSchema,
  };
}

describe('WordPressConnector batch-unsupported tables (media)', () => {
  let connector: WordPressConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new WordPressConnector('user', 'pass', 'https://example.com/wp-json/');
  });

  describe('updateRecords', () => {
    it('falls back to individual PATCH requests for media (never batches)', async () => {
      mockUpdateRecord
        .mockResolvedValueOnce({ id: 42, title: 'updated A' })
        .mockResolvedValueOnce({ id: 43, title: 'updated B' });

      const files: ConnectorFile[] = [{ id: 42 }, { id: 43 }];
      const changedFields = [{ title: 'updated A' }, { title: 'updated B' }];

      const result = await connector.updateRecords(specForTable('media'), files, changedFields);

      expect(mockBatchRequest).not.toHaveBeenCalled();
      expect(mockUpdateRecord).toHaveBeenCalledTimes(2);
      expect(mockUpdateRecord).toHaveBeenNthCalledWith(1, 'media', '42', { title: 'updated A' });
      expect(mockUpdateRecord).toHaveBeenNthCalledWith(2, 'media', '43', { title: 'updated B' });
      expect(result).toEqual([
        { id: 42, title: 'updated A' },
        { id: 43, title: 'updated B' },
      ]);
    });

    it('falls back to the input file when a response carries no id', async () => {
      mockUpdateRecord.mockResolvedValueOnce({});

      const files: ConnectorFile[] = [{ id: 99, title: 'local' }];
      const result = await connector.updateRecords(specForTable('media'), files, [{ title: 'changed' }]);

      expect(result).toEqual([{ id: 99, title: 'local' }]);
    });

    it('uses the batch API for batchable tables such as posts', async () => {
      mockBatchRequest.mockResolvedValueOnce({
        failed: 'none',
        responses: [{ status: 200, body: { id: 7, title: 'updated' } }],
      });

      const result = await connector.updateRecords(specForTable('posts'), [{ id: 7 }], [{ title: 'updated' }]);

      expect(mockUpdateRecord).not.toHaveBeenCalled();
      expect(mockBatchRequest).toHaveBeenCalledTimes(1);
      const calls = mockBatchRequest.mock.calls as unknown as unknown[][];
      const requests = calls[0][0] as { method: string; path: string }[];
      expect(requests).toEqual([{ method: 'PATCH', path: '/wp/v2/posts/7', body: { title: 'updated' } }]);
      expect(result).toEqual([{ id: 7, title: 'updated' }]);
    });
  });

  describe('deleteRecords', () => {
    it('falls back to individual DELETE requests for media (never batches)', async () => {
      mockDeleteRecord.mockResolvedValue(undefined);

      await connector.deleteRecords(specForTable('media'), [{ id: 42 }, { id: 43 }]);

      expect(mockBatchRequest).not.toHaveBeenCalled();
      expect(mockDeleteRecord).toHaveBeenCalledTimes(2);
      expect(mockDeleteRecord).toHaveBeenNthCalledWith(1, 'media', '42');
      expect(mockDeleteRecord).toHaveBeenNthCalledWith(2, 'media', '43');
    });

    it('uses the batch API for batchable tables such as posts', async () => {
      mockBatchRequest.mockResolvedValueOnce({ failed: 'none', responses: [{ status: 200, body: {} }] });

      await connector.deleteRecords(specForTable('posts'), [{ id: 7 }]);

      expect(mockDeleteRecord).not.toHaveBeenCalled();
      expect(mockBatchRequest).toHaveBeenCalledTimes(1);
      const calls = mockBatchRequest.mock.calls as unknown as unknown[][];
      const requests = calls[0][0] as { method: string; path: string }[];
      expect(requests).toEqual([{ method: 'DELETE', path: '/wp/v2/posts/7?force=true' }]);
    });

    // The per-record loop is not atomic, so the publish engine retries a
    // partially-deleted slice row by row — re-deleting rows already gone in the
    // first pass. A force-delete of an absent id returns 404; treat it as the
    // record already being deleted, not a failure (idempotent across retries).
    it('treats a 404 from an already-deleted media id as success and continues', async () => {
      const notFound = Object.assign(new Error('Not Found'), {
        isAxiosError: true,
        response: { status: 404 },
      });
      mockDeleteRecord
        .mockRejectedValueOnce(notFound) // id 42 already gone (retry of a prior success)
        .mockResolvedValueOnce(undefined); // id 43 deletes normally

      await expect(connector.deleteRecords(specForTable('media'), [{ id: 42 }, { id: 43 }])).resolves.toBeUndefined();

      expect(mockDeleteRecord).toHaveBeenCalledTimes(2);
      expect(mockDeleteRecord).toHaveBeenNthCalledWith(2, 'media', '43');
    });

    it('propagates a non-404 delete error for media', async () => {
      const forbidden = Object.assign(new Error('Forbidden'), {
        isAxiosError: true,
        response: { status: 403 },
      });
      mockDeleteRecord.mockRejectedValueOnce(forbidden);

      await expect(connector.deleteRecords(specForTable('media'), [{ id: 42 }])).rejects.toThrow('Forbidden');
    });
  });
});
