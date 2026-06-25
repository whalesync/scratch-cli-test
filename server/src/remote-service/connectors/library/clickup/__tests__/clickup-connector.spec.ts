import { BaseJsonTableSpec, ConnectorFile, EntityId } from '../../../types';
import { ClickUpError } from '../clickup-api-client';
import { ClickUpConnector } from '../clickup-connector';
import { buildClickUpJsonTableSpec } from '../clickup-json-schema';

// Break the circular import chain through ../../connector -> display-names.
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'ClickUp'),
}));

// Mock the low-level API client; keep ClickUpError a real Error subclass.
const mockTestConnection = jest.fn();
const mockListTeams = jest.fn();
const mockListSpaces = jest.fn();
const mockListFolders = jest.fn();
const mockListFolderlessLists = jest.fn();
const mockGetList = jest.fn();
const mockListCustomFields = jest.fn();
const mockListDocs = jest.fn();
const mockListTasksPage = jest.fn();
const mockGetTask = jest.fn();
const mockCreateTask = jest.fn();
const mockUpdateTask = jest.fn();
const mockDeleteTask = jest.fn();
const mockSetCustomFieldValue = jest.fn();

jest.mock('../clickup-api-client', () => ({
  ClickUpApiClient: jest.fn().mockImplementation(() => ({
    testConnection: mockTestConnection,
    listTeams: mockListTeams,
    listSpaces: mockListSpaces,
    listFolders: mockListFolders,
    listFolderlessLists: mockListFolderlessLists,
    getList: mockGetList,
    listCustomFields: mockListCustomFields,
    listDocs: mockListDocs,
    listTasksPage: mockListTasksPage,
    getTask: mockGetTask,
    createTask: mockCreateTask,
    updateTask: mockUpdateTask,
    deleteTask: mockDeleteTask,
    setCustomFieldValue: mockSetCustomFieldValue,
  })),
  ClickUpError: class ClickUpError extends Error {
    statusCode?: number;
    responseData?: unknown;
    constructor(message: string, statusCode?: number, responseData?: unknown) {
      super(message);
      this.name = 'ClickUpError';
      this.statusCode = statusCode;
      this.responseData = responseData;
    }
  },
}));

const LIST_ID = '901218672815';

function tableSpec(): BaseJsonTableSpec {
  const id: EntityId = { wsId: LIST_ID, remoteId: [LIST_ID] };
  return buildClickUpJsonTableSpec(id, 'Project 1', []);
}

