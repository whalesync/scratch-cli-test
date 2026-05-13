import { TSchema } from '@sinclair/typebox';
import { AxiosError } from 'axios';
import { Service } from '../../../service-constants';
import { BaseJsonTableSpec, ConnectorFile } from '../../../types';
import { BrevoConnector } from '../brevo-connector';
import { BrevoContact, BrevoContactAttribute, BrevoTemplate } from '../brevo-types';

// Mock display-names to break circular import chain
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Brevo'),
}));

// Mock the API client
const mockValidateCredentials = jest.fn();
const mockListContacts = jest.fn();
const mockGetContact = jest.fn();
const mockCreateContact = jest.fn();
const mockUpdateContact = jest.fn();
const mockDeleteContact = jest.fn();
const mockGetContactAttributes = jest.fn();
const mockListTemplates = jest.fn();
const mockGetTemplate = jest.fn();
const mockCreateTemplate = jest.fn();
const mockUpdateTemplate = jest.fn();
const mockDeleteTemplate = jest.fn();
const mockListMailingLists = jest.fn();
const mockGetMailingList = jest.fn();

jest.mock('../brevo-api-client', () => {
  return {
    BrevoApiClient: jest.fn().mockImplementation(() => ({
      validateCredentials: mockValidateCredentials,
      listContacts: mockListContacts,
      getContact: mockGetContact,
      createContact: mockCreateContact,
      updateContact: mockUpdateContact,
      deleteContact: mockDeleteContact,
      getContactAttributes: mockGetContactAttributes,
      listTemplates: mockListTemplates,
      getTemplate: mockGetTemplate,
      createTemplate: mockCreateTemplate,
      updateTemplate: mockUpdateTemplate,
      deleteTemplate: mockDeleteTemplate,
      listMailingLists: mockListMailingLists,
      getMailingList: mockGetMailingList,
    })),
    BrevoError: class BrevoError extends Error {
      statusCode?: number;
      responseData?: unknown;
      constructor(message: string, statusCode?: number, responseData?: unknown) {
        super(message);
        this.name = 'BrevoError';
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

function makeContact(overrides: Partial<BrevoContact> = {}): BrevoContact {
  return {
    email: 'test@example.com',
    id: 1,
    emailBlacklisted: false,
    smsBlacklisted: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    modifiedAt: '2024-01-01T00:00:00.000Z',
    listIds: [],
    listUnsubscribed: [],
    attributes: {},
    ...overrides,
  };
}

function makeTemplate(overrides: Partial<BrevoTemplate> = {}): BrevoTemplate {
  return {
    id: 1,
    name: 'Welcome Email',
    subject: 'Welcome!',
    htmlContent: '<h1>Hello</h1>',
    isActive: true,
    testSent: false,
    sender: { name: 'Test', email: 'sender@example.com', id: '1' },
    replyTo: 'reply@example.com',
    toField: '',
    tag: 'welcome',
    createdAt: '2024-01-01T00:00:00.000Z',
    modifiedAt: '2024-01-01T00:00:00.000Z',
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

describe('BrevoConnector', () => {
  let connector: BrevoConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new BrevoConnector('test-api-key');
    mockGetContactAttributes.mockResolvedValue([]);
  });

  // ---------------------------------------------------------------------------
  // Basic properties
  // ---------------------------------------------------------------------------

  describe('service', () => {
    it('returns BREVO service', () => {
      expect(connector.service).toBe(Service.BREVO);
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
      mockValidateCredentials.mockRejectedValue(new Error('Invalid API key'));
      await expect(connector.testConnection()).rejects.toThrow('Invalid API key');
    });
  });

  // ---------------------------------------------------------------------------
  // listTables
  // ---------------------------------------------------------------------------

  describe('listTables', () => {
    it('returns contacts, templates, and mailing lists tables', async () => {
      const tables = await connector.listTables();
      expect(tables).toHaveLength(3);

      const ids = tables.map((t) => t.id.wsId);
      expect(ids).toContain('contacts');
      expect(ids).toContain('templates');
      expect(ids).toContain('mailing_lists');
    });

    it('includes display names', async () => {
      const tables = await connector.listTables();
      const contacts = tables.find((t) => t.id.wsId === 'contacts');
      const templates = tables.find((t) => t.id.wsId === 'templates');
      expect(contacts?.displayName).toBe('Contacts');
      expect(templates?.displayName).toBe('Email Templates');
    });
  });

  // ---------------------------------------------------------------------------
  // fetchJsonTableSpec
  // ---------------------------------------------------------------------------

  describe('fetchJsonTableSpec', () => {
    it('fetches attributes and builds contacts schema', async () => {
      const attrs: BrevoContactAttribute[] = [
        { name: 'FIRSTNAME', category: 'normal', type: 'text' },
        { name: 'LASTNAME', category: 'normal', type: 'text' },
      ];
      mockGetContactAttributes.mockResolvedValue(attrs);

      const spec = await connector.fetchJsonTableSpec({ wsId: 'contacts', remoteId: ['contacts'] });

      expect(spec.name).toBe('Contacts');
      expect(spec.idColumnRemoteId).toBe('id');
      expect(spec.titleColumnRemoteId).toEqual(['email']);
      expect(mockGetContactAttributes).toHaveBeenCalledTimes(1);
    });

    it('builds templates schema without API call', async () => {
      const spec = await connector.fetchJsonTableSpec({ wsId: 'templates', remoteId: ['templates'] });

      expect(spec.name).toBe('Email Templates');
      expect(spec.idColumnRemoteId).toBe('id');
      expect(spec.titleColumnRemoteId).toEqual(['name']);
      expect(mockGetContactAttributes).not.toHaveBeenCalled();
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
    it('pulls all contacts via pagination', async () => {
      const page1 = [makeContact({ id: 1 }), makeContact({ id: 2 })];
      const page2 = [makeContact({ id: 3 })];
      mockListContacts.mockReturnValue(asyncGen([page1, page2]));

      const collected: ConnectorFile[][] = [];
      const callback = jest.fn((params: { files: ConnectorFile[] }) => {
        collected.push(params.files);
        return Promise.resolve();
      });

      await connector.pullRecordFiles(buildTableSpec('contacts'), callback, {}, { forceFull: false });

      expect(callback).toHaveBeenCalledTimes(2);
      expect(collected[0]).toHaveLength(2);
      expect(collected[1]).toHaveLength(1);
    });

    it('pulls templates with individual fetches for htmlContent', async () => {
      const templateSummary = makeTemplate({ id: 10, htmlContent: '' });
      mockListTemplates.mockReturnValue(asyncGen([[templateSummary]]));

      const fullTemplate = makeTemplate({ id: 10, htmlContent: '<h1>Full Content</h1>' });
      mockGetTemplate.mockResolvedValue(fullTemplate);

      const collected: ConnectorFile[][] = [];
      const callback = jest.fn((params: { files: ConnectorFile[] }) => {
        collected.push(params.files);
        return Promise.resolve();
      });

      await connector.pullRecordFiles(buildTableSpec('templates'), callback, {}, { forceFull: false });

      expect(mockGetTemplate).toHaveBeenCalledWith(10);
      expect(callback).toHaveBeenCalledTimes(1);
      expect((collected[0][0] as unknown as BrevoTemplate).htmlContent).toBe('<h1>Full Content</h1>');
    });

    it('skips templates that return null from getTemplate', async () => {
      const templateSummary = makeTemplate({ id: 99 });
      mockListTemplates.mockReturnValue(asyncGen([[templateSummary]]));
      mockGetTemplate.mockResolvedValue(null);

      const callback = jest.fn();
      await connector.pullRecordFiles(buildTableSpec('templates'), callback, {}, { forceFull: false });

      // No files to emit since getTemplate returned null
      expect(callback).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // pullRecordFilesByIds
  // ---------------------------------------------------------------------------

  describe('pullRecordFilesByIds', () => {
    it('fetches contacts by ID and buffers results', async () => {
      const contact1 = makeContact({ id: 1 });
      const contact2 = makeContact({ id: 2 });
      mockGetContact.mockResolvedValueOnce(contact1).mockResolvedValueOnce(contact2);

      const collected: ConnectorFile[][] = [];
      const callback = jest.fn((params: { files: ConnectorFile[] }) => {
        collected.push(params.files);
        return Promise.resolve();
      });

      await connector.pullRecordFilesByIds(buildTableSpec('contacts'), ['1', '2'], callback);

      expect(mockGetContact).toHaveBeenCalledTimes(2);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(collected[0]).toHaveLength(2);
    });

    it('fetches templates by numeric ID', async () => {
      const template = makeTemplate({ id: 5 });
      mockGetTemplate.mockResolvedValue(template);

      const collected: ConnectorFile[][] = [];
      const callback = jest.fn((params: { files: ConnectorFile[] }) => {
        collected.push(params.files);
        return Promise.resolve();
      });

      await connector.pullRecordFilesByIds(buildTableSpec('templates'), ['5'], callback);

      expect(mockGetTemplate).toHaveBeenCalledWith(5);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('skips records that return null (404)', async () => {
      mockGetContact.mockResolvedValueOnce(makeContact({ id: 1 })).mockResolvedValueOnce(null);

      const collected: ConnectorFile[][] = [];
      const callback = jest.fn((params: { files: ConnectorFile[] }) => {
        collected.push(params.files);
        return Promise.resolve();
      });

      await connector.pullRecordFilesByIds(buildTableSpec('contacts'), ['1', '999'], callback);

      expect(collected[0]).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // createRecords
  // ---------------------------------------------------------------------------

  describe('createRecords', () => {
    it('creates contacts and returns full records', async () => {
      const created = makeContact({ id: 42, email: 'new@example.com' });
      mockCreateContact.mockResolvedValue(created);

      const files: ConnectorFile[] = [
        {
          email: 'new@example.com',
          attributes: { FIRSTNAME: 'Jane' },
          emailBlacklisted: false,
          smsBlacklisted: false,
        },
      ];

      const results = await connector.createRecords(buildTableSpec('contacts'), files);

      expect(results).toHaveLength(1);
      expect((results[0] as unknown as BrevoContact).id).toBe(42);
      expect(mockCreateContact).toHaveBeenCalledWith({
        email: 'new@example.com',
        attributes: { FIRSTNAME: 'Jane' },
        emailBlacklisted: false,
        smsBlacklisted: false,
        listIds: undefined,
      });
    });

    it('creates templates with templateName mapping', async () => {
      const created = makeTemplate({ id: 10, name: 'Newsletter' });
      mockCreateTemplate.mockResolvedValue(created);

      const files: ConnectorFile[] = [
        {
          name: 'Newsletter',
          subject: 'Weekly Update',
          sender: { email: 'news@example.com' },
          htmlContent: '<p>Hello</p>',
        },
      ];

      const results = await connector.createRecords(buildTableSpec('templates'), files);

      expect(results).toHaveLength(1);
      expect(mockCreateTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          templateName: 'Newsletter',
          subject: 'Weekly Update',
          htmlContent: '<p>Hello</p>',
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // updateRecords
  // ---------------------------------------------------------------------------

  describe('updateRecords', () => {
    it('updates contacts by numeric ID', async () => {
      mockUpdateContact.mockResolvedValue(undefined);

      const files: ConnectorFile[] = [
        {
          id: 42,
          email: 'updated@example.com',
          attributes: { FIRSTNAME: 'Updated' },
          emailBlacklisted: false,
          smsBlacklisted: false,
          listIds: [1, 2],
        },
      ];

      await connector.updateRecords(buildTableSpec('contacts'), files, files);

      expect(mockUpdateContact).toHaveBeenCalledWith(42, {
        attributes: { FIRSTNAME: 'Updated' },
        emailBlacklisted: false,
        smsBlacklisted: false,
        listIds: [1, 2],
      });
    });

    it('updates templates with templateName mapping', async () => {
      mockUpdateTemplate.mockResolvedValue(undefined);

      const files: ConnectorFile[] = [
        {
          id: 10,
          name: 'Updated Template',
          subject: 'New Subject',
          htmlContent: '<p>Updated</p>',
        },
      ];

      await connector.updateRecords(buildTableSpec('templates'), files, files);

      expect(mockUpdateTemplate).toHaveBeenCalledWith(
        10,
        expect.objectContaining({
          templateName: 'Updated Template',
          subject: 'New Subject',
          htmlContent: '<p>Updated</p>',
        }),
      );
    });

    // DEV-10125: when only one field is in changedFields, the PATCH body must
    // contain only that field — unchanged sibling fields must not be re-sent.
    it('sends only the changed contact fields when changedFields is sparse', async () => {
      mockUpdateContact.mockResolvedValue(undefined);

      const files: ConnectorFile[] = [
        {
          id: 42,
          email: 'unchanged@example.com',
          attributes: { FIRSTNAME: 'Old', LASTNAME: 'Smith' },
          emailBlacklisted: false,
          smsBlacklisted: false,
          listIds: [1, 2],
        },
      ];
      // Only `attributes` changed; emailBlacklisted/smsBlacklisted/listIds were untouched.
      const changedFields: Record<string, unknown>[] = [{ attributes: { FIRSTNAME: 'New' } }];

      await connector.updateRecords(buildTableSpec('contacts'), files, changedFields);

      const [contactId, payload] = mockUpdateContact.mock.calls[0] as [number, Record<string, unknown>];
      expect(contactId).toBe(42);
      expect(payload.attributes).toEqual({ FIRSTNAME: 'New' });
      expect(payload.emailBlacklisted).toBeUndefined();
      expect(payload.smsBlacklisted).toBeUndefined();
      expect(payload.listIds).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // deleteRecords
  // ---------------------------------------------------------------------------

  describe('deleteRecords', () => {
    it('deletes contacts by ID', async () => {
      mockDeleteContact.mockResolvedValue(undefined);

      const files: ConnectorFile[] = [{ id: 1 }, { id: 2 }];
      await connector.deleteRecords(buildTableSpec('contacts'), files);

      expect(mockDeleteContact).toHaveBeenCalledTimes(2);
      expect(mockDeleteContact).toHaveBeenCalledWith(1);
      expect(mockDeleteContact).toHaveBeenCalledWith(2);
    });

    it('deletes templates by ID', async () => {
      mockDeleteTemplate.mockResolvedValue(undefined);

      const files: ConnectorFile[] = [{ id: 5 }];
      await connector.deleteRecords(buildTableSpec('templates'), files);

      expect(mockDeleteTemplate).toHaveBeenCalledWith(5);
    });

    it('skips records without an ID', async () => {
      const files: ConnectorFile[] = [{ id: 0 }, { id: 3 }];
      mockDeleteContact.mockResolvedValue(undefined);

      await connector.deleteRecords(buildTableSpec('contacts'), files);

      // id=0 is falsy, should be skipped
      expect(mockDeleteContact).toHaveBeenCalledTimes(1);
      expect(mockDeleteContact).toHaveBeenCalledWith(3);
    });
  });

  // ---------------------------------------------------------------------------
  // extractConnectorErrorDetails
  // ---------------------------------------------------------------------------

  describe('extractConnectorErrorDetails', () => {
    it('handles BrevoError', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
      const { BrevoError } = require('../brevo-api-client');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
      const error = new BrevoError('Rate limit exceeded', 429, { code: 'rate_limit' });

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
    it('uses email for contacts', () => {
      const records: ConnectorFile[] = [
        { id: 1, email: 'alice@example.com' },
        { id: 2, email: 'bob@example.com' },
      ];
      const tableSpec = buildTableSpec('contacts');
      tableSpec.slugFieldPath = 'email';

      const names = connector.getSuggestedRecordFileNames(records, tableSpec);

      expect(names).toEqual(['alice@example.com', 'bob@example.com']);
    });

    it('uses name for templates', () => {
      const records: ConnectorFile[] = [
        { id: 1, name: 'Welcome Email' },
        { id: 2, name: 'Newsletter' },
      ];
      const tableSpec = buildTableSpec('templates');
      tableSpec.slugFieldPath = 'name';

      const names = connector.getSuggestedRecordFileNames(records, tableSpec);

      expect(names).toEqual(['Welcome Email', 'Newsletter']);
    });

    it('uses name for mailing lists', () => {
      const records: ConnectorFile[] = [{ id: 1, name: 'VIP List' }];
      const tableSpec = buildTableSpec('mailing_lists');
      tableSpec.slugFieldPath = 'name';

      const names = connector.getSuggestedRecordFileNames(records, tableSpec);

      expect(names).toEqual(['VIP List']);
    });
  });

  // ---------------------------------------------------------------------------
  // Mailing lists (read-only)
  // ---------------------------------------------------------------------------

  describe('mailing lists', () => {
    it('lists mailing_lists as a table', async () => {
      const tables = await connector.listTables();
      const lists = tables.find((t) => t.id.wsId === 'mailing_lists');
      expect(lists).toBeDefined();
      expect(lists?.displayName).toBe('Mailing Lists');
      expect(lists?.disabledCreates).toBe(true);
    });

    it('builds mailing lists schema', async () => {
      const spec = await connector.fetchJsonTableSpec({ wsId: 'mailing_lists', remoteId: ['mailing_lists'] });
      expect(spec.name).toBe('Mailing Lists');
      expect(spec.idColumnRemoteId).toBe('id');
    });

    it('pulls mailing lists', async () => {
      const lists = [
        {
          id: 1,
          name: 'Newsletter',
          totalSubscribers: 100,
          uniqueSubscribers: 95,
          totalBlacklisted: 2,
          folderId: 1,
          dynamicList: false,
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ];
      mockListMailingLists.mockReturnValue(asyncGen([lists]));

      const collected: ConnectorFile[][] = [];
      const callback = jest.fn((params: { files: ConnectorFile[] }) => {
        collected.push(params.files);
        return Promise.resolve();
      });

      await connector.pullRecordFiles(buildTableSpec('mailing_lists'), callback, {}, { forceFull: false });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(collected[0]).toHaveLength(1);
    });

    it('fetches mailing list by ID', async () => {
      const list = { id: 5, name: 'VIP', totalSubscribers: 50 };
      mockGetMailingList.mockResolvedValue(list);

      const collected: ConnectorFile[][] = [];
      const callback = jest.fn((params: { files: ConnectorFile[] }) => {
        collected.push(params.files);
        return Promise.resolve();
      });

      await connector.pullRecordFilesByIds(buildTableSpec('mailing_lists'), ['5'], callback);

      expect(mockGetMailingList).toHaveBeenCalledWith(5);
      expect(collected[0]).toHaveLength(1);
    });
  });
});
