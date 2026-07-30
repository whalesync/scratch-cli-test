import { TSchema } from '@sinclair/typebox';
import { AxiosError } from 'axios';
import { WSLogger } from 'src/logger';
import { Service } from '../../../service-constants';
import { BaseJsonTableSpec, ConnectorFile, dotPath } from '../../../types';
import { QuickBooksConnector } from '../quickbooks-connector';

// Break the connector-registry → display-names circular import chain.
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'QuickBooks Online'),
}));

// Mock the API client so the connector's routing/body-shaping is tested in
// isolation. `isStaleObjectError` is a static on the real class — mirror it.
const mockCreateEntity = jest.fn();
const mockUpdateEntity = jest.fn();
const mockDeleteTransaction = jest.fn();
const mockGetEntity = jest.fn();
const mockQuery = jest.fn();
const mockIsStaleObjectError = jest.fn();

jest.mock('../quickbooks-api-client', () => {
  const MockClient = Object.assign(
    jest.fn().mockImplementation(() => ({
      testConnection: jest.fn(),
      query: mockQuery,
      getEntity: mockGetEntity,
      createEntity: mockCreateEntity,
      updateEntity: mockUpdateEntity,
      deleteTransaction: mockDeleteTransaction,
    })),
    { isStaleObjectError: (e: unknown): boolean => mockIsStaleObjectError(e) as boolean },
  );
  return {
    QuickBooksApiClient: MockClient,
    QuickBooksError: class QuickBooksError extends Error {
      statusCode?: number;
      code?: string;
      responseData?: unknown;
      constructor(message: string, statusCode?: number, code?: string, responseData?: unknown) {
        super(message);
        this.name = 'QuickBooksError';
        this.statusCode = statusCode;
        this.code = code;
        this.responseData = responseData;
      }
    },
  };
});

function buildTableSpec(entityType: string): BaseJsonTableSpec {
  return {
    id: { wsId: entityType.toLowerCase(), remoteId: [entityType] },
    slug: entityType.toLowerCase(),
    name: entityType,
    schema: {} as unknown as TSchema,
    idPath: dotPath('Id'),
  };
}

/** A QBO stale-object 400 as the api-client would surface it (used with the mocked isStale). */
function staleError(): AxiosError {
  return new AxiosError('Request failed with status code 400', '400', undefined, undefined, {
    status: 400,
    statusText: '',
    headers: {},
    config: {} as never,
    data: { Fault: { Error: [{ code: '5010', Message: 'Stale Object Error' }] } },
  });
}