describe('ClickUpConnector', () => {
  let connector: ClickUpConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new ClickUpConnector({ apiKey: 'pk_test' });
  });

  describe('listTables', () => {
    it('returns Users + Docs per workspace, plus every List (kind+team encoded in remoteId)', async () => {
      mockListTeams.mockResolvedValue([{ id: 'team1', name: 'WS' }]);
      mockListSpaces.mockResolvedValue([{ id: 'space1', name: 'Team Space' }]);
      mockListFolders.mockResolvedValue([
        { id: 'folder1', name: 'My Folder', lists: [{ id: 'listA', name: 'In Folder' }] },
      ]);
      mockListFolderlessLists.mockResolvedValue([{ id: 'listB', name: 'Folderless' }]);

      const tables = await connector.listTables();

      // Users + Docs + 2 lists.
      expect(tables).toHaveLength(4);
      const users = tables.find((t) => t.displayName === 'Users');
      const docs = tables.find((t) => t.displayName === 'Docs');
      expect(users?.id.remoteId).toEqual(['users', 'team1']);
      expect(users?.parentPath).toBe('WS');
      expect(docs?.id.remoteId).toEqual(['doc', 'team1']);

      const inFolder = tables.find((t) => t.displayName === 'In Folder');
      const folderless = tables.find((t) => t.displayName === 'Folderless');
      expect(inFolder?.parentPath).toBe('WS/Team Space/My Folder');
      expect(inFolder?.id.remoteId).toEqual(['list', 'team1', 'listA']);
      expect(folderless?.parentPath).toBe('WS/Team Space');
      expect(folderless?.id.remoteId).toEqual(['list', 'team1', 'listB']);
    });
  });

  describe('fetchJsonTableSpec', () => {
    it('resolves the list name and embeds a custom-field legend', async () => {
      mockGetList.mockResolvedValue({ id: LIST_ID, name: 'Project 1' });
      mockListCustomFields.mockResolvedValue([{ id: 'cf1', name: 'Priority Score', type: 'number' }]);

      const spec = await connector.fetchJsonTableSpec({ wsId: LIST_ID, remoteId: [LIST_ID] });

      expect(spec.name).toBe('Project 1');
      expect(spec.idPath).toBe('id');
      expect(spec.titlePath).toEqual('name');
      const customFields = (spec.schema as unknown as { properties: { custom_fields: Record<string, unknown> } })
        .properties.custom_fields;
      expect(JSON.stringify(customFields)).toContain('cf1=Priority Score (number)');
    });

    it('builds basePath from the Space and Folder (→ /{Space}/{Folder}/{List}/…)', async () => {
      mockGetList.mockResolvedValue({
        id: LIST_ID,
        name: 'Project 1',
        space: { id: 's1', name: 'Team Space' },
        folder: { id: 'f1', name: 'My Folder', hidden: false },
      });
      mockListCustomFields.mockResolvedValue([]);

      const spec = await connector.fetchJsonTableSpec({ wsId: LIST_ID, remoteId: [LIST_ID] });
      expect(spec.basePath).toEqual(['Team Space', 'My Folder']);
    });

    it('excludes the ClickUp-internal hidden folder for folderless lists (→ /{Space}/{List}/…)', async () => {
      mockGetList.mockResolvedValue({
        id: LIST_ID,
        name: 'Project 1',
        space: { id: 's1', name: 'Team Space' },
        folder: { id: 'f1', name: 'hidden', hidden: true },
      });
      mockListCustomFields.mockResolvedValue([]);

      const spec = await connector.fetchJsonTableSpec({ wsId: LIST_ID, remoteId: [LIST_ID] });
      expect(spec.basePath).toEqual(['Team Space']);
    });

    it('prepends the Workspace name to basePath (new remoteId format)', async () => {
      mockListTeams.mockResolvedValue([{ id: 'team1', name: 'My Workspace' }]);
      mockGetList.mockResolvedValue({
        id: LIST_ID,
        name: 'Project 1',
        space: { id: 's1', name: 'Team Space' },
        folder: { id: 'f1', name: 'My Folder', hidden: false },
      });
      mockListCustomFields.mockResolvedValue([]);

      const spec = await connector.fetchJsonTableSpec({ wsId: 'x', remoteId: ['list', 'team1', LIST_ID] });
      expect(spec.basePath).toEqual(['My Workspace', 'Team Space', 'My Folder']);
    });

    it('builds the read-only Users entity spec at /{Workspace}/Users', async () => {
      mockListTeams.mockResolvedValue([{ id: 'team1', name: 'My Workspace' }]);
      const spec = await connector.fetchJsonTableSpec({ wsId: 'users-team1', remoteId: ['users', 'team1'] });
      expect(spec.name).toBe('Users');
      expect(spec.basePath).toEqual(['My Workspace']);
      const props = (spec.schema as unknown as { properties: Record<string, Record<string, unknown>> }).properties;
      expect(props.id['x-scratch-readonly']).toBe(true);
      expect(props.email['x-scratch-readonly']).toBe(true);
    });

    it('builds the read-only Docs entity spec at /{Workspace}/Docs', async () => {
      mockListTeams.mockResolvedValue([{ id: 'team1', name: 'My Workspace' }]);
      const spec = await connector.fetchJsonTableSpec({ wsId: 'docs-team1', remoteId: ['doc', 'team1'] });
      expect(spec.name).toBe('Docs');
      expect(spec.basePath).toEqual(['My Workspace']);
    });
  });

  describe('Users + Docs entities (read-only, own codepaths)', () => {
    const usersSpec = { id: { wsId: 'users-team1', remoteId: ['users', 'team1'] } } as BaseJsonTableSpec;
    const docsSpec = { id: { wsId: 'docs-team1', remoteId: ['doc', 'team1'] } } as BaseJsonTableSpec;

    it('pulls workspace members as the Users records', async () => {
      mockListTeams.mockResolvedValue([
        {
          id: 'team1',
          name: 'WS',
          members: [{ user: { id: 1, username: 'Ivan' } }, { user: { id: 2, username: 'Sam' } }],
        },
      ]);
      const files: ConnectorFile[] = [];
      await connector.pullRecordFiles(
        usersSpec,
        (b) => {
          files.push(...b.files);
          return Promise.resolve();
        },
        {},
        {} as never,
      );
      expect(files.map((u) => u.username)).toEqual(['Ivan', 'Sam']);
    });

    it('pulls docs via the v3 endpoint', async () => {
      mockListDocs.mockResolvedValue([{ id: 'd1', name: 'Doc A' }]);
      const files: ConnectorFile[] = [];
      await connector.pullRecordFiles(
        docsSpec,
        (b) => {
          files.push(...b.files);
          return Promise.resolve();
        },
        {},
        {} as never,
      );
      expect(mockListDocs).toHaveBeenCalledWith('team1');
      expect(files[0].id).toBe('d1');
    });

    it('rejects writes to the read-only Users/Docs entities', async () => {
      await expect(connector.createRecords(usersSpec, [{ username: 'x' } as ConnectorFile])).rejects.toThrow(
        /read-only/,
      );
      await expect(connector.createRecords(docsSpec, [{ name: 'x' } as ConnectorFile])).rejects.toThrow(/read-only/);
    });
  });

  describe('pullRecordFiles', () => {
    it('pages until last_page and checkpoints the next page', async () => {
      mockListTasksPage
        .mockResolvedValueOnce({ tasks: [{ id: 't1' }], lastPage: false })
        .mockResolvedValueOnce({ tasks: [{ id: 't2' }], lastPage: true });
      const batches: { files: ConnectorFile[]; connectorProgress?: { nextPage?: number } }[] = [];

      await connector.pullRecordFiles(
        tableSpec(),
        (b) => {
          batches.push(b);
          return Promise.resolve();
        },
        {},
        {} as never,
      );

      expect(mockListTasksPage).toHaveBeenCalledTimes(2);
      expect(batches.map((b) => b.files[0].id)).toEqual(['t1', 't2']);
      expect(batches[0].connectorProgress).toEqual({ nextPage: 1 });
    });
  });

  describe('createRecords', () => {
    it('translates read-shape status/priority/date to write shape and inlines custom fields', async () => {
      mockCreateTask.mockResolvedValue({ id: 'newtask', name: 'New' });

      const file: ConnectorFile = {
        name: 'New',
        description: 'body',
        status: { status: 'to do', id: 'x', color: '#000' },
        priority: { priority: 'high', id: '2' },
        due_date: '1781000000000',
        points: 3,
        custom_fields: [{ id: 'cf1', name: 'Score', type: 'number', value: 42 }],
        // read-only fields must NOT be sent:
        url: 'https://app.clickup.com/t/newtask',
        date_created: '1780000000000',
      };

      await connector.createRecords(tableSpec(), [file]);

      expect(mockCreateTask).toHaveBeenCalledTimes(1);
      const [listId, body] = mockCreateTask.mock.calls[0] as [string, Record<string, unknown>];
      expect(listId).toBe(LIST_ID);
      expect(body.name).toBe('New');
      expect(body.status).toBe('to do');
      expect(body.priority).toBe(2);
      expect(body.due_date).toBe(1781000000000);
      expect(body.points).toBe(3);
      expect(body.custom_fields).toEqual([{ id: 'cf1', value: 42 }]);
      // read-only fields stripped:
      expect(body.url).toBeUndefined();
      expect(body.date_created).toBeUndefined();
      expect(body.id).toBeUndefined();
    });
  });

  describe('updateRecords', () => {
    it('PUTs only changed standard fields and POSTs changed custom-field values', async () => {
      mockUpdateTask.mockResolvedValue({});
      const file: ConnectorFile = { id: 't1', name: 'Renamed' };
      const changed = { name: 'Renamed', custom_fields: [{ id: 'cf1', name: 'Score', type: 'number', value: 99 }] };

      await connector.updateRecords(tableSpec(), [file], [changed]);

      expect(mockUpdateTask).toHaveBeenCalledWith('t1', { name: 'Renamed' });
      expect(mockSetCustomFieldValue).toHaveBeenCalledWith('t1', 'cf1', 99);
    });

    it('skips the PUT when only custom fields changed', async () => {
      const file: ConnectorFile = { id: 't1', name: 'Same' };
      const changed = { custom_fields: [{ id: 'cf1', name: 'Score', type: 'number', value: 7 }] };

      await connector.updateRecords(tableSpec(), [file], [changed]);

      expect(mockUpdateTask).not.toHaveBeenCalled();
      expect(mockSetCustomFieldValue).toHaveBeenCalledWith('t1', 'cf1', 7);
    });

    it('does not write read-only custom field types (formula)', async () => {
      const file: ConnectorFile = { id: 't1' };
      const changed = { custom_fields: [{ id: 'cfFormula', name: 'Auto', type: 'formula', value: 'x' }] };

      await connector.updateRecords(tableSpec(), [file], [changed]);

      expect(mockSetCustomFieldValue).not.toHaveBeenCalled();
    });
  });

  describe('deleteRecords', () => {
    it('deletes by id read from the record', async () => {
      await connector.deleteRecords(tableSpec(), [{ id: 't9' } as ConnectorFile]);
      expect(mockDeleteTask).toHaveBeenCalledWith('t9');
    });
  });

  describe('extractConnectorErrorDetails', () => {
    it('surfaces ClickUpError messages', () => {
      const details = connector.extractConnectorErrorDetails(new ClickUpError('Invalid token', 401));
      expect(details.userFriendlyMessage).toBe('Invalid token');
      expect(details.additionalContext?.status).toBe(401);
    });
  });
});
