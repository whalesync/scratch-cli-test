import axios from 'axios';
import { IntercomApiClient, IntercomError } from '../intercom-api-client';

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

  describe('listArticles', () => {
    it('yields pages of articles', async () => {
      const page1 = [
        { type: 'article', id: '1', title: 'Article 1' },
        { type: 'article', id: '2', title: 'Article 2' },
      ];
      const page2 = [{ type: 'article', id: '3', title: 'Article 3' }];

      mockGet
        .mockResolvedValueOnce({
          data: {
            type: 'list',
            data: page1,
            total_count: 3,
            pages: { type: 'pages', page: 1, per_page: 2, total_pages: 2 },
          },
        })
        .mockResolvedValueOnce({
          data: {
            type: 'list',
            data: page2,
            total_count: 3,
            pages: { type: 'pages', page: 2, per_page: 2, total_pages: 2 },
          },
        });

      const pages: unknown[][] = [];
      for await (const page of client.listArticles(2)) {
        pages.push(page);
      }

      expect(pages).toHaveLength(2);
      expect(pages[0]).toHaveLength(2);
      expect(pages[1]).toHaveLength(1);
    });

    it('stops after last page', async () => {
      mockGet.mockResolvedValueOnce({
        data: {
          type: 'list',
          data: [{ id: '1' }],
          total_count: 1,
          pages: { type: 'pages', page: 1, per_page: 25, total_pages: 1 },
        },
      });

      const pages: unknown[][] = [];
      for await (const page of client.listArticles()) {
        pages.push(page);
      }

      expect(pages).toHaveLength(1);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('handles empty result', async () => {
      mockGet.mockResolvedValueOnce({
        data: {
          type: 'list',
          data: [],
          total_count: 0,
          pages: { type: 'pages', page: 1, per_page: 25, total_pages: 0 },
        },
      });

      const pages: unknown[][] = [];
      for await (const page of client.listArticles()) {
        pages.push(page);
      }

      expect(pages).toHaveLength(0);
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
    it('yields pages of collections', async () => {
      const collections = [{ type: 'collection', id: '1', name: 'Getting Started' }];
      mockGet.mockResolvedValueOnce({
        data: {
          type: 'list',
          data: collections,
          total_count: 1,
          pages: { type: 'pages', page: 1, per_page: 20, total_pages: 1 },
        },
      });

      const pages: unknown[][] = [];
      for await (const page of client.listCollections()) {
        pages.push(page);
      }

      expect(pages).toHaveLength(1);
      expect(pages[0]).toEqual(collections);
    });

    it('handles zero collections', async () => {
      mockGet.mockResolvedValueOnce({
        data: {
          type: 'list',
          data: [],
          total_count: 0,
          pages: { type: 'pages', page: 1, per_page: 20, total_pages: 0 },
        },
      });

      const pages: unknown[][] = [];
      for await (const page of client.listCollections()) {
        pages.push(page);
      }

      expect(pages).toHaveLength(0);
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

      const pages: unknown[][] = [];
      for await (const page of client.listConversations()) {
        pages.push(page);
      }

      expect(pages).toHaveLength(1);
      expect(pages[0]).toHaveLength(1);
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

      const pages: unknown[][] = [];
      for await (const page of client.listConversations(1)) {
        pages.push(page);
      }

      expect(pages).toHaveLength(2);
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

      const pages: unknown[][] = [];
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

      const pages: unknown[][] = [];
      for await (const page of client.listConversations(20, false)) {
        pages.push(page);
      }

      expect(pages).toHaveLength(1);
      expect(pages[0]).toEqual([listItem]);
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
});
