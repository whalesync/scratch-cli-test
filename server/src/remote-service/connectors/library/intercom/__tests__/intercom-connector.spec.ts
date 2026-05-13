import { TSchema } from '@sinclair/typebox';
import { AxiosError } from 'axios';
import { Service } from '../../../service-constants';
import { BaseJsonTableSpec, ConnectorFile } from '../../../types';
import { IntercomConnector } from '../intercom-connector';
import { IntercomArticle, IntercomCollection, IntercomConversation } from '../intercom-types';

// Mock display-names to break circular import chain
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Intercom'),
}));

// Mock the API client
const mockValidateCredentials = jest.fn();
const mockListArticles = jest.fn();
const mockGetArticle = jest.fn();
const mockCreateArticle = jest.fn();
const mockUpdateArticle = jest.fn();
const mockDeleteArticle = jest.fn();
const mockListCollections = jest.fn();
const mockGetCollection = jest.fn();
const mockCreateCollection = jest.fn();
const mockUpdateCollection = jest.fn();
const mockDeleteCollection = jest.fn();
const mockListConversations = jest.fn();
const mockGetConversation = jest.fn();

jest.mock('../intercom-api-client', () => {
  return {
    IntercomApiClient: jest.fn().mockImplementation(() => ({
      validateCredentials: mockValidateCredentials,
      listArticles: mockListArticles,
      getArticle: mockGetArticle,
      createArticle: mockCreateArticle,
      updateArticle: mockUpdateArticle,
      deleteArticle: mockDeleteArticle,
      listCollections: mockListCollections,
      getCollection: mockGetCollection,
      createCollection: mockCreateCollection,
      updateCollection: mockUpdateCollection,
      deleteCollection: mockDeleteCollection,
      listConversations: mockListConversations,
      getConversation: mockGetConversation,
    })),
    IntercomError: class IntercomError extends Error {
      statusCode?: number;
      responseData?: unknown;
      constructor(message: string, statusCode?: number, responseData?: unknown) {
        super(message);
        this.name = 'IntercomError';
        this.statusCode = statusCode;
        this.responseData = responseData;
      }
    },
  };
});

function buildTableSpec(tableType: string): BaseJsonTableSpec {
  return {
    id: { wsId: tableType, remoteId: [tableType] },
    slug: tableType,
    name: tableType,
    schema: {} as unknown as TSchema,
    idColumnRemoteId: 'id',
  };
}

function makeArticle(overrides: Partial<IntercomArticle> = {}): IntercomArticle {
  return {
    type: 'article',
    id: '1',
    workspace_id: 'ws_123',
    title: 'Test Article',
    description: 'A test article',
    body: '<p>Hello world</p>',
    author_id: 1,
    state: 'draft',
    created_at: 1700000000,
    updated_at: 1700000000,
    url: null,
    parent_id: null,
    parent_ids: [],
    parent_type: null,
    default_locale: 'en',
    translated_content: null,
    statistics: null,
    ...overrides,
  };
}

function makeCollection(overrides: Partial<IntercomCollection> = {}): IntercomCollection {
  return {
    type: 'collection',
    id: '1',
    workspace_id: 'ws_123',
    name: 'Getting Started',
    description: 'A getting started collection',
    created_at: 1700000000,
    updated_at: 1700000000,
    url: null,
    icon: 'book-bookmark',
    order: 0,
    default_locale: 'en',
    translated_content: null,
    parent_id: null,
    help_center_id: null,
    ...overrides,
  };
}

function makeConversation(overrides: Partial<IntercomConversation> = {}): IntercomConversation {
  return {
    type: 'conversation',
    id: '1',
    title: null,
    created_at: 1700000000,
    updated_at: 1700000000,
    waiting_since: null,
    snoozed_until: null,
    open: true,
    state: 'open',
    read: false,
    priority: 'not_priority',
    admin_assignee_id: null,
    team_assignee_id: null,
    custom_attributes: {},
    source: {
      type: 'conversation',
      id: 'src_1',
      delivered_as: 'customer_initiated',
      subject: 'Help with billing',
      body: '<p>I need help</p>',
      author: { type: 'user', id: 'u1', name: 'Test User', email: 'user@test.com' },
      attachments: [],
      url: null,
      redacted: false,
    },
    contacts: { type: 'contact.list', contacts: [{ type: 'contact', id: 'c1' }] },
    teammates: null,
    tags: { type: 'tag.list', tags: [] },
    conversation_rating: null,
    statistics: null,
    conversation_parts: {
      type: 'conversation_part.list',
      conversation_parts: [],
      total_count: 0,
    },
    ...overrides,
  };
}

