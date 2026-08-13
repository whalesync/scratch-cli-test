import axios from 'axios';
import { WSLogger } from 'src/logger';
import {
  buildStaggeredPageSizeLadder,
  IntercomApiClient,
  IntercomConversationPage,
  IntercomError,
  IntercomPageBatch,
} from '../intercom-api-client';

// Mock create-api-client to return a mock axios instance
const mockGet = jest.fn();
const mockPost = jest.fn();
const mockPut = jest.fn();
const mockDelete = jest.fn();

jest.mock('../../../create-api-client', () => ({
  createApiClient: jest.fn(() => ({
    get: mockGet,
    post: mockPost,
    put: mockPut,
    delete: mockDelete,
  })),
}));

describe('IntercomApiClient', () => {
  let client: IntercomApiClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new IntercomApiClient('test-access-token');
  });

  // ---------------------------------------------------------------------------
  // validateCredentials
  // ---------------------------------------------------------------------------

  describe('validateCredentials', () => {
    it('succeeds when API returns 200', async () => {
      mockGet.mockResolvedValue({ data: { type: 'admin', id: '123' } });

      await expect(client.validateCredentials()).resolves.toBeUndefined();
      expect(mockGet).toHaveBeenCalledWith('/me');
    });

    it('throws IntercomError on 401', async () => {
      const error = new axios.AxiosError('Unauthorized', '401', undefined, undefined, {
        status: 401,
        data: { type: 'error.list', errors: [{ code: 'token_not_found' }] },
        statusText: 'Unauthorized',
        headers: {},
        config: {} as never,
      });
      mockGet.mockRejectedValue(error);

      await expect(client.validateCredentials()).rejects.toThrow(IntercomError);
      await expect(client.validateCredentials()).rejects.toThrow('Invalid access token');
    });

    it('rethrows non-401 errors', async () => {
      const error = new Error('Network error');
      mockGet.mockRejectedValue(error);

      await expect(client.validateCredentials()).rejects.toThrow('Network error');
    });
  });

  // ---------------------------------------------------------------------------
  // listArticles
  // ---------------------------------------------------------------------------

  describe('listArticles (faithful page walk)', () => {
    /** Build one page-based /articles response body. */
    function articlesPage(params: {
      ids: string[];
      page: number;
      perPage: number;
      totalPages: number;
      totalCount: number;
    }) {
      return {
        data: {
          type: 'list',
          data: params.ids.map((id) => ({ type: 'article', id, title: `Article ${id}` })),
          total_count: params.totalCount,
          pages: { type: 'pages', page: params.page, per_page: params.perPage, total_pages: params.totalPages },
        },
      };
    }

    async function collectBatches(gen: AsyncGenerator<IntercomPageBatch<{ id: string }>, void>) {
      const batches: IntercomPageBatch<{ id: string }>[] = [];
      for await (const batch of gen) {
        batches.push(batch);
      }
      return batches;
    }

    it('yields pages of articles with resume checkpoints and stops when total_count is met', async () => {
      mockGet
        .mockResolvedValueOnce(articlesPage({ ids: ['1', '2'], page: 1, perPage: 2, totalPages: 2, totalCount: 3 }))
        .mockResolvedValueOnce(articlesPage({ ids: ['3'], page: 2, perPage: 2, totalPages: 2, totalCount: 3 }));

      const batches = await collectBatches(client.listArticles(2));

      expect(batches).toEqual([
        { records: expect.arrayContaining([expect.objectContaining({ id: '1' })]) as unknown, resumeFromPage: 2 },
        { records: [expect.objectContaining({ id: '3' })] as unknown, resumeFromPage: 3 },
      ]);
      expect(batches[0].records).toHaveLength(2);
      // Clean walk (3 unique === total_count 3): no verification re-walk.
      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(mockGet).toHaveBeenNthCalledWith(1, '/articles', { params: { page: 1, per_page: 2 } });
      expect(mockGet).toHaveBeenNthCalledWith(2, '/articles', { params: { page: 2, per_page: 2 } });
    });

    it('defaults to the 250 max page size', async () => {
      mockGet.mockResolvedValueOnce(articlesPage({ ids: ['1'], page: 1, perPage: 250, totalPages: 1, totalCount: 1 }));

      await collectBatches(client.listArticles());

      expect(mockGet).toHaveBeenCalledWith('/articles', { params: { page: 1, per_page: 250 } });
    });

    it('deduplicates a record repeated across a page boundary within one walk', async () => {
      // Unstable tie-break: article '2' appears on both page 1 and page 2.
      mockGet
        .mockResolvedValueOnce(articlesPage({ ids: ['1', '2'], page: 1, perPage: 2, totalPages: 2, totalCount: 4 }))
        .mockResolvedValueOnce(articlesPage({ ids: ['2', '3'], page: 2, perPage: 2, totalPages: 2, totalCount: 4 }))
        // 3 unique < total_count 4 → verification re-walk at per_page 1 recovers '4'.
        .mockResolvedValueOnce(articlesPage({ ids: ['1'], page: 1, perPage: 1, totalPages: 4, totalCount: 4 }))
        .mockResolvedValueOnce(articlesPage({ ids: ['2'], page: 2, perPage: 1, totalPages: 4, totalCount: 4 }))
        .mockResolvedValueOnce(articlesPage({ ids: ['4'], page: 3, perPage: 1, totalPages: 4, totalCount: 4 }))
        .mockResolvedValueOnce(articlesPage({ ids: ['3'], page: 4, perPage: 1, totalPages: 4, totalCount: 4 }));

      const batches = await collectBatches(client.listArticles(2));

      const yieldedIds = batches.flatMap((b) => b.records.map((r) => r.id));
      expect(yieldedIds).toEqual(['1', '2', '3', '4']); // each exactly once, '4' recovered
      // The verification walk shifted the page size down by one.
      expect(mockGet).toHaveBeenNthCalledWith(3, '/articles', { params: { page: 1, per_page: 1 } });
      // Batches from the verification walk keep the primary walk's resume checkpoint.
      expect(batches[batches.length - 1].resumeFromPage).toBe(3);
    });

    it('throws IntercomError after exhausting all walk attempts on a persistent shortfall', async () => {
      const warnSpy = jest.spyOn(WSLogger, 'warn').mockImplementation(() => undefined);
      // Every walk returns the same single article while claiming total_count 2.
      mockGet.mockResolvedValue(articlesPage({ ids: ['1'], page: 1, perPage: 5, totalPages: 1, totalCount: 2 }));

      const batchesYieldedBeforeAbort: IntercomPageBatch<{ id: string }>[] = [];
      const consumeUntilAbort = async () => {
        for await (const batch of client.listArticles(5)) {
          batchesYieldedBeforeAbort.push(batch);
        }
      };

      await expect(consumeUntilAbort()).rejects.toThrow(IntercomError);
      await expect(consumeUntilAbort()).rejects.toThrow(
        'only 1 of the 2 records Intercom reports were seen. The pull was stopped before any records could be wrongly deleted',
      );

      expect(batchesYieldedBeforeAbort.flatMap((b) => b.records.map((r) => r.id))).toEqual(['1', '1']);
      // Each rejected consume ran 4 walks total (primary + 3 verification
      // re-walks down the staggered page-size ladder 5 → 4 → 3 → 2).
      expect(mockGet).toHaveBeenCalledTimes(8);
      const perPageSeries = mockGet.mock.calls.map(
        (call: [string, { params: { per_page: number } }]) => call[1].params.per_page,
      );
      expect(perPageSeries.slice(0, 4)).toEqual([5, 4, 3, 2]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ endpointPath: '/articles', uniqueRecordsSeen: 1 }),
      );
      warnSpy.mockRestore();
    });

    it('builds the staggered page-size ladder from the empirically validated ratios', () => {
      expect(buildStaggeredPageSizeLadder(250, 0)).toEqual([250, 175, 125, 90]);
      // Jitter shifts only the verification rungs; the primary walk stays at max.
      expect(buildStaggeredPageSizeLadder(250, 7)).toEqual([250, 168, 118, 83]);
      // The scaled-down ladder matches the live-validated complete one.
      expect(buildStaggeredPageSizeLadder(10, 0)).toEqual([10, 7, 5, 4]);
    });

    it('completes a resumed walk via the verification re-walk from page 1', async () => {
      mockGet
        // Primary walk resumes at page 2 of 2 — sees only the tail.
        .mockResolvedValueOnce(articlesPage({ ids: ['3', '4'], page: 2, perPage: 2, totalPages: 2, totalCount: 4 }))
        // Shortfall (2 < 4) → full re-walk at per_page 1 recovers the head.
        .mockResolvedValueOnce(articlesPage({ ids: ['1'], page: 1, perPage: 1, totalPages: 4, totalCount: 4 }))
        .mockResolvedValueOnce(articlesPage({ ids: ['2'], page: 2, perPage: 1, totalPages: 4, totalCount: 4 }))
        .mockResolvedValueOnce(articlesPage({ ids: ['3'], page: 3, perPage: 1, totalPages: 4, totalCount: 4 }))
        .mockResolvedValueOnce(articlesPage({ ids: ['4'], page: 4, perPage: 1, totalPages: 4, totalCount: 4 }));

      const batches = await collectBatches(client.listArticles(2, 2));

      expect(batches.flatMap((b) => b.records.map((r) => r.id))).toEqual(['3', '4', '1', '2']);
      expect(mockGet).toHaveBeenNthCalledWith(1, '/articles', { params: { page: 2, per_page: 2 } });
      expect(mockGet).toHaveBeenNthCalledWith(2, '/articles', { params: { page: 1, per_page: 1 } });
    });

    it('handles empty result', async () => {
      mockGet.mockResolvedValueOnce(articlesPage({ ids: [], page: 1, perPage: 250, totalPages: 0, totalCount: 0 }));

      const batches = await collectBatches(client.listArticles());

      expect(batches).toHaveLength(0);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // getArticle
  // ---------------------------------------------------------------------------

  describe('getArticle', () => {
    it('returns article by ID', async () => {
      const article = { type: 'article', id: '42', title: 'Test Article' };
      mockGet.mockResolvedValue({ data: article });

      const result = await client.getArticle('42');

      expect(result).toEqual(article);
      expect(mockGet).toHaveBeenCalledWith('/articles/42');
    });

    it('returns null on 404', async () => {
      const error = new axios.AxiosError('Not found', '404', undefined, undefined, {
        status: 404,
        data: {},
        statusText: 'Not Found',
        headers: {},
        config: {} as never,
      });
      mockGet.mockRejectedValue(error);

      const result = await client.getArticle('999');
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // createArticle
  // ---------------------------------------------------------------------------

  describe('createArticle', () => {
    it('creates and returns article', async () => {
      const article = { type: 'article', id: '99', title: 'New Article', author_id: 1 };
      mockPost.mockResolvedValue({ data: article });

      const result = await client.createArticle({ title: 'New Article', author_id: 1 });

      expect(result).toEqual(article);
      expect(mockPost).toHaveBeenCalledWith('/articles', { title: 'New Article', author_id: 1 });
    });
  });

  // ---------------------------------------------------------------------------
  // updateArticle
  // ---------------------------------------------------------------------------

  describe('updateArticle', () => {
    it('sends PUT with article ID and data', async () => {
      const updated = { type: 'article', id: '42', title: 'Updated' };
      mockPut.mockResolvedValue({ data: updated });

      const result = await client.updateArticle('42', { title: 'Updated' });

      expect(result).toEqual(updated);
      expect(mockPut).toHaveBeenCalledWith('/articles/42', { title: 'Updated' });
    });
  });

  // ---------------------------------------------------------------------------
  // deleteArticle
  // ---------------------------------------------------------------------------

  describe('deleteArticle', () => {
    it('sends DELETE with article ID', async () => {
      mockDelete.mockResolvedValue({ status: 200 });

      await client.deleteArticle('42');

      expect(mockDelete).toHaveBeenCalledWith('/articles/42');
    });

    it('swallows 404 errors', async () => {
      const error = new axios.AxiosError('Not found', '404', undefined, undefined, {
        status: 404,
        data: {},
        statusText: 'Not Found',
        headers: {},
        config: {} as never,
      });
      mockDelete.mockRejectedValue(error);

      await expect(client.deleteArticle('999')).resolves.toBeUndefined();
    });

    it('rethrows non-404 errors', async () => {
      const error = new axios.AxiosError('Server error', '500', undefined, undefined, {
        status: 500,
        data: {},
        statusText: 'Internal Server Error',
        headers: {},
        config: {} as never,
      });
      mockDelete.mockRejectedValue(error);

      await expect(client.deleteArticle('42')).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // listCollections
  // ---------------------------------------------------------------------------

  describe('listCollections', () => {
    it('yields batches of collections from the faithful page walk', async () => {
      const collections = [{ type: 'collection', id: '1', name: 'Getting Started' }];
      mockGet.mockResolvedValueOnce({
        data: {
          type: 'list',
          data: collections,
          total_count: 1,
          pages: { type: 'pages', page: 1, per_page: 250, total_pages: 1 },
        },
      });

      const batches: IntercomPageBatch<{ id: string }>[] = [];
      for await (const batch of client.listCollections()) {
        batches.push(batch);
      }

      expect(batches).toEqual([{ records: collections, resumeFromPage: 2 }]);
      expect(mockGet).toHaveBeenCalledWith('/help_center/collections', { params: { page: 1, per_page: 250 } });
    });

    it('handles zero collections', async () => {
      mockGet.mockResolvedValueOnce({
        data: {
          type: 'list',
          data: [],
          total_count: 0,
          pages: { type: 'pages', page: 1, per_page: 250, total_pages: 0 },
        },
      });

      const batches: unknown[] = [];
      for await (const batch of client.listCollections()) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getCollection
  // ---------------------------------------------------------------------------

  describe('getCollection', () => {
    it('returns collection by ID', async () => {
      const collection = { type: 'collection', id: '5', name: 'FAQ' };
      mockGet.mockResolvedValue({ data: collection });

      const result = await client.getCollection('5');

      expect(result).toEqual(collection);
      expect(mockGet).toHaveBeenCalledWith('/help_center/collections/5');
    });

    it('returns null on 404', async () => {
      const error = new axios.AxiosError('Not found', '404', undefined, undefined, {
        status: 404,
        data: {},
        statusText: 'Not Found',
        headers: {},
        config: {} as never,
      });
      mockGet.mockRejectedValue(error);

      const result = await client.getCollection('999');
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // createCollection
  // ---------------------------------------------------------------------------

  describe('createCollection', () => {
    it('creates and returns collection', async () => {
      const collection = { type: 'collection', id: '10', name: 'New Collection' };
      mockPost.mockResolvedValue({ data: collection });

      const result = await client.createCollection({ name: 'New Collection' });

      expect(result).toEqual(collection);
      expect(mockPost).toHaveBeenCalledWith('/help_center/collections', { name: 'New Collection' });
    });
  });

  // ---------------------------------------------------------------------------
  // updateCollection
  // ---------------------------------------------------------------------------

  describe('updateCollection', () => {
    it('sends PUT with collection ID and data', async () => {
      const updated = { type: 'collection', id: '5', name: 'Updated FAQ' };
      mockPut.mockResolvedValue({ data: updated });

      const result = await client.updateCollection('5', { name: 'Updated FAQ' });

      expect(result).toEqual(updated);
      expect(mockPut).toHaveBeenCalledWith('/help_center/collections/5', { name: 'Updated FAQ' });
    });
  });

  // ---------------------------------------------------------------------------
  // deleteCollection
  // ---------------------------------------------------------------------------

  describe('deleteCollection', () => {
    it('sends DELETE with collection ID', async () => {
      mockDelete.mockResolvedValue({ status: 200 });

      await client.deleteCollection('5');

      expect(mockDelete).toHaveBeenCalledWith('/help_center/collections/5');
    });

    it('swallows 404 errors', async () => {
      const error = new axios.AxiosError('Not found', '404', undefined, undefined, {
        status: 404,
        data: {},
        statusText: 'Not Found',
        headers: {},
        config: {} as never,
      });
      mockDelete.mockRejectedValue(error);

      await expect(client.deleteCollection('999')).resolves.toBeUndefined();
    });

    it('rethrows non-404 errors', async () => {
      const error = new axios.AxiosError('Server error', '500', undefined, undefined, {
        status: 500,
        data: {},
        statusText: 'Internal Server Error',
        headers: {},
        config: {} as never,
      });
      mockDelete.mockRejectedValue(error);

      await expect(client.deleteCollection('5')).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // listConversations
  // ---------------------------------------------------------------------------

  describe('listConversations', () => {
    it('yields pages of hydrated conversations', async () => {
      const listItem = { type: 'conversation', id: '1', title: 'Test' };
      const fullConversation = {
        type: 'conversation',
        id: '1',
        title: 'Test',
        conversation_parts: { type: 'conversation_part.list', conversation_parts: [], total_count: 0 },
      };

      mockGet.mockResolvedValueOnce({
        data: {
          type: 'conversation.list',
          conversations: [listItem],
          total_count: 1,
          pages: { type: 'pages', page: 1, per_page: 20, total_pages: 1 },
        },
      });
      // Hydration call
      mockGet.mockResolvedValueOnce({ data: fullConversation });

      const pages: IntercomConversationPage[] = [];
      for await (const page of client.listConversations()) {
        pages.push(page);
      }

      expect(pages).toHaveLength(1);
      expect(pages[0].items).toHaveLength(1);
      expect(pages[0].nextCursor).toBeUndefined();
      expect(mockGet).toHaveBeenCalledWith('/conversations/1');
    });

    it('follows cursor pagination', async () => {
      const conv1 = { type: 'conversation', id: '1' };
      const conv2 = { type: 'conversation', id: '2' };
      const fullConv1 = { ...conv1, conversation_parts: { type: 'list', conversation_parts: [], total_count: 0 } };
      const fullConv2 = { ...conv2, conversation_parts: { type: 'list', conversation_parts: [], total_count: 0 } };

      mockGet
        .mockResolvedValueOnce({
          data: {
            type: 'conversation.list',
            conversations: [conv1],
            total_count: 2,
            pages: { type: 'pages', page: 1, per_page: 1, total_pages: 2, next: { page: 2, starting_after: 'abc' } },
          },
        })
        .mockResolvedValueOnce({ data: fullConv1 }) // hydrate conv1
        .mockResolvedValueOnce({
          data: {
            type: 'conversation.list',
            conversations: [conv2],
            total_count: 2,
            pages: { type: 'pages', page: 2, per_page: 1, total_pages: 2 },
          },
        })
        .mockResolvedValueOnce({ data: fullConv2 }); // hydrate conv2

      const pages: IntercomConversationPage[] = [];
      for await (const page of client.listConversations(1)) {
        pages.push(page);
      }

      expect(pages).toHaveLength(2);
      expect(pages[0].nextCursor).toBe('abc');
      expect(pages[1].nextCursor).toBeUndefined();
      expect(mockGet).toHaveBeenCalledWith('/conversations', { params: { per_page: 1, starting_after: 'abc' } });
    });

    it('handles empty result', async () => {
      mockGet.mockResolvedValueOnce({
        data: {
          type: 'conversation.list',
          conversations: [],
          total_count: 0,
          pages: { type: 'pages', page: 1, per_page: 20, total_pages: 0 },
        },
      });

      const pages: IntercomConversationPage[] = [];
      for await (const page of client.listConversations()) {
        pages.push(page);
      }

      expect(pages).toHaveLength(0);
    });

    it('skips hydration when hydrate is false', async () => {
      const listItem = { type: 'conversation', id: '1', title: 'Test', state: 'open' };

      mockGet.mockResolvedValueOnce({
        data: {
          type: 'conversation.list',
          conversations: [listItem],
          total_count: 1,
          pages: { type: 'pages', page: 1, per_page: 20, total_pages: 1 },
        },
      });

      const pages: IntercomConversationPage[] = [];
      for await (const page of client.listConversations(20, false)) {
        pages.push(page);
      }

      expect(pages).toHaveLength(1);
      expect(pages[0].items).toEqual([listItem]);
      expect(pages[0].nextCursor).toBeUndefined();
      // Should NOT have made a hydration call to /conversations/1
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(mockGet).toHaveBeenCalledWith('/conversations', { params: { per_page: 20 } });
    });
  });

  // ---------------------------------------------------------------------------
  // getConversation
  // ---------------------------------------------------------------------------

  describe('getConversation', () => {
    it('returns conversation by ID', async () => {
      const conversation = { type: 'conversation', id: '42', title: 'Test' };
      mockGet.mockResolvedValue({ data: conversation });

      const result = await client.getConversation('42');

      expect(result).toEqual(conversation);
      expect(mockGet).toHaveBeenCalledWith('/conversations/42');
    });

    it('returns null on 404', async () => {
      const error = new axios.AxiosError('Not found', '404', undefined, undefined, {
        status: 404,
        data: {},
        statusText: 'Not Found',
        headers: {},
        config: {} as never,
      });
      mockGet.mockRejectedValue(error);

      const result = await client.getConversation('999');
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // searchConversationsUpdatedSince (incremental)
  // ---------------------------------------------------------------------------

  describe('searchConversationsUpdatedSince', () => {
    const query = { field: 'updated_at' as const, operator: '>' as const, value: 1_700_000_000 };

    it('POSTs /conversations/search with the query, ascending sort, and pagination', async () => {
      const listItem = { type: 'conversation', id: '1', title: 'Test' };
      const fullConversation = {
        type: 'conversation',
        id: '1',
        title: 'Test',
        conversation_parts: { type: 'conversation_part.list', conversation_parts: [], total_count: 0 },
      };

      mockPost.mockResolvedValueOnce({
        data: {
          type: 'conversation.list',
          conversations: [listItem],
          total_count: 1,
          pages: { type: 'pages', page: 1, per_page: 20, total_pages: 1 },
        },
      });
      // Hydration call goes through GET /conversations/{id}
      mockGet.mockResolvedValueOnce({ data: fullConversation });

      const pages: IntercomConversationPage[] = [];
      for await (const page of client.searchConversationsUpdatedSince(query)) {
        pages.push(page);
      }

      expect(pages).toHaveLength(1);
      expect(pages[0].items).toEqual([fullConversation]);
      expect(pages[0].nextCursor).toBeUndefined();
      expect(mockPost).toHaveBeenCalledWith('/conversations/search', {
        query,
        sort: { field: 'updated_at', order: 'ascending' },
        pagination: { per_page: 20 },
      });
      expect(mockGet).toHaveBeenCalledWith('/conversations/1');
    });

    it('follows cursor pagination via pages.next.starting_after', async () => {
      const conv1 = { type: 'conversation', id: '1' };
      const conv2 = { type: 'conversation', id: '2' };
      const fullConv1 = { ...conv1, conversation_parts: { type: 'list', conversation_parts: [], total_count: 0 } };
      const fullConv2 = { ...conv2, conversation_parts: { type: 'list', conversation_parts: [], total_count: 0 } };

      mockPost
        .mockResolvedValueOnce({
          data: {
            type: 'conversation.list',
            conversations: [conv1],
            total_count: 2,
            pages: { type: 'pages', page: 1, per_page: 1, total_pages: 2, next: { page: 2, starting_after: 'abc' } },
          },
        })
        .mockResolvedValueOnce({
          data: {
            type: 'conversation.list',
            conversations: [conv2],
            total_count: 2,
            pages: { type: 'pages', page: 2, per_page: 1, total_pages: 2 },
          },
        });
      mockGet.mockResolvedValueOnce({ data: fullConv1 }).mockResolvedValueOnce({ data: fullConv2 });

      const pages: IntercomConversationPage[] = [];
      for await (const page of client.searchConversationsUpdatedSince(query, 1)) {
        pages.push(page);
      }

      expect(pages).toHaveLength(2);
      expect(pages[0].nextCursor).toBe('abc');
      expect(pages[1].nextCursor).toBeUndefined();
      // Second page request threads the cursor into pagination.starting_after.
      expect(mockPost).toHaveBeenLastCalledWith('/conversations/search', {
        query,
        sort: { field: 'updated_at', order: 'ascending' },
        pagination: { per_page: 1, starting_after: 'abc' },
      });
    });

    it('skips hydration when hydrate is false', async () => {
      const listItem = { type: 'conversation', id: '1', title: 'Test', state: 'open' };
      mockPost.mockResolvedValueOnce({
        data: {
          type: 'conversation.list',
          conversations: [listItem],
          total_count: 1,
          pages: { type: 'pages', page: 1, per_page: 20, total_pages: 1 },
        },
      });

      const pages: IntercomConversationPage[] = [];
      for await (const page of client.searchConversationsUpdatedSince(query, 20, false)) {
        pages.push(page);
      }

      expect(pages).toEqual([{ items: [listItem], nextCursor: undefined }]);
      // No hydration GET /conversations/1
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('threads a resume cursor into the first request', async () => {
      mockPost.mockResolvedValueOnce({
        data: {
          type: 'conversation.list',
          conversations: [],
          total_count: 0,
          pages: { type: 'pages', page: 1, per_page: 20, total_pages: 0 },
        },
      });

      const pages: IntercomConversationPage[] = [];
      for await (const page of client.searchConversationsUpdatedSince(query, 20, true, 'resume_cursor')) {
        pages.push(page);
      }

      expect(pages).toHaveLength(0);
      expect(mockPost).toHaveBeenCalledWith('/conversations/search', {
        query,
        sort: { field: 'updated_at', order: 'ascending' },
        pagination: { per_page: 20, starting_after: 'resume_cursor' },
      });
    });
  });
});
