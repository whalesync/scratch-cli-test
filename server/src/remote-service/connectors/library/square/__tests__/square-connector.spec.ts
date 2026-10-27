import { TSchema } from '@sinclair/typebox';
import { BaseJsonTableSpec, ConnectorFile, dotPath } from '../../../types';
import { SquareConnector } from '../square-connector';
import { SQUARE_ENTITY_TYPES, SquarePullProgress } from '../square-types';

jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Square'),
}));

const mockValidateCredentials = jest.fn();
const mockListEntityPages = jest.fn();
const mockRetrieveEntity = jest.fn();

jest.mock('../square-api-client', () => {
  const actual = jest.requireActual<typeof import('../square-api-client')>('../square-api-client');
  return {
    ...actual,
    SquareApiClient: jest.fn().mockImplementation(() => ({
      environment: 'production',
      validateCredentials: mockValidateCredentials,
      listEntityPages: mockListEntityPages,
      retrieveEntity: mockRetrieveEntity,
    })),
  };
});

function tableSpecFor(entityType: string): BaseJsonTableSpec {
  return {
    id: { wsId: entityType, remoteId: [entityType] },
    slug: entityType,
    name: entityType,
    schema: {} as unknown as TSchema,
    idPath: dotPath('id'),
    slugPath: dotPath('name'),
  };
}

// eslint-disable-next-line @typescript-eslint/require-await
async function* pagesOf(pages: { records: Record<string, unknown>[]; progressAfterPage: SquarePullProgress }[]) {
  for (const page of pages) yield page;
}

describe('SquareConnector', () => {
  let connector: SquareConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new SquareConnector({ accessToken: 't', environment: 'production' });
  });

  it('lists every table as read-only', async () => {
    const tables = await connector.listTables();

    expect(tables.map((table) => table.id.wsId)).toEqual(SQUARE_ENTITY_TYPES);
    for (const table of tables) {
      expect(table).toMatchObject({ disabledCreates: true, disabledUpdates: true, disabledDeletes: true });
    }
  });

  it('rejects an unknown table', async () => {
    await expect(connector.fetchJsonTableSpec({ wsId: 'gift_cards', remoteId: ['gift_cards'] })).rejects.toThrow(
      "Square has no table 'gift_cards'",
    );
  });

  it('hands each page to the job exactly as Square returned it, with its resume progress', async () => {
    const squarePayment = {
      id: 'P1',
      amount_money: { amount: 1250, currency: 'AUD' },
      created_at: '2026-10-01T00:00:00Z',
    };
    mockListEntityPages.mockReturnValue(
      pagesOf([
        { records: [squarePayment], progressAfterPage: { locationIndex: 0, cursor: 'c-1' } },
        { records: [{ id: 'P2' }], progressAfterPage: { locationIndex: 1 } },
      ]),
    );
    const callback = jest.fn().mockResolvedValue(undefined);

    const result = await connector.pullRecordFiles(tableSpecFor('payments'), callback, { locationIndex: 0 }, {});

    expect(result).toEqual({});
    expect(mockListEntityPages).toHaveBeenCalledWith('payments', { locationIndex: 0 });
    expect(callback).toHaveBeenNthCalledWith(1, {
      files: [squarePayment],
      connectorProgress: { locationIndex: 0, cursor: 'c-1' },
    });
    expect(callback).toHaveBeenNthCalledWith(2, { files: [{ id: 'P2' }], connectorProgress: { locationIndex: 1 } });
  });

  it('pulls specific records by id, skipping ones Square no longer has', async () => {
    mockRetrieveEntity.mockImplementation((_entityType: string, recordId: string) =>
      Promise.resolve(recordId === 'gone' ? null : { id: recordId }),
    );
    const callback = jest.fn().mockResolvedValue(undefined);

    await connector.pullRecordFilesByIds(tableSpecFor('orders'), ['O1', 'gone', 'O2'], callback);

    expect(callback).toHaveBeenCalledWith({ files: [{ id: 'O1' }, { id: 'O2' }] });
  });

  it('refuses every write', () => {
    const spec = tableSpecFor('customers');
    const files = [{ id: 'C1' }] as ConnectorFile[];

    expect(() => connector.createRecords(spec, files)).toThrow('read-only');
    expect(() => connector.updateRecords(spec, files)).toThrow('read-only');
    expect(() => connector.deleteRecords(spec, files)).toThrow('read-only');
  });

  it('names record files by the slug, falling back to the id', () => {
    const names = connector.getSuggestedRecordFileNames(
      [{ id: 'L1', name: 'Sydney Opera House' }, { id: 'L2' }] as ConnectorFile[],
      tableSpecFor('locations'),
    );

    expect(names).toEqual(['Sydney Opera House', 'L2']);
  });
});