describe('QuickBooksConnector (write)', () => {
  let connector: QuickBooksConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsStaleObjectError.mockReturnValue(false);
    connector = new QuickBooksConnector({ accessToken: 'tok', realmId: 'realm-1' });
  });

  describe('service / getBatchSize', () => {
    it('is the QuickBooks service with batch size 1', () => {
      expect(connector.service).toBe(Service.QUICKBOOKS);
      expect(connector.getBatchSize()).toBe(1);
    });
  });

  describe('getNewFile', () => {
    it('seeds a transaction template with a parent ref and a line', async () => {
      const file = await connector.getNewFile(buildTableSpec('Invoice'));
      expect(file).toHaveProperty('CustomerRef');
      expect(Array.isArray(file.Line)).toBe(true);
    });

    it('seeds a name-list template with the required display field', async () => {
      expect(await connector.getNewFile(buildTableSpec('Customer'))).toEqual({ DisplayName: '' });
    });

    it('returns a blank record for entities without a template', async () => {
      expect(await connector.getNewFile(buildTableSpec('TaxCode'))).toEqual({});
    });

    it('returns a fresh clone each call (no shared mutable template)', async () => {
      const first = await connector.getNewFile(buildTableSpec('Customer'));
      first.DisplayName = 'mutated';
      const second = await connector.getNewFile(buildTableSpec('Customer'));
      expect(second).toEqual({ DisplayName: '' });
    });
  });

  describe('createRecords', () => {
    it('strips system/envelope fields and returns the created record', async () => {
      const created = { Id: '42', SyncToken: '0', DisplayName: 'Acme' };
      mockCreateEntity.mockResolvedValue(created);

      const file: ConnectorFile = {
        DisplayName: 'Acme',
        Id: 'stale-id',
        SyncToken: '7',
        MetaData: { CreateTime: 'x' },
        domain: 'QBO',
        sparse: false,
      };
      const result = await connector.createRecords(buildTableSpec('Customer'), [file]);

      expect(mockCreateEntity).toHaveBeenCalledWith('Customer', { DisplayName: 'Acme' });
      expect(result).toEqual([created]);
    });

    it('throws for entities that cannot be created (CompanyInfo)', async () => {
      await expect(connector.createRecords(buildTableSpec('CompanyInfo'), [{}])).rejects.toThrow(/not supported/i);
      expect(mockCreateEntity).not.toHaveBeenCalled();
    });

    it('throws for read-only entities (TaxRate)', async () => {
      await expect(connector.createRecords(buildTableSpec('TaxRate'), [{}])).rejects.toThrow(/not supported/i);
    });
  });

  describe('updateRecords', () => {
    it('sends the changed fields as a sparse update with Id + SyncToken', async () => {
      const updated = { Id: '5', SyncToken: '4', DisplayName: 'New' };
      mockUpdateEntity.mockResolvedValue(updated);

      const file: ConnectorFile = { Id: '5', SyncToken: '3', DisplayName: 'Old' };
      const result = await connector.updateRecords(buildTableSpec('Customer'), [file], [{ DisplayName: 'New' }]);

      expect(mockUpdateEntity).toHaveBeenCalledWith('Customer', {
        DisplayName: 'New',
        Id: '5',
        SyncToken: '3',
        sparse: true,
      });
      expect(result).toEqual([updated]);
    });

    it('re-sends the full Line array when the change set touches Line', async () => {
      mockUpdateEntity.mockResolvedValue({ Id: '9', SyncToken: '2' });
      const fullLines = [
        { Id: '1', Amount: 10 },
        { Id: '2', Amount: 20 },
      ];
      const file: ConnectorFile = { Id: '9', SyncToken: '1', Line: fullLines };

      // The diff carries only a partial Line array — the connector must replace it
      // with the full array from the record file.
      await connector.updateRecords(buildTableSpec('Invoice'), [file], [{ Line: [{ Id: '1', Amount: 10 }] }]);

      expect(mockUpdateEntity).toHaveBeenCalledWith('Invoice', {
        Line: fullLines,
        Id: '9',
        SyncToken: '1',
        sparse: true,
      });
    });

    it('re-sends the full nested object when the change set touches one sub-field', async () => {
      mockUpdateEntity.mockResolvedValue({ Id: '5', SyncToken: '4' });
      // The dirty file holds the whole (edited) address; the diff carries only the
      // changed sub-field. The connector must send the full address so QBO doesn't
      // null Line1/PostalCode (a sparse update replaces nested objects wholesale).
      const fullBillAddr = { Line1: '1 Main St', City: 'NYC', PostalCode: '10001' };
      const file: ConnectorFile = { Id: '5', SyncToken: '3', BillAddr: fullBillAddr };

      await connector.updateRecords(buildTableSpec('Invoice'), [file], [{ BillAddr: { City: 'NYC' } }]);

      expect(mockUpdateEntity).toHaveBeenCalledWith('Invoice', {
        BillAddr: fullBillAddr,
        Id: '5',
        SyncToken: '3',
        sparse: true,
      });
    });

    it('carries required-on-update fields (Bill VendorRef) from the file into a sparse edit', async () => {
      // QBO rejects a Bill sparse update that omits VendorRef, so the connector
      // re-sends it from the record file even though only PrivateNote changed.
      mockUpdateEntity.mockResolvedValue({ Id: '9', SyncToken: '2' });
      const vendorRef = { value: '56' };
      const file: ConnectorFile = { Id: '9', SyncToken: '1', VendorRef: vendorRef, PrivateNote: 'old' };

      await connector.updateRecords(buildTableSpec('Bill'), [file], [{ PrivateNote: 'new' }]);

      expect(mockUpdateEntity).toHaveBeenCalledWith('Bill', {
        PrivateNote: 'new',
        VendorRef: vendorRef,
        Id: '9',
        SyncToken: '1',
        sparse: true,
      });
    });

    it('falls back to the full writable record when no diff is available', async () => {
      mockUpdateEntity.mockResolvedValue({ Id: '5', SyncToken: '4' });
      const file: ConnectorFile = { Id: '5', SyncToken: '3', DisplayName: 'Old', domain: 'QBO' };

      await connector.updateRecords(buildTableSpec('Customer'), [file], undefined);

      expect(mockUpdateEntity).toHaveBeenCalledWith('Customer', {
        DisplayName: 'Old',
        Id: '5',
        SyncToken: '3',
        sparse: true,
      });
    });

    it('skips a record with no Id and echoes a record with no writable changes', async () => {
      const noId: ConnectorFile = { DisplayName: 'x' };
      const noChanges: ConnectorFile = { Id: '5', SyncToken: '3', DisplayName: 'Same' };

      const result = await connector.updateRecords(buildTableSpec('Customer'), [noId, noChanges], [{}, {}]);

      expect(mockUpdateEntity).not.toHaveBeenCalled();
      expect(result).toEqual([noChanges]);
    });

    it('retries once with a re-fetched SyncToken on a stale-object rejection', async () => {
      mockIsStaleObjectError.mockReturnValue(true);
      mockUpdateEntity.mockRejectedValueOnce(staleError()).mockResolvedValueOnce({ Id: '5', SyncToken: '11' });
      mockGetEntity.mockResolvedValue({ Id: '5', SyncToken: '10' });

      const file: ConnectorFile = { Id: '5', SyncToken: '3', DisplayName: 'Old' };
      await connector.updateRecords(buildTableSpec('Customer'), [file], [{ DisplayName: 'New' }]);

      expect(mockUpdateEntity).toHaveBeenNthCalledWith(1, 'Customer', expect.objectContaining({ SyncToken: '3' }));
      expect(mockGetEntity).toHaveBeenCalledWith('Customer', '5');
      expect(mockUpdateEntity).toHaveBeenNthCalledWith(2, 'Customer', expect.objectContaining({ SyncToken: '10' }));
    });

    it('throws for read-only entities (TaxCode)', async () => {
      await expect(connector.updateRecords(buildTableSpec('TaxCode'), [{ Id: '1' }], [{}])).rejects.toThrow(
        /not supported/i,
      );
    });
  });

  describe('deleteRecords', () => {
    it('hard-deletes a transaction entity via operation=delete', async () => {
      mockDeleteTransaction.mockResolvedValue(true);
      const file: ConnectorFile = { Id: '9', SyncToken: '2' };

      await connector.deleteRecords(buildTableSpec('Invoice'), [file]);

      expect(mockDeleteTransaction).toHaveBeenCalledWith('Invoice', '9', '2');
      expect(mockUpdateEntity).not.toHaveBeenCalled();
    });

    it('deactivates a name-list entity via a sparse Active:false update', async () => {
      mockUpdateEntity.mockResolvedValue({ Id: '5', SyncToken: '4', Active: false });
      const file: ConnectorFile = { Id: '5', SyncToken: '3' };

      await connector.deleteRecords(buildTableSpec('Customer'), [file]);

      expect(mockUpdateEntity).toHaveBeenCalledWith('Customer', {
        Active: false,
        Id: '5',
        SyncToken: '3',
        sparse: true,
      });
      expect(mockDeleteTransaction).not.toHaveBeenCalled();
    });

    it('carries required-on-update fields when deactivating (Term Type/DueDays)', async () => {
      // A deactivate is a sparse update, so it must satisfy the same required-field
      // rule as an edit — a bare { Active: false } on a Term omits Type/DueDays.
      mockUpdateEntity.mockResolvedValue({ Id: '7', SyncToken: '3', Active: false });
      const file: ConnectorFile = { Id: '7', SyncToken: '2', Type: 'STANDARD', DueDays: 30, Name: 'Net 30' };

      await connector.deleteRecords(buildTableSpec('Term'), [file]);

      expect(mockUpdateEntity).toHaveBeenCalledWith('Term', {
        Active: false,
        Type: 'STANDARD',
        DueDays: 30,
        Id: '7',
        SyncToken: '2',
        sparse: true,
      });
    });

    it('retries a hard delete once with a re-fetched SyncToken on a stale-object rejection', async () => {
      mockIsStaleObjectError.mockReturnValue(true);
      mockDeleteTransaction.mockRejectedValueOnce(staleError()).mockResolvedValueOnce(true);
      mockGetEntity.mockResolvedValue({ Id: '9', SyncToken: '10' });

      await connector.deleteRecords(buildTableSpec('Invoice'), [{ Id: '9', SyncToken: '2' }]);

      expect(mockDeleteTransaction).toHaveBeenNthCalledWith(1, 'Invoice', '9', '2');
      expect(mockDeleteTransaction).toHaveBeenNthCalledWith(2, 'Invoice', '9', '10');
    });

    it('is a no-op when a hard-deleted record is already gone', async () => {
      mockIsStaleObjectError.mockReturnValue(true);
      mockDeleteTransaction.mockRejectedValueOnce(staleError());
      mockGetEntity.mockResolvedValue(null); // vanished on refetch

      await expect(
        connector.deleteRecords(buildTableSpec('Invoice'), [{ Id: '9', SyncToken: '2' }]),
      ).resolves.toBeUndefined();
      expect(mockDeleteTransaction).toHaveBeenCalledTimes(1);
    });

    it('throws for entities that cannot be deleted (CompanyInfo)', async () => {
      await expect(connector.deleteRecords(buildTableSpec('CompanyInfo'), [{ Id: '1' }])).rejects.toThrow(
        /not supported/i,
      );
    });
  });

  /**
   * A field QBO returns but the hand-maintained schema doesn't declare lands on disk
   * (the schemas are `additionalProperties: true`) but gets no view column, so it
   * syncs to no destination with nothing anywhere to say so (DEV-11134).
   */
  describe('pullRecordFiles — undeclared-field warning', () => {
    const customerSpec: BaseJsonTableSpec = {
      ...buildTableSpec('Customer'),
      schema: { properties: { Id: {}, DisplayName: {} } } as unknown as TSchema,
    };
    let warnSpy: jest.SpyInstance<void, [{ message: string }]>;

    beforeEach(() => {
      warnSpy = jest.spyOn(WSLogger, 'warn').mockImplementation(() => undefined) as typeof warnSpy;
    });

    afterEach(() => warnSpy.mockRestore());

    async function pull(entities: Record<string, unknown>[]): Promise<void> {
      mockQuery.mockResolvedValueOnce({ entities, hasMore: false });
      await connector.pullRecordFiles(customerSpec, () => Promise.resolve(), {}, {});
    }

    it('names every undeclared field QBO returned', async () => {
      await pull([{ Id: '1', DisplayName: 'Acme', Notes: 'hi', Suffix: 'Jr' }]);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0].message).toContain('Notes, Suffix');
    });

    it('stays quiet when every field is declared', async () => {
      await pull([{ Id: '1', DisplayName: 'Acme' }]);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('reports each field once, not once per record', async () => {
      await pull([
        { Id: '1', Notes: 'a' },
        { Id: '2', Notes: 'b' },
      ]);
      await pull([{ Id: '3', Notes: 'c' }]);

      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });
});