/** Helper to create an async generator from an array of pages. */
// eslint-disable-next-line @typescript-eslint/require-await
async function* asyncGen<T>(pages: T[][]): AsyncGenerator<T[], void> {
  for (const page of pages) {
    yield page;
  }
}

describe('IntercomConnector', () => {
  let connector: IntercomConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new IntercomConnector('test-access-token');
  });

  // ---------------------------------------------------------------------------
  // Basic properties
  // ---------------------------------------------------------------------------

  describe('service', () => {
    it('returns INTERCOM service', () => {
      expect(connector.service).toBe(Service.INTERCOM);
    });
  });

  describe('getBatchSize', () => {
    it('returns 10', () => {
      expect(connector.getBatchSize('create')).toBe(10);
      expect(connector.getBatchSize('update')).toBe(10);
      expect(connector.getBatchSize('delete')).toBe(10);
    });
  });

  // ---------------------------------------------------------------------------
  // testConnection
  // ---------------------------------------------------------------------------

  describe('testConnection', () => {
    it('delegates to API client validateCredentials', async () => {
      mockValidateCredentials.mockResolvedValue(undefined);
      await connector.testConnection();
      expect(mockValidateCredentials).toHaveBeenCalledTimes(1);
    });

    it('throws when credentials are invalid', async () => {
      mockValidateCredentials.mockRejectedValue(new Error('Invalid access token'));
      await expect(connector.testConnection()).rejects.toThrow('Invalid access token');
    });
  });

  // ---------------------------------------------------------------------------
  // listTables
  // ---------------------------------------------------------------------------

  describe('listTables', () => {
    it('returns articles, collections, and conversations tables', async () => {
      const tables = await connector.listTables();
      expect(tables).toHaveLength(3);

      const ids = tables.map((t) => t.id.wsId);
      expect(ids).toContain('articles');
      expect(ids).toContain('collections');
      expect(ids).toContain('conversations');
    });

    it('includes display names', async () => {
      const tables = await connector.listTables();
      const articles = tables.find((t) => t.id.wsId === 'articles');
      const collections = tables.find((t) => t.id.wsId === 'collections');
      const conversations = tables.find((t) => t.id.wsId === 'conversations');
      expect(articles?.displayName).toBe('Articles');
      expect(collections?.displayName).toBe('Collections');
      expect(conversations?.displayName).toBe('Conversations');
    });

    it('marks conversations as read-only (disabledCreates)', async () => {
      const tables = await connector.listTables();
      const conversations = tables.find((t) => t.id.wsId === 'conversations');
      expect(conversations?.disabledCreates).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // fetchJsonTableSpec
  // ---------------------------------------------------------------------------

  describe('fetchJsonTableSpec', () => {
    it('builds articles schema', async () => {
      const spec = await connector.fetchJsonTableSpec({ wsId: 'articles', remoteId: ['articles'] });

      expect(spec.name).toBe('Articles');
      expect(spec.idColumnRemoteId).toBe('id');
      expect(spec.titleColumnRemoteId).toEqual(['title']);
    });

    it('builds collections schema', async () => {
      const spec = await connector.fetchJsonTableSpec({ wsId: 'collections', remoteId: ['collections'] });

      expect(spec.name).toBe('Collections');
      expect(spec.idColumnRemoteId).toBe('id');
      expect(spec.titleColumnRemoteId).toEqual(['name']);
    });

    it('builds conversations schema', async () => {
      const spec = await connector.fetchJsonTableSpec({ wsId: 'conversations', remoteId: ['conversations'] });

      expect(spec.name).toBe('Conversations');
      expect(spec.idColumnRemoteId).toBe('id');
      expect(spec.titleColumnRemoteId).toEqual(['title']);
    });

    it('throws for unknown table', async () => {
      await expect(connector.fetchJsonTableSpec({ wsId: 'unknown', remoteId: ['unknown'] })).rejects.toThrow(
        "Unknown table 'unknown'",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // pullRecordFiles
  // ---------------------------------------------------------------------------

  describe('pullRecordFiles', () => {
    it('pulls all articles via pagination', async () => {
      const page1 = [makeArticle({ id: '1' }), makeArticle({ id: '2' })];
      const page2 = [makeArticle({ id: '3' })];
      mockListArticles.mockReturnValue(asyncGen([page1, page2]));

      const collected: ConnectorFile[][] = [];
      const callback = jest.fn((params: { files: ConnectorFile[] }) => {
        collected.push(params.files);
        return Promise.resolve();
      });

      await connector.pullRecordFiles(buildTableSpec('articles'), callback, {}, { forceFull: false });

      expect(callback).toHaveBeenCalledTimes(2);
      expect(collected[0]).toHaveLength(2);
      expect(collected[1]).toHaveLength(1);
    });

    it('pulls all collections via pagination', async () => {
      const collections = [makeCollection({ id: '1' }), makeCollection({ id: '2' })];
      mockListCollections.mockReturnValue(asyncGen([collections]));

      const collected: ConnectorFile[][] = [];
      const callback = jest.fn((params: { files: ConnectorFile[] }) => {
        collected.push(params.files);
        return Promise.resolve();
      });

      await connector.pullRecordFiles(buildTableSpec('collections'), callback, {}, { forceFull: false });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(collected[0]).toHaveLength(2);
    });

    it('pulls conversations with hydration by default', async () => {
      const conversations = [makeConversation({ id: '1' }), makeConversation({ id: '2' })];
      mockListConversations.mockReturnValue(asyncGen([conversations]));

      const collected: ConnectorFile[][] = [];
      const callback = jest.fn((params: { files: ConnectorFile[] }) => {
        collected.push(params.files);
        return Promise.resolve();
      });

      await connector.pullRecordFiles(buildTableSpec('conversations'), callback, {}, { forceFull: false });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(collected[0]).toHaveLength(2);
      // Default: hydrate = true
      expect(mockListConversations).toHaveBeenCalledWith(20, true, undefined);
    });

    it('skips hydration when excludeConversationParts is set', async () => {
      const conversations = [makeConversation({ id: '1' })];
      mockListConversations.mockReturnValue(asyncGen([conversations]));

      const callback = jest.fn(() => Promise.resolve());

      await connector.pullRecordFiles(
        buildTableSpec('conversations'),
        callback,
        {},
        { forceFull: false, excludeConversationParts: true },
      );

      // hydrate = false when excludeConversationParts is true
      expect(mockListConversations).toHaveBeenCalledWith(20, false, undefined);
    });

    it('throws for unknown table type', async () => {
      const callback = jest.fn();
      await expect(
        connector.pullRecordFiles(buildTableSpec('unknown'), callback, {}, { forceFull: false }),
      ).rejects.toThrow("Unknown table 'unknown'");
    });
  });

  // ---------------------------------------------------------------------------
  // pullRecordFilesByIds
  // ---------------------------------------------------------------------------

  describe('pullRecordFilesByIds', () => {
    it('fetches articles by ID and buffers results', async () => {
      const article1 = makeArticle({ id: '1' });
      const article2 = makeArticle({ id: '2' });
      mockGetArticle.mockResolvedValueOnce(article1).mockResolvedValueOnce(article2);

      const collected: ConnectorFile[][] = [];
      const callback = jest.fn((params: { files: ConnectorFile[] }) => {
        collected.push(params.files);
        return Promise.resolve();
      });

      await connector.pullRecordFilesByIds(buildTableSpec('articles'), ['1', '2'], callback);

      expect(mockGetArticle).toHaveBeenCalledTimes(2);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(collected[0]).toHaveLength(2);
    });

    it('fetches collections by ID', async () => {
      const collection = makeCollection({ id: '5' });
      mockGetCollection.mockResolvedValue(collection);

      const collected: ConnectorFile[][] = [];
      const callback = jest.fn((params: { files: ConnectorFile[] }) => {
        collected.push(params.files);
        return Promise.resolve();
      });

      await connector.pullRecordFilesByIds(buildTableSpec('collections'), ['5'], callback);

      expect(mockGetCollection).toHaveBeenCalledWith('5');
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('fetches conversations by ID', async () => {
      const conversation = makeConversation({ id: '10' });
      mockGetConversation.mockResolvedValue(conversation);

      const collected: ConnectorFile[][] = [];
      const callback = jest.fn((params: { files: ConnectorFile[] }) => {
        collected.push(params.files);
        return Promise.resolve();
      });

      await connector.pullRecordFilesByIds(buildTableSpec('conversations'), ['10'], callback);

      expect(mockGetConversation).toHaveBeenCalledWith('10');
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('skips records that return null (404)', async () => {
      mockGetArticle.mockResolvedValueOnce(makeArticle({ id: '1' })).mockResolvedValueOnce(null);

      const collected: ConnectorFile[][] = [];
      const callback = jest.fn((params: { files: ConnectorFile[] }) => {
        collected.push(params.files);
        return Promise.resolve();
      });

      await connector.pullRecordFilesByIds(buildTableSpec('articles'), ['1', '999'], callback);

      expect(collected[0]).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // createRecords
  // ---------------------------------------------------------------------------

  describe('createRecords', () => {
    it('creates articles and returns full records', async () => {
      const created = makeArticle({ id: '42', title: 'New Article' });
      mockCreateArticle.mockResolvedValue(created);

      const files: ConnectorFile[] = [
        {
          title: 'New Article',
          author_id: 1,
          body: '<p>Content</p>',
          state: 'draft',
        },
      ];

      const results = await connector.createRecords(buildTableSpec('articles'), files);

      expect(results).toHaveLength(1);
      expect((results[0] as unknown as IntercomArticle).id).toBe('42');
      expect(mockCreateArticle).toHaveBeenCalledWith({
        title: 'New Article',
        author_id: 1,
        description: undefined,
        body: '<p>Content</p>',
        state: 'draft',
        parent_id: undefined,
        parent_type: undefined,
        translated_content: undefined,
      });
    });

    it('creates collections and returns full records', async () => {
      const created = makeCollection({ id: '10', name: 'New Collection' });
      mockCreateCollection.mockResolvedValue(created);

      const files: ConnectorFile[] = [
        {
          name: 'New Collection',
          description: 'A new collection',
        },
      ];

      const results = await connector.createRecords(buildTableSpec('collections'), files);

      expect(results).toHaveLength(1);
      expect((results[0] as unknown as IntercomCollection).id).toBe('10');
      expect(mockCreateCollection).toHaveBeenCalledWith({
        name: 'New Collection',
        description: 'A new collection',
        translated_content: undefined,
        icon: undefined,
        parent_id: undefined,
        help_center_id: undefined,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // updateRecords
  // ---------------------------------------------------------------------------

  describe('updateRecords', () => {
    it('updates articles by string ID', async () => {
      mockUpdateArticle.mockResolvedValue(makeArticle({ id: '42', title: 'Updated' }));

      const files: ConnectorFile[] = [
        {
          id: '42',
          title: 'Updated',
          body: '<p>Updated content</p>',
          author_id: 1,
          state: 'published',
        },
      ];

      await connector.updateRecords(buildTableSpec('articles'), files, files);

      expect(mockUpdateArticle).toHaveBeenCalledWith('42', {
        title: 'Updated',
        description: undefined,
        body: '<p>Updated content</p>',
        author_id: 1,
        state: 'published',
        parent_id: undefined,
        parent_type: undefined,
        translated_content: undefined,
      });
    });

    it('updates collections by string ID', async () => {
      mockUpdateCollection.mockResolvedValue(makeCollection({ id: '5', name: 'Updated FAQ' }));

      const files: ConnectorFile[] = [
        {
          id: '5',
          name: 'Updated FAQ',
          description: 'Updated description',
        },
      ];

      await connector.updateRecords(buildTableSpec('collections'), files, files);

      expect(mockUpdateCollection).toHaveBeenCalledWith('5', {
        name: 'Updated FAQ',
        description: 'Updated description',
        translated_content: undefined,
        icon: undefined,
        parent_id: undefined,
        help_center_id: undefined,
      });
    });

    // DEV-10125: when only one field is in changedFields, the PATCH body must
    // contain only that field — unchanged sibling fields must not be re-sent.
    it('sends only the changed article fields when changedFields is sparse', async () => {
      mockUpdateArticle.mockResolvedValue(makeArticle({ id: '42' }));

      const files: ConnectorFile[] = [
        {
          id: '42',
          title: 'Unchanged title',
          body: '<p>Old body</p>',
          author_id: 1,
          state: 'published',
        },
      ];
      // Only `body` changed.
      const changedFields: Record<string, unknown>[] = [{ body: '<p>New body</p>' }];

      await connector.updateRecords(buildTableSpec('articles'), files, changedFields);

      const [articleId, payload] = mockUpdateArticle.mock.calls[0] as [string, Record<string, unknown>];
      expect(articleId).toBe('42');
      expect(payload.body).toBe('<p>New body</p>');
      expect(payload.title).toBeUndefined();
      expect(payload.author_id).toBeUndefined();
      expect(payload.state).toBeUndefined();
      expect(payload.description).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // deleteRecords
  // ---------------------------------------------------------------------------

  describe('deleteRecords', () => {
    it('deletes articles by ID', async () => {
      mockDeleteArticle.mockResolvedValue(undefined);

      const files: ConnectorFile[] = [{ id: '1' }, { id: '2' }];
      await connector.deleteRecords(buildTableSpec('articles'), files);

      expect(mockDeleteArticle).toHaveBeenCalledTimes(2);
      expect(mockDeleteArticle).toHaveBeenCalledWith('1');
      expect(mockDeleteArticle).toHaveBeenCalledWith('2');
    });

    it('deletes collections by ID', async () => {
      mockDeleteCollection.mockResolvedValue(undefined);

      const files: ConnectorFile[] = [{ id: '5' }];
      await connector.deleteRecords(buildTableSpec('collections'), files);

      expect(mockDeleteCollection).toHaveBeenCalledWith('5');
    });

    it('skips records without an ID', async () => {
      const files: ConnectorFile[] = [{ id: '' }, { id: '3' }];
      mockDeleteArticle.mockResolvedValue(undefined);

      await connector.deleteRecords(buildTableSpec('articles'), files);

      // id='' is falsy, should be skipped
      expect(mockDeleteArticle).toHaveBeenCalledTimes(1);
      expect(mockDeleteArticle).toHaveBeenCalledWith('3');
    });
  });

  // ---------------------------------------------------------------------------
  // extractConnectorErrorDetails
  // ---------------------------------------------------------------------------

  describe('extractConnectorErrorDetails', () => {
    it('handles IntercomError', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
      const { IntercomError } = require('../intercom-api-client');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
      const error = new IntercomError('Rate limit exceeded', 429, { code: 'rate_limit' });

      const details = connector.extractConnectorErrorDetails(error);

      expect(details.userFriendlyMessage).toBe('Rate limit exceeded');
      expect(details.additionalContext?.status).toBe(429);
    });

    it('handles Axios errors', () => {
      const error = new AxiosError('Request failed', '500', undefined, undefined, {
        status: 500,
        statusText: 'Internal Server Error',
        data: { message: 'Something went wrong' },
        headers: {},
        config: {} as never,
      });

      const details = connector.extractConnectorErrorDetails(error);

      expect(details.userFriendlyMessage).toBeDefined();
      expect(details.additionalContext?.status).toBe(500);
    });

    it('handles unknown errors with fallback', () => {
      const error = new Error('Something unexpected');
      const details = connector.extractConnectorErrorDetails(error);
      expect(details.userFriendlyMessage).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // getSuggestedRecordFileNames
  // ---------------------------------------------------------------------------

  describe('getSuggestedRecordFileNames', () => {
    it('uses title for articles', () => {
      const records: ConnectorFile[] = [
        { id: '1', title: 'Getting Started' },
        { id: '2', title: 'Advanced Topics' },
      ];
      const tableSpec = buildTableSpec('articles');
      tableSpec.slugFieldPath = 'title';

      const names = connector.getSuggestedRecordFileNames(records, tableSpec);

      expect(names).toEqual(['Getting Started', 'Advanced Topics']);
    });

    it('uses source.subject for conversations', () => {
      const records: ConnectorFile[] = [
        { id: '1', source: { subject: 'Help with billing' } },
        { id: '2', source: { subject: 'Feature request' } },
      ];
      const tableSpec = buildTableSpec('conversations');
      tableSpec.slugFieldPath = 'source.subject';

      const names = connector.getSuggestedRecordFileNames(records, tableSpec);

      expect(names).toEqual(['Help with billing', 'Feature request']);
    });

    it('uses name for collections', () => {
      const records: ConnectorFile[] = [
        { id: '1', name: 'FAQ' },
        { id: '2', name: 'Guides' },
      ];
      const tableSpec = buildTableSpec('collections');
      tableSpec.slugFieldPath = 'name';

      const names = connector.getSuggestedRecordFileNames(records, tableSpec);

      expect(names).toEqual(['FAQ', 'Guides']);
    });
  });
});
