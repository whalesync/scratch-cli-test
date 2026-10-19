import { TSchema } from '@sinclair/typebox';
import { AxiosError } from 'axios';
import { Service } from '../../../service-constants';
import { BaseJsonTableSpec, ConnectorFile, dotPath } from '../../../types';
import type { IntercomConversationFullFetchFailure } from '../intercom-api-client';
import { buildPullWarningForConversationIntercomCouldNotReturnInFull, IntercomConnector } from '../intercom-connector';
import { buildIntercomUpdatedSinceQuery } from '../intercom-incremental';
import {
  IntercomArticle,
  IntercomCollection,
  IntercomContact,
  IntercomConversation,
  IntercomDataAttribute,
} from '../intercom-types';

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
const mockSearchConversationsUpdatedSince = jest.fn();
const mockGetConversation = jest.fn();
const mockListAllContactsInCreationOrder = jest.fn();
const mockGetContact = jest.fn();
const mockListDataAttributes = jest.fn();
const mockListAllCompaniesViaScroll = jest.fn();
const mockGetCompany = jest.fn();

jest.mock('../intercom-api-client', () => {
  return {
    INTERCOM_MAX_PAGE_SIZE: 250,
    INTERCOM_MAX_CONVERSATIONS_PAGE_SIZE: 150,
    INTERCOM_CONVERSATIONS_PAGE_SIZE_WHEN_FETCHING_EACH_CONVERSATION: 20,
    INTERCOM_MAX_CONTACTS_PAGE_SIZE: 150,
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
      searchConversationsUpdatedSince: mockSearchConversationsUpdatedSince,
      getConversation: mockGetConversation,
      listAllContactsInCreationOrder: mockListAllContactsInCreationOrder,
      getContact: mockGetContact,
      listDataAttributes: mockListDataAttributes,
      listAllCompaniesViaScroll: mockListAllCompaniesViaScroll,
      getCompany: mockGetCompany,
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
    idPath: dotPath('id'),
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

function makeContact(overrides: Partial<IntercomContact> = {}): IntercomContact {
  const emptyList = { type: 'list' as const, data: [], url: '/contacts/c1/x', total_count: 0, has_more: false };
  return {
    type: 'contact',
    id: 'c1',
    workspace_id: 'ws_123',
    external_id: null,
    role: 'user',
    email: 'ada@example.com',
    name: 'Ada',
    created_at: 1700000000,
    updated_at: 1700000100,
    custom_attributes: {},
    tags: emptyList,
    notes: emptyList,
    companies: emptyList,
    ...overrides,
  };
}

function makeDataAttribute(overrides: Partial<IntercomDataAttribute> = {}): IntercomDataAttribute {
  return {
    type: 'data_attribute',
    model: 'contact',
    name: 'plan_tier',
    full_name: 'custom_attributes.plan_tier',
    label: 'plan_tier',
    data_type: 'string',
    custom: true,
    archived: false,
    ...overrides,
  };
}

/**
 * Helper to create an async generator of `IntercomPageBatch`es (the faithful
 * page-walk shape yielded by `listArticles`/`listCollections`): `pages[i]` is
 * yielded with `resumeFromPage: i + 2` (page walks start at 1, so after
 * processing page N the primary walk resumes from N + 1).
 */
// eslint-disable-next-line @typescript-eslint/require-await
async function* pageBatchGen<T>(pages: T[][]): AsyncGenerator<{ records: T[]; resumeFromPage: number }, void> {
  for (const [pageIndex, page] of pages.entries()) {
    yield { records: page, resumeFromPage: pageIndex + 2 };
  }
}

/**
 * Helper to create an async generator of conversation pages with the
 * `{ items, nextCursor, conversationsIntercomCouldNotReturnInFull }` shape.
 * `cursors[i]` is the cursor that goes with `pages[i]`; default is `undefined`
 * for every page (single terminal page). `refusalsPerPage[i]` names the
 * conversations of `pages[i]` Intercom refused to hydrate (default none).
 */
// eslint-disable-next-line @typescript-eslint/require-await
async function* convoPagesGen<T>(
  pages: T[][],
  cursors: (string | undefined)[] = [],
  refusalsPerPage: IntercomConversationFullFetchFailure[][] = [],
): AsyncGenerator<
  {
    items: T[];
    nextCursor: string | undefined;
    conversationsIntercomCouldNotReturnInFull: IntercomConversationFullFetchFailure[];
  },
  void
> {
  for (let i = 0; i < pages.length; i++) {
    yield {
      items: pages[i],
      nextCursor: cursors[i],
      conversationsIntercomCouldNotReturnInFull: refusalsPerPage[i] ?? [],
    };
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
      expect(connector.getBatchSize()).toBe(10);
      expect(connector.getBatchSize()).toBe(10);
      expect(connector.getBatchSize()).toBe(10);
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
    it('returns articles, collections, conversations, contacts, and companies tables', async () => {
      const tables = await connector.listTables();
      expect(tables).toHaveLength(5);

      const ids = tables.map((t) => t.id.wsId);
      expect(ids).toContain('articles');
      expect(ids).toContain('collections');
      expect(ids).toContain('conversations');
      expect(ids).toContain('contacts');
      expect(ids).toContain('companies');
    });

    it('lists companies as a fully read-only table that explains which companies it holds', async () => {
      const tables = await connector.listTables();
      const companies = tables.find((t) => t.id.wsId === 'companies');

      expect(companies).toMatchObject({
        id: { wsId: 'companies', remoteId: ['companies'] },
        displayName: 'Companies',
        disabledCreates: true,
        disabledUpdates: true,
        disabledDeletes: true,
      });
      expect(companies?.disabledReason).toMatch(/read-only/);
      expect(companies?.infoNote).toMatch(/at least one user or lead/);
    });

    it('lists contacts as a fully read-only table with a reason and a size note', async () => {
      const tables = await connector.listTables();
      const contacts = tables.find((t) => t.id.wsId === 'contacts');

      expect(contacts).toMatchObject({
        id: { wsId: 'contacts', remoteId: ['contacts'] },
        displayName: 'Contacts',
        disabledCreates: true,
        disabledUpdates: true,
        disabledDeletes: true,
      });
      expect(contacts?.disabledReason).toMatch(/read-only/);
      expect(contacts?.infoNote).toMatch(/every user and lead/);
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
      expect(spec.idPath).toBe('id');
      expect(spec.titlePath).toEqual('title');
    });

    it('builds collections schema', async () => {
      const spec = await connector.fetchJsonTableSpec({ wsId: 'collections', remoteId: ['collections'] });

      expect(spec.name).toBe('Collections');
      expect(spec.idPath).toBe('id');
      expect(spec.titlePath).toEqual('name');
    });

    it('builds conversations schema', async () => {
      const spec = await connector.fetchJsonTableSpec({ wsId: 'conversations', remoteId: ['conversations'] });

      expect(spec.name).toBe('Conversations');
      expect(spec.idPath).toBe('id');
      expect(spec.titlePath).toEqual('title');
    });

    it('builds the contacts schema from the workspace’s own contact attribute definitions', async () => {
      mockListDataAttributes.mockResolvedValue([
        makeDataAttribute({ name: 'plan_tier', data_type: 'string' }),
        makeDataAttribute({ name: 'Trial Ends', data_type: 'date' }),
        makeDataAttribute({ name: 'email', custom: false }),
      ]);

      const spec = await connector.fetchJsonTableSpec({ wsId: 'contacts', remoteId: ['contacts'] });

      expect(mockListDataAttributes).toHaveBeenCalledWith('contact');
      expect(spec.name).toBe('Contacts');
      expect(spec.idPath).toBe('id');
      expect(spec.titlePath).toBe('email');
      const customAttributeProperties = (
        spec.schema as TSchema & { properties: { custom_attributes: { properties: Record<string, unknown> } } }
      ).properties.custom_attributes.properties;
      expect(Object.keys(customAttributeProperties)).toEqual(['plan_tier', 'Trial Ends']);
    });

    it('builds the companies schema from the workspace’s own company attribute definitions', async () => {
      mockListDataAttributes.mockResolvedValue([
        makeDataAttribute({ model: 'company', name: 'creation_source', data_type: 'string' }),
        makeDataAttribute({ model: 'company', name: 'renewal_date', data_type: 'date' }),
      ]);

      const spec = await connector.fetchJsonTableSpec({ wsId: 'companies', remoteId: ['companies'] });

      expect(mockListDataAttributes).toHaveBeenCalledWith('company');
      expect(spec.name).toBe('Companies');
      expect(spec.idPath).toBe('id');
      expect(spec.titlePath).toBe('name');
      const customAttributeProperties = (
        spec.schema as TSchema & { properties: { custom_attributes: { properties: Record<string, unknown> } } }
      ).properties.custom_attributes.properties;
      expect(Object.keys(customAttributeProperties)).toEqual(['creation_source', 'renewal_date']);
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
      mockListArticles.mockReturnValue(pageBatchGen([page1, page2]));

      const collected: ConnectorFile[][] = [];
      const progressCheckpoints: unknown[] = [];
      const callback = jest.fn((params: { files: ConnectorFile[]; connectorProgress?: unknown }) => {
        collected.push(params.files);
        progressCheckpoints.push(params.connectorProgress);
        return Promise.resolve();
      });

      await connector.pullRecordFiles(buildTableSpec('articles'), callback, {}, { forceFull: false });

      expect(callback).toHaveBeenCalledTimes(2);
      expect(collected[0]).toHaveLength(2);
      expect(collected[1]).toHaveLength(1);
      // The crash-resume checkpoint is the client's resumeFromPage, verbatim.
      expect(progressCheckpoints).toEqual([{ nextPage: 2 }, { nextPage: 3 }]);
    });

    it('resumes an articles pull from the persisted nextPage', async () => {
      mockListArticles.mockReturnValue(pageBatchGen([[makeArticle({ id: '9' })]]));

      await connector.pullRecordFiles(
        buildTableSpec('articles'),
        jest.fn(() => Promise.resolve()),
        { nextPage: 4 },
        { forceFull: false },
      );

      expect(mockListArticles).toHaveBeenCalledWith(250, 4);
    });

    it('pulls all collections via pagination', async () => {
      const collections = [makeCollection({ id: '1' }), makeCollection({ id: '2' })];
      mockListCollections.mockReturnValue(pageBatchGen([collections]));

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
      mockListConversations.mockReturnValue(convoPagesGen([conversations]));

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

    it('reports a conversation Intercom refused to hydrate as a record warning on its own page', async () => {
      const hydratedConversation = makeConversation({ id: '1' });
      const conversationKeptAsListed = makeConversation({ id: '2' });
      mockListConversations.mockReturnValue(
        convoPagesGen(
          [[hydratedConversation, conversationKeptAsListed], [makeConversation({ id: '3' })]],
          ['cur_2', undefined],
          [
            [
              {
                conversationId: '2',
                httpStatus: 403,
                intercomErrorMessage: 'Access to this conversation is restricted',
              },
            ],
            [],
          ],
        ),
      );

      const callback = jest.fn(() => Promise.resolve());
      await connector.pullRecordFiles(buildTableSpec('conversations'), callback, {}, { forceFull: false });

      expect(callback).toHaveBeenNthCalledWith(1, {
        files: [hydratedConversation, conversationKeptAsListed],
        connectorProgress: { startingAfter: 'cur_2' },
        recordWarnings: [
          buildPullWarningForConversationIntercomCouldNotReturnInFull({
            conversationId: '2',
            httpStatus: 403,
            intercomErrorMessage: 'Access to this conversation is restricted',
          }),
        ],
      });
      expect(callback).toHaveBeenNthCalledWith(2, {
        files: [makeConversation({ id: '3' })],
        connectorProgress: {},
        recordWarnings: [],
      });
    });

    it('skips hydration when excludeConversationParts is set', async () => {
      const conversations = [makeConversation({ id: '1' })];
      mockListConversations.mockReturnValue(convoPagesGen([conversations]));

      const callback = jest.fn(() => Promise.resolve());

      await connector.pullRecordFiles(
        buildTableSpec('conversations'),
        callback,
        {},
        { forceFull: false, excludeConversationParts: true },
      );

      // hydrate = false when excludeConversationParts is true, and the list runs at Intercom's 150 max
      expect(mockListConversations).toHaveBeenCalledWith(150, false, undefined);
    });

    it('resumes an unhydrated conversations pull from the persisted cursor at the 150 max page size', async () => {
      mockListConversations.mockReturnValue(convoPagesGen([[makeConversation({ id: '1' })]]));

      await connector.pullRecordFiles(
        buildTableSpec('conversations'),
        jest.fn(() => Promise.resolve()),
        { startingAfter: 'cur_7' },
        { forceFull: false, excludeConversationParts: true },
      );

      expect(mockListConversations).toHaveBeenCalledWith(150, false, 'cur_7');
    });

    it('pulls contacts at the 150 max, checkpointing Intercom’s cursor and clearing it on the last page', async () => {
      mockListAllContactsInCreationOrder.mockReturnValue(
        convoPagesGen(
          [[makeContact({ id: 'c1' }), makeContact({ id: 'c2' })], [makeContact({ id: 'c3' })]],
          ['cur_a', undefined],
        ),
      );
      const callback = jest.fn(() => Promise.resolve());

      const result = await connector.pullRecordFiles(buildTableSpec('contacts'), callback, {}, { forceFull: false });

      expect(mockListAllContactsInCreationOrder).toHaveBeenCalledWith(150, undefined);
      expect(callback).toHaveBeenNthCalledWith(1, {
        files: [expect.objectContaining({ id: 'c1' }), expect.objectContaining({ id: 'c2' })],
        connectorProgress: { startingAfter: 'cur_a' },
      });
      expect(callback).toHaveBeenNthCalledWith(2, {
        files: [expect.objectContaining({ id: 'c3' })],
        connectorProgress: {},
      });
      expect(result).toEqual({});
    });

    it('resumes a contacts pull from the persisted cursor', async () => {
      mockListAllContactsInCreationOrder.mockReturnValue(convoPagesGen([[makeContact()]]));

      await connector.pullRecordFiles(
        buildTableSpec('contacts'),
        jest.fn(() => Promise.resolve()),
        { startingAfter: 'cur_9' },
        { forceFull: false },
      );

      expect(mockListAllContactsInCreationOrder).toHaveBeenCalledWith(150, 'cur_9');
    });

    it('serves a stray incremental contacts request with the full walk and no watermark', async () => {
      mockListAllContactsInCreationOrder.mockReturnValue(convoPagesGen([[makeContact()]]));

      const result = await connector.pullRecordFiles(
        buildTableSpec('contacts'),
        jest.fn(() => Promise.resolve()),
        {},
        { forceFull: false, pullMode: 'incremental', since: new Date('2026-01-01T00:00:00Z') },
      );

      expect(mockListAllContactsInCreationOrder).toHaveBeenCalledWith(150, undefined);
      expect(mockSearchConversationsUpdatedSince).not.toHaveBeenCalled();
      expect(result).toEqual({});
    });

    it('propagates a contacts walk failure so the job never runs delete-detection', async () => {
      // eslint-disable-next-line require-yield
      mockListAllContactsInCreationOrder.mockImplementation(async function* () {
        await Promise.resolve();
        throw new Error('Intercom returned 9 of the 10 contacts it reports.');
      });

      await expect(
        connector.pullRecordFiles(buildTableSpec('contacts'), jest.fn(), {}, { forceFull: false }),
      ).rejects.toThrow('Intercom returned 9 of the 10 contacts it reports.');
    });

    it('pulls companies from the scroll walk, never checkpointing a cursor (a scroll cannot resume)', async () => {
      // eslint-disable-next-line @typescript-eslint/require-await
      mockListAllCompaniesViaScroll.mockImplementation(async function* () {
        yield {
          items: [
            { type: 'company', id: 'co1' },
            { type: 'company', id: 'co2' },
          ],
        };
        yield { items: [{ type: 'company', id: 'co3' }] };
      });
      const callback = jest.fn(() => Promise.resolve());

      const result = await connector.pullRecordFiles(
        buildTableSpec('companies'),
        callback,
        { startingAfter: 'ignored' },
        { forceFull: false, pullMode: 'incremental', since: new Date('2026-01-01T00:00:00Z') },
      );

      expect(mockListAllCompaniesViaScroll).toHaveBeenCalledWith();
      expect(callback).toHaveBeenNthCalledWith(1, {
        files: [expect.objectContaining({ id: 'co1' }), expect.objectContaining({ id: 'co2' })],
        connectorProgress: {},
      });
      expect(callback).toHaveBeenNthCalledWith(2, {
        files: [expect.objectContaining({ id: 'co3' })],
        connectorProgress: {},
      });
      expect(result).toEqual({});
    });

    it('propagates a companies walk failure so the job never runs delete-detection', async () => {
      // eslint-disable-next-line require-yield
      mockListAllCompaniesViaScroll.mockImplementation(async function* () {
        await Promise.resolve();
        throw new Error('Another integration is reading companies from this Intercom workspace');
      });

      await expect(
        connector.pullRecordFiles(buildTableSpec('companies'), jest.fn(), {}, { forceFull: false }),
      ).rejects.toThrow('Another integration is reading companies');
    });

    it('throws for unknown table type', async () => {
      const callback = jest.fn();
      await expect(
        connector.pullRecordFiles(buildTableSpec('unknown'), callback, {}, { forceFull: false }),
      ).rejects.toThrow("Unknown table 'unknown'");
    });
  });

  // ---------------------------------------------------------------------------
  // supportsIncrementalPull
  // ---------------------------------------------------------------------------

  describe('supportsIncrementalPull', () => {
    it('is true only for the conversations table', () => {
      expect(connector.supportsIncrementalPull({}, buildTableSpec('conversations'))).toBe(true);
    });

    it('is false for articles and collections (no server-side updated_at filter)', () => {
      expect(connector.supportsIncrementalPull({}, buildTableSpec('articles'))).toBe(false);
      expect(connector.supportsIncrementalPull({}, buildTableSpec('collections'))).toBe(false);
    });

    it('is false for contacts and companies (full pull only, by design — DEV-12350)', () => {
      expect(connector.supportsIncrementalPull({}, buildTableSpec('contacts'))).toBe(false);
      expect(connector.supportsIncrementalPull({}, buildTableSpec('companies'))).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // pullRecordFiles (incremental)
  // ---------------------------------------------------------------------------

  describe('pullRecordFiles (incremental)', () => {
    it('searches conversations updated since `since` and returns a newWatermark', async () => {
      const conversations = [makeConversation({ id: '1' }), makeConversation({ id: '2' })];
      mockSearchConversationsUpdatedSince.mockReturnValue(convoPagesGen([conversations]));
      const since = new Date('2026-05-01T12:00:00.000Z');

      const callback = jest.fn(() => Promise.resolve());
      const before = Date.now();
      const result = await connector.pullRecordFiles(
        buildTableSpec('conversations'),
        callback,
        {},
        {
          pullMode: 'incremental',
          since,
        },
      );
      const after = Date.now();

      expect(mockSearchConversationsUpdatedSince).toHaveBeenCalledWith(
        buildIntercomUpdatedSinceQuery(since),
        20,
        true,
        undefined,
      );
      expect(mockListConversations).not.toHaveBeenCalled();
      expect(result.newWatermark).toBeInstanceOf(Date);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(result.newWatermark!.getTime()).toBeGreaterThanOrEqual(before);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(result.newWatermark!.getTime()).toBeLessThanOrEqual(after);
    });

    it('passes hydrate=false to search when excludeConversationParts is set', async () => {
      mockSearchConversationsUpdatedSince.mockReturnValue(convoPagesGen([[makeConversation({ id: '1' })]]));
      const since = new Date('2026-05-01T12:00:00.000Z');

      await connector.pullRecordFiles(
        buildTableSpec('conversations'),
        jest.fn(() => Promise.resolve()),
        {},
        {
          pullMode: 'incremental',
          since,
          excludeConversationParts: true,
        },
      );

      expect(mockSearchConversationsUpdatedSince).toHaveBeenCalledWith(
        buildIntercomUpdatedSinceQuery(since),
        150,
        false,
        undefined,
      );
    });

    it('forwards a resume cursor from progress.startingAfter to the search', async () => {
      mockSearchConversationsUpdatedSince.mockReturnValue(convoPagesGen([[makeConversation({ id: '1' })]]));
      const since = new Date('2026-05-01T12:00:00.000Z');

      await connector.pullRecordFiles(
        buildTableSpec('conversations'),
        jest.fn(() => Promise.resolve()),
        { startingAfter: 'cur_9' },
        { pullMode: 'incremental', since },
      );

      expect(mockSearchConversationsUpdatedSince).toHaveBeenCalledWith(
        buildIntercomUpdatedSinceQuery(since),
        20,
        true,
        'cur_9',
      );
    });

    it('falls back to a full list (and returns {}) when incremental but `since` is missing', async () => {
      mockListConversations.mockReturnValue(convoPagesGen([[makeConversation({ id: '1' })]]));

      const result = await connector.pullRecordFiles(
        buildTableSpec('conversations'),
        jest.fn(() => Promise.resolve()),
        {},
        {
          pullMode: 'incremental',
        },
      );

      expect(result).toEqual({});
      expect(mockSearchConversationsUpdatedSince).not.toHaveBeenCalled();
      expect(mockListConversations).toHaveBeenCalledWith(20, true, undefined);
    });

    it('never searches for articles even if incremental options leak through (returns {})', async () => {
      mockListArticles.mockReturnValue(pageBatchGen([[makeArticle({ id: '1' })]]));

      const result = await connector.pullRecordFiles(
        buildTableSpec('articles'),
        jest.fn(() => Promise.resolve()),
        {},
        {
          pullMode: 'incremental',
          since: new Date('2026-05-01T12:00:00.000Z'),
        },
      );

      expect(result).toEqual({});
      expect(mockSearchConversationsUpdatedSince).not.toHaveBeenCalled();
      expect(mockListArticles).toHaveBeenCalled();
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

    it('fetches contacts by ID', async () => {
      mockGetContact.mockResolvedValue(makeContact({ id: 'c7' }));
      const callback = jest.fn(() => Promise.resolve());

      await connector.pullRecordFilesByIds(buildTableSpec('contacts'), ['c7'], callback);

      expect(mockGetContact).toHaveBeenCalledWith('c7');
      expect(callback).toHaveBeenCalledWith({ files: [expect.objectContaining({ id: 'c7' })] });
    });

    it('fetches companies by ID', async () => {
      mockGetCompany.mockResolvedValue({ type: 'company', id: 'co9' });
      const callback = jest.fn(() => Promise.resolve());

      await connector.pullRecordFilesByIds(buildTableSpec('companies'), ['co9'], callback);

      expect(mockGetCompany).toHaveBeenCalledWith('co9');
      expect(callback).toHaveBeenCalledWith({ files: [expect.objectContaining({ id: 'co9' })] });
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

    // DEV-11285: `parent_id` is a declared foreign key, so a sync writing INTO Intercom hands us
    // whatever the link resolved to — and a resolved record id arrives as a string.
    it('sends an article parent_id as the integer the write API documents', async () => {
      mockCreateArticle.mockResolvedValue(makeArticle({ id: '42' }));

      await connector.createRecords(buildTableSpec('articles'), [
        { title: 'Linked', author_id: 1, parent_id: '19716322' },
      ]);

      expect(mockCreateArticle).toHaveBeenCalledWith(expect.objectContaining({ parent_id: 19716322 }));
    });

    it('passes a non-numeric parent_id through so the service rejects it rather than dropping the link', async () => {
      mockCreateArticle.mockResolvedValue(makeArticle({ id: '42' }));

      await connector.createRecords(buildTableSpec('articles'), [
        { title: 'Dangling', author_id: 1, parent_id: '@/Intercom/Collections/x.json' },
      ]);

      expect(mockCreateArticle).toHaveBeenCalledWith(
        expect.objectContaining({ parent_id: '@/Intercom/Collections/x.json' }),
      );
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

  describe('buildPullWarningForConversationIntercomCouldNotReturnInFull', () => {
    it("names the conversation, what was left out, and Intercom's own reason", () => {
      expect(
        buildPullWarningForConversationIntercomCouldNotReturnInFull({
          conversationId: '215475561785523',
          httpStatus: 403,
          intercomErrorMessage: 'Access to this conversation is restricted',
        }),
      ).toEqual({
        remoteId: '215475561785523',
        warning:
          'Pulled conversation 215475561785523 without its conversation parts (message history): Intercom returned ' +
          '403 Forbidden for the full conversation ("Access to this conversation is restricted"). This usually ' +
          "means the Intercom teammate behind this connection's access token isn't allowed to see this conversation.",
      });
    });

    it('leaves out the reason when Intercom sent none', () => {
      const { warning } = buildPullWarningForConversationIntercomCouldNotReturnInFull({
        conversationId: '42',
        httpStatus: 403,
        intercomErrorMessage: null,
      });

      expect(warning).toContain('returned 403 Forbidden for the full conversation. This usually means');
    });

    it('names the status of a 5xx that outlasted the retries, without the access hint', () => {
      expect(
        buildPullWarningForConversationIntercomCouldNotReturnInFull({
          conversationId: '7',
          httpStatus: 500,
          intercomErrorMessage: 'Server Error',
        }),
      ).toEqual({
        remoteId: '7',
        warning:
          'Pulled conversation 7 without its conversation parts (message history): Intercom kept failing with ' +
          'HTTP 500 for the full conversation ("Server Error"), even after retries.',
      });
    });
  });

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

  describe('contacts and companies writes', () => {
    it.each(['contacts', 'companies'])(
      'rejects %s creates, updates and deletes instead of skipping them',
      async (table) => {
        const tableSpec = buildTableSpec(table);
        const file = { id: 'x1', name: 'Name' } as ConnectorFile;

        await expect(connector.createRecords(tableSpec, [file])).rejects.toThrow(/read-only/);
        await expect(connector.updateRecords(tableSpec, [file], [{ name: 'New' }])).rejects.toThrow(/read-only/);
        await expect(connector.deleteRecords(tableSpec, [file])).rejects.toThrow(/read-only/);
      },
    );
  });

  describe('advancedSettings', () => {
    it('scopes the conversation-replies setting to the conversations table', () => {
      const excludeConversationParts = IntercomConnector.advancedSettings.find(
        (setting) => setting.key === 'excludeConversationParts',
      );
      expect(excludeConversationParts?.forTableWsIds).toEqual(['conversations']);
    });
  });

  describe('getSuggestedRecordFileNames', () => {
    it('uses name for companies, falling back to company_id', () => {
      const records: ConnectorFile[] = [
        { id: '1', name: 'Acme', company_id: 'acme-1' },
        { id: '2', name: null, company_id: 'globex-2' },
      ];
      const tableSpec = buildTableSpec('companies');
      tableSpec.slugPath = dotPath('name');

      expect(connector.getSuggestedRecordFileNames(records, tableSpec)).toEqual(['Acme', 'globex-2']);
    });

    it('uses email for contacts, falling back to name', () => {
      const records: ConnectorFile[] = [
        { id: '1', email: 'ada@example.com', name: 'Ada' },
        { id: '2', email: null, name: 'Grace' },
        { id: '3', email: null, name: null },
      ];
      const tableSpec = buildTableSpec('contacts');
      tableSpec.slugPath = dotPath('email');

      const names = connector.getSuggestedRecordFileNames(records, tableSpec);

      expect(names).toEqual(['ada@example.com', 'Grace', undefined]);
    });

    it('uses title for articles', () => {
      const records: ConnectorFile[] = [
        { id: '1', title: 'Getting Started' },
        { id: '2', title: 'Advanced Topics' },
      ];
      const tableSpec = buildTableSpec('articles');
      tableSpec.slugPath = dotPath('title');

      const names = connector.getSuggestedRecordFileNames(records, tableSpec);

      expect(names).toEqual(['Getting Started', 'Advanced Topics']);
    });

    it('uses source.subject for conversations', () => {
      const records: ConnectorFile[] = [
        { id: '1', source: { subject: 'Help with billing' } },
        { id: '2', source: { subject: 'Feature request' } },
      ];
      const tableSpec = buildTableSpec('conversations');
      tableSpec.slugPath = dotPath('source.subject');

      const names = connector.getSuggestedRecordFileNames(records, tableSpec);

      expect(names).toEqual(['Help with billing', 'Feature request']);
    });

    it('uses name for collections', () => {
      const records: ConnectorFile[] = [
        { id: '1', name: 'FAQ' },
        { id: '2', name: 'Guides' },
      ];
      const tableSpec = buildTableSpec('collections');
      tableSpec.slugPath = dotPath('name');

      const names = connector.getSuggestedRecordFileNames(records, tableSpec);

      expect(names).toEqual(['FAQ', 'Guides']);
    });
  });
});
