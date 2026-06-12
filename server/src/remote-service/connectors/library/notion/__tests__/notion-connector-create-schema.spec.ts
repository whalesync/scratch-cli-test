import { type NormalizedCreateFieldsPlan, type NormalizedCreateTablePlan } from '../../../schema-creation.types';

// Mock display-names to break the circular import chain (registry → DB).
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Notion'),
}));

const mockCreateDatabase = jest.fn();
const mockUpdateDataSource = jest.fn();
const mockRetrieveDatabase = jest.fn();
const mockRetrieveDataSource = jest.fn();

// Mock the api-client so the connector's `this.client` is the mock. Real error
// classes / constants are kept via requireActual (the connector imports them).
jest.mock('../notion-api-client', () => ({
  ...jest.requireActual<typeof import('../notion-api-client')>('../notion-api-client'),
  NotionApiClient: jest.fn().mockImplementation(() => ({
    createDatabase: mockCreateDatabase,
    updateDataSource: mockUpdateDataSource,
    retrieveDatabase: mockRetrieveDatabase,
    retrieveDataSource: mockRetrieveDataSource,
  })),
}));

jest.mock('turndown', () =>
  jest.fn().mockImplementation(() => ({
    addRule: jest.fn().mockReturnThis(),
    turndown: jest.fn(() => ''),
  })),
);

import { NotionError } from '../notion-api-client';
import { NotionConnector } from '../notion-connector';
import { NOTION_SCHEMA_CREATION_CAPABILITIES } from '../notion-create-schema';

/** Typed view of the `createDatabase` request body the connector builds (mock args are otherwise `any`). */
interface CreateDatabaseBody {
  parent: { type: string; page_id: string };
  title: Array<{ type: string; text: { content: string } }>;
  initial_data_source: { properties: Record<string, Record<string, unknown>> };
}

type UpdateDataSourceBody = { data_source_id: string; properties: Record<string, unknown> };

function createDatabaseBody(): CreateDatabaseBody {
  const calls = mockCreateDatabase.mock.calls as [CreateDatabaseBody][];
  return calls[0][0];
}

function updateDataSourceBody(callIndex: number): UpdateDataSourceBody {
  const calls = mockUpdateDataSource.mock.calls as [UpdateDataSourceBody][];
  return calls[callIndex][0];
}

function fullDatabase(id: string, dataSourceId: string) {
  return { object: 'database', id, data_sources: [{ id: dataSourceId, name: 'ds' }] };
}

function dataSourceWithProperties(names: string[]) {
  return {
    object: 'data_source',
    id: 'ds_1',
    properties: Object.fromEntries(names.map((name) => [name, { id: name, type: 'rich_text' }])),
  };
}

describe('NotionConnector — schema creation', () => {
  let connector: NotionConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new NotionConnector('fake-key');
  });

  it('advertises schema creation and Notion capabilities', () => {
    expect(connector.supportsSchemaCreation()).toBe(true);
    expect(connector.getSchemaCreationCapabilities()).toBe(NOTION_SCHEMA_CREATION_CAPABILITIES);
  });

  describe('createTable', () => {
    it('creates a database with a title + mapped properties and returns [databaseId, dataSourceId]', async () => {
      mockCreateDatabase.mockResolvedValue(fullDatabase('db_new', 'ds_new'));
      const plan: NormalizedCreateTablePlan = {
        ref: 't1',
        name: 'My Table',
        remoteParentId: ['page_123'],
        fields: [
          { name: 'Name', fieldType: { kind: 'text' }, isPrimary: true },
          { name: 'Count', fieldType: { kind: 'number' } },
        ],
        deferredFkFields: [],
      };

      const result = await connector.createTable(plan);

      expect(mockCreateDatabase).toHaveBeenCalledTimes(1);
      const body = createDatabaseBody();
      expect(body.parent).toEqual({ type: 'page_id', page_id: 'page_123' });
      expect(body.title).toEqual([{ type: 'text', text: { content: 'My Table' } }]);
      expect(body.initial_data_source.properties).toEqual({
        Name: { title: {} },
        Count: { number: { format: 'number' } },
      });
      expect(result).toEqual({
        ref: 't1',
        name: 'My Table',
        status: 'created',
        remoteTableId: ['db_new', 'ds_new'],
        fields: [
          { name: 'Name', status: 'created', remoteFieldId: 'Name' },
          { name: 'Count', status: 'created', remoteFieldId: 'Count' },
        ],
      });
    });

    it('resolves a foreign key to a relation pointing at the target data source', async () => {
      mockCreateDatabase.mockResolvedValue(fullDatabase('db_new', 'ds_new'));
      const plan: NormalizedCreateTablePlan = {
        ref: 't1',
        name: 'Tasks',
        remoteParentId: ['page_1'],
        fields: [
          { name: 'Name', fieldType: { kind: 'text' }, isPrimary: true },
          { name: 'Project', fieldType: { kind: 'foreignKey', target: { existingRemoteTableId: ['db_p', 'ds_p'] } } },
        ],
        deferredFkFields: [],
      };

      const result = await connector.createTable(plan);

      const properties = createDatabaseBody().initial_data_source.properties;
      expect(properties.Project).toEqual({
        relation: { data_source_id: 'ds_p', type: 'single_property', single_property: {} },
      });
      expect(result.status).toBe('created');
    });

    it('fails clearly when no parent page id is provided', async () => {
      const plan: NormalizedCreateTablePlan = {
        ref: 't1',
        name: 'Orphan',
        fields: [{ name: 'Name', fieldType: { kind: 'text' }, isPrimary: true }],
        deferredFkFields: [],
      };

      const result = await connector.createTable(plan);

      expect(mockCreateDatabase).not.toHaveBeenCalled();
      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/parent page/i);
      expect(result.remoteTableId).toBeUndefined();
    });

    it('marks the table partial and skips a foreign key whose target cannot be resolved', async () => {
      mockCreateDatabase.mockResolvedValue(fullDatabase('db_new', 'ds_new'));
      // A 1-element target forces a data-source lookup; make it fail.
      mockRetrieveDatabase.mockRejectedValue(new Error('boom'));
      const plan: NormalizedCreateTablePlan = {
        ref: 't1',
        name: 'Tasks',
        remoteParentId: ['page_1'],
        fields: [
          { name: 'Name', fieldType: { kind: 'text' }, isPrimary: true },
          { name: 'Project', fieldType: { kind: 'foreignKey', target: { existingRemoteTableId: ['db_only'] } } },
        ],
        deferredFkFields: [],
      };

      const result = await connector.createTable(plan);

      const properties = createDatabaseBody().initial_data_source.properties;
      expect(properties).not.toHaveProperty('Project');
      expect(result.status).toBe('partial');
      const projectResult = result.fields.find((f) => f.name === 'Project');
      expect(projectResult?.status).toBe('skipped');
    });

    it('returns failed with a friendly message when the Notion API rejects the create', async () => {
      mockCreateDatabase.mockRejectedValue(
        new NotionError({ code: 'validation_error', message: 'title is required', status: 400 }),
      );
      const plan: NormalizedCreateTablePlan = {
        ref: 't1',
        name: 'Bad',
        remoteParentId: ['page_1'],
        fields: [{ name: 'Name', fieldType: { kind: 'text' }, isPrimary: true }],
        deferredFkFields: [],
      };

      const result = await connector.createTable(plan);

      expect(result.status).toBe('failed');
      expect(result.error).toContain('title is required');
    });
  });

  describe('createFields', () => {
    it('adds one property per field, isolating each in its own updateDataSource call', async () => {
      mockRetrieveDataSource.mockResolvedValue(dataSourceWithProperties(['Name']));
      mockUpdateDataSource.mockResolvedValue({ object: 'data_source', id: 'ds_1' });
      const plan: NormalizedCreateFieldsPlan = {
        remoteTableId: ['db_1', 'ds_1'],
        fields: [
          { name: 'Link', fieldType: { kind: 'url' } },
          { name: 'Stage', fieldType: { kind: 'select', options: [{ name: 'A' }] } },
        ],
      };

      const results = await connector.createFields(plan);

      expect(mockUpdateDataSource).toHaveBeenCalledTimes(2);
      expect(updateDataSourceBody(0)).toEqual({
        data_source_id: 'ds_1',
        properties: { Link: { url: {} } },
      });
      expect(results).toEqual([
        { name: 'Link', status: 'created', remoteFieldId: 'Link' },
        { name: 'Stage', status: 'created', remoteFieldId: 'Stage' },
      ]);
    });

    it('skips (does not overwrite) a field whose name already exists on the data source', async () => {
      mockRetrieveDataSource.mockResolvedValue(dataSourceWithProperties(['Name']));
      mockUpdateDataSource.mockResolvedValue({ object: 'data_source', id: 'ds_1' });
      const plan: NormalizedCreateFieldsPlan = {
        remoteTableId: ['db_1', 'ds_1'],
        fields: [{ name: 'name', fieldType: { kind: 'text' } }],
      };

      const results = await connector.createFields(plan);

      expect(mockUpdateDataSource).not.toHaveBeenCalled();
      expect(results[0].status).toBe('skipped');
      expect(results[0].error).toMatch(/already exists/i);
    });

    it('isolates a per-field API failure without dropping the others', async () => {
      mockRetrieveDataSource.mockResolvedValue(dataSourceWithProperties([]));
      mockUpdateDataSource.mockImplementation((args: { properties: Record<string, unknown> }) => {
        if ('Bad' in args.properties) {
          return Promise.reject(new NotionError({ code: 'validation_error', message: 'nope', status: 400 }));
        }
        return Promise.resolve({ object: 'data_source', id: 'ds_1' });
      });
      const plan: NormalizedCreateFieldsPlan = {
        remoteTableId: ['db_1', 'ds_1'],
        fields: [
          { name: 'Good', fieldType: { kind: 'text' } },
          { name: 'Bad', fieldType: { kind: 'text' } },
        ],
      };

      const results = await connector.createFields(plan);

      expect(results.find((r) => r.name === 'Good')?.status).toBe('created');
      expect(results.find((r) => r.name === 'Bad')?.status).toBe('failed');
    });
  });
});
