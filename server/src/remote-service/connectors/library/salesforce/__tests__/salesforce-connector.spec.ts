// Break the circular import chain: connector.ts → display-names.ts → registry → every connector → connector.ts.
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import { IncrementalPullSupport } from '@spinner/shared-types';
import { AxiosError } from 'axios';
import { ConnectorFile } from '../../../types';
import { SalesforceApiClient, SalesforceApiError } from '../salesforce-api-client';
import { SalesforceConnector } from '../salesforce-connector';
import { SalesforceDownloadProgress, SalesforceQueryResponse, SalesforceRecord } from '../salesforce-types';
import {
  ACCOUNT_DESCRIBE,
  accountTableSpec,
  salesforceSObjectSummary,
  TEST_INSTANCE_URL,
} from './salesforce-test-fixtures';

function makeConnector(): SalesforceConnector {
  return new SalesforceConnector(TEST_INSTANCE_URL, 'access-token');
}

function accountRecord(recordId: string, name: string): SalesforceRecord {
  return {
    attributes: { type: 'Account', url: `/services/data/v66.0/sobjects/Account/${recordId}` },
    Id: recordId,
    Name: name,
  };
}

function queryBatch(records: SalesforceRecord[], nextRecordsUrl?: string): SalesforceQueryResponse {
  return { totalSize: records.length, done: !nextRecordsUrl, nextRecordsUrl, records };
}

function salesforceAxiosError(status: number, body: unknown): AxiosError {
  return Object.assign(new AxiosError(`Request failed with status code ${status}`), {
    response: { status, data: body, statusText: '', headers: {}, config: {} },
  });
}

const ACCOUNT_1 = '001000000000001AAA';
const ACCOUNT_2 = '001000000000002AAA';
const ACCOUNT_3 = '001000000000003AAA';

describe('SalesforceConnector', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('listTables', () => {
    it('lists user-facing objects in core, custom, other groups and leaves system objects out', async () => {
      jest.spyOn(SalesforceApiClient.prototype, 'listSObjects').mockResolvedValue([
        salesforceSObjectSummary({ name: 'BusinessHours', labelPlural: 'Business Hours' }),
        salesforceSObjectSummary({ name: 'Contact', labelPlural: 'Contacts' }),
        salesforceSObjectSummary({ name: 'Account', labelPlural: 'Accounts' }),
        salesforceSObjectSummary({ name: 'Invoice__c', labelPlural: 'Invoices', custom: true, layoutable: false }),
        // System objects: not layoutable.
        salesforceSObjectSummary({ name: 'AccountHistory', layoutable: false }),
        salesforceSObjectSummary({ name: 'AccountFeed', layoutable: false }),
        // Core CRM objects are listed even if an org reports them non-layoutable.
        salesforceSObjectSummary({ name: 'Note', labelPlural: 'Notes', layoutable: false }),
        // Not readable in full.
        salesforceSObjectSummary({ name: 'Unqueryable', queryable: false }),
        salesforceSObjectSummary({ name: 'Hidden', deprecatedAndHidden: true }),
        // Big and external custom objects can't be pulled whole.
        salesforceSObjectSummary({ name: 'Telemetry__b', custom: true }),
        salesforceSObjectSummary({ name: 'Erp_Order__x', custom: true }),
        // A custom object's system companions are flagged custom too, but aren't user-facing.
        salesforceSObjectSummary({ name: 'Invoice__Share', custom: true, layoutable: false }),
        salesforceSObjectSummary({ name: 'Invoice__History', custom: true, layoutable: false }),
        salesforceSObjectSummary({ name: 'Invoice__Feed', custom: true, layoutable: false }),
        salesforceSObjectSummary({ name: 'Region_Setting__mdt', custom: true }),
      ]);

      const tables = await makeConnector().listTables();
      expect(tables.map((table) => [table.parentPath, table.id.remoteId[0], table.id.wsId])).toEqual([
        ['Core CRM objects', 'Account', 'account'],
        ['Core CRM objects', 'Contact', 'contact'],
        ['Core CRM objects', 'Note', 'note'],
        ['Custom objects', 'Invoice__c', 'invoice__c'],
        ['Other standard objects', 'BusinessHours', 'businesshours'],
      ]);
      expect(tables[0].displayName).toBe('Accounts');
    });

    it('flags the write operations Salesforce disallows', async () => {
      jest
        .spyOn(SalesforceApiClient.prototype, 'listSObjects')
        .mockResolvedValue([
          salesforceSObjectSummary({ name: 'Account' }),
          salesforceSObjectSummary({ name: 'UserRole', labelPlural: 'Roles', createable: false, deletable: false }),
        ]);
      const [account, userRole] = await makeConnector().listTables();
      expect(account.disabledCreates).toBeUndefined();
      expect(account.disabledReason).toBeUndefined();
      expect(userRole.disabledCreates).toBe(true);
      expect(userRole.disabledUpdates).toBeUndefined();
      expect(userRole.disabledDeletes).toBe(true);
      expect(userRole.disabledReason).toBe(
        "Salesforce doesn't allow creating, deleting Roles records for this connection.",
      );
    });

    it('disables objects Salesforce only returns per parent record', async () => {
      jest
        .spyOn(SalesforceApiClient.prototype, 'listSObjects')
        .mockResolvedValue([
          salesforceSObjectSummary({ name: 'ContentDocumentLink', labelPlural: 'Content Document Links' }),
        ]);
      const [contentDocumentLink] = await makeConnector().listTables();
      expect(contentDocumentLink.disabled).toBe(true);
      expect(contentDocumentLink.disabledReason).toMatch(/one parent record at a time/);
    });
  });

  describe('pullRecordFiles', () => {
    const describeSpy = () =>
      jest.spyOn(SalesforceApiClient.prototype, 'describeSObject').mockResolvedValue(ACCOUNT_DESCRIBE);

    async function pull(
      progress: SalesforceDownloadProgress,
      options: { pullMode?: 'full' | 'incremental'; since?: Date } = {},
    ) {
      const batches: { files: ConnectorFile[]; connectorProgress?: SalesforceDownloadProgress }[] = [];
      const result = await makeConnector().pullRecordFiles(
        accountTableSpec(),
        (batch) => {
          batches.push(batch);
          return Promise.resolve();
        },
        progress,
        options,
      );
      return { batches, result };
    }

    it('queries every field in Id order and follows nextRecordsUrl, checkpointing the last record of each batch', async () => {
      describeSpy();
      const querySpy = jest
        .spyOn(SalesforceApiClient.prototype, 'query')
        .mockResolvedValue(
          queryBatch(
            [accountRecord(ACCOUNT_1, 'A'), accountRecord(ACCOUNT_2, 'B')],
            '/services/data/v66.0/query/01g-2000',
          ),
        );
      const queryMoreSpy = jest
        .spyOn(SalesforceApiClient.prototype, 'queryMore')
        .mockResolvedValue(queryBatch([accountRecord(ACCOUNT_3, 'C')]));

      const { batches, result } = await pull({});

      expect(querySpy).toHaveBeenCalledWith(
        `SELECT ${ACCOUNT_DESCRIBE.fields.map((field) => field.name).join(',')} FROM Account ORDER BY Id`,
      );
      expect(queryMoreSpy).toHaveBeenCalledWith('/services/data/v66.0/query/01g-2000');
      // Records are passed through exactly as Salesforce returned them.
      expect(batches.map((batch) => batch.files)).toEqual([
        [accountRecord(ACCOUNT_1, 'A'), accountRecord(ACCOUNT_2, 'B')],
        [accountRecord(ACCOUNT_3, 'C')],
      ]);
      expect(batches.map((batch) => batch.connectorProgress?.lastPulledRecordId)).toEqual([ACCOUNT_2, ACCOUNT_3]);
      expect(result).toEqual({});
    });

    it('resumes after the last checkpointed record', async () => {
      describeSpy();
      const querySpy = jest.spyOn(SalesforceApiClient.prototype, 'query').mockResolvedValue(queryBatch([]));
      await pull({ lastPulledRecordId: ACCOUNT_2 });
      expect(querySpy.mock.calls[0][0]).toMatch(
        new RegExp(`FROM Account WHERE \\(Id > '${ACCOUNT_2}'\\) ORDER BY Id$`),
      );
    });

    it('filters an incremental pull by SystemModstamp minus the clock-skew margin, and returns its start as the watermark', async () => {
      describeSpy();
      const querySpy = jest.spyOn(SalesforceApiClient.prototype, 'query').mockResolvedValue(queryBatch([]));
      const before = Date.now();
      const { result } = await pull({}, { pullMode: 'incremental', since: new Date('2026-10-27T10:00:00.000Z') });
      expect(querySpy.mock.calls[0][0]).toMatch(/WHERE \(SystemModstamp > 2026-10-27T09:59:00Z\) ORDER BY Id$/);
      expect(result.newWatermark?.getTime()).toBeGreaterThanOrEqual(before);
    });

    it('keeps the original watermark across a resumed incremental pull', async () => {
      describeSpy();
      jest.spyOn(SalesforceApiClient.prototype, 'query').mockResolvedValue(queryBatch([accountRecord(ACCOUNT_3, 'C')]));
      const { batches, result } = await pull(
        { lastPulledRecordId: ACCOUNT_2, pullWatermark: '2026-10-27T11:00:00.000Z' },
        { pullMode: 'incremental', since: new Date('2026-10-27T10:00:00.000Z') },
      );
      expect(batches[0].connectorProgress).toEqual({
        lastPulledRecordId: ACCOUNT_3,
        pullWatermark: '2026-10-27T11:00:00.000Z',
      });
      expect(result.newWatermark).toEqual(new Date('2026-10-27T11:00:00.000Z'));
    });
  });

  describe('incrementalPullSupport', () => {
    it('is supported when the schema has a last-modified field, and optimistically when there is no schema yet', () => {
      const connector = makeConnector();
      expect(connector.incrementalPullSupport({}, accountTableSpec())).toBe(IncrementalPullSupport.SUPPORTED);
      expect(connector.incrementalPullSupport({}, null)).toBe(IncrementalPullSupport.SUPPORTED);
    });
  });

  describe('createRecords', () => {
    it('creates all-or-none, then returns each record as Salesforce read it back', async () => {
      const createSpy = jest.spyOn(SalesforceApiClient.prototype, 'createRecords').mockResolvedValue([
        { id: ACCOUNT_1, success: true, errors: [] },
        { id: ACCOUNT_2, success: true, errors: [] },
      ]);
      jest.spyOn(SalesforceApiClient.prototype, 'describeSObject').mockResolvedValue(ACCOUNT_DESCRIBE);
      jest
        .spyOn(SalesforceApiClient.prototype, 'query')
        .mockResolvedValue(
          queryBatch([accountRecord(ACCOUNT_2, 'B (read back)'), accountRecord(ACCOUNT_1, 'A (read back)')]),
        );

      const created = await makeConnector().createRecords(accountTableSpec(), [{ Name: 'A' }, { Name: 'B' }]);

      expect(createSpy).toHaveBeenCalledWith([
        { attributes: { type: 'Account' }, Name: 'A' },
        { attributes: { type: 'Account' }, Name: 'B' },
      ]);
      expect(created.map((record) => record.Name)).toEqual(['A (read back)', 'B (read back)']);
    });

    it('still returns the new ids when the read-back after a successful create fails', async () => {
      jest.spyOn(SalesforceApiClient.prototype, 'createRecords').mockResolvedValue([
        { id: ACCOUNT_1, success: true, errors: [] },
        { id: ACCOUNT_2, success: true, errors: [] },
      ]);
      jest.spyOn(SalesforceApiClient.prototype, 'describeSObject').mockResolvedValue(ACCOUNT_DESCRIBE);
      jest.spyOn(SalesforceApiClient.prototype, 'query').mockRejectedValue(new Error('socket hang up'));

      const created = await makeConnector().createRecords(accountTableSpec(), [{ Name: 'A' }, { Name: 'B' }]);

      expect(created).toEqual([
        { Name: 'A', Id: ACCOUNT_1 },
        { Name: 'B', Id: ACCOUNT_2 },
      ]);
    });

    it('reports only the records that caused a rejected batch to roll back', async () => {
      jest.spyOn(SalesforceApiClient.prototype, 'createRecords').mockResolvedValue([
        {
          success: false,
          errors: [{ statusCode: 'ALL_OR_NONE_OPERATION_ROLLED_BACK', message: 'Record rolled back', fields: [] }],
        },
        {
          success: false,
          errors: [
            { statusCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing: [Name]', fields: ['Name'] },
          ],
        },
      ]);
      const querySpy = jest.spyOn(SalesforceApiClient.prototype, 'query');

      const createAttempt = makeConnector().createRecords(accountTableSpec(), [{ Name: 'A' }, {}]);
      await expect(createAttempt).rejects.toThrow(
        new SalesforceApiError('Record 2: Required fields are missing: [Name]', []),
      );
      expect(querySpy).not.toHaveBeenCalled();
    });
  });

  describe('updateRecords', () => {
    it("sends each record's changed fields and skips records with nothing to send", async () => {
      jest.spyOn(SalesforceApiClient.prototype, 'describeSObject').mockResolvedValue(ACCOUNT_DESCRIBE);
      const updateSpy = jest
        .spyOn(SalesforceApiClient.prototype, 'updateRecords')
        .mockResolvedValue([{ id: ACCOUNT_1, success: true, errors: [] }]);
      jest
        .spyOn(SalesforceApiClient.prototype, 'query')
        .mockResolvedValue(queryBatch([accountRecord(ACCOUNT_1, 'Renamed'), accountRecord(ACCOUNT_2, 'Unchanged')]));

      const updated = await makeConnector().updateRecords(
        accountTableSpec(),
        [accountRecord(ACCOUNT_1, 'A'), accountRecord(ACCOUNT_2, 'B')],
        [{ Name: 'Renamed' }, {}],
      );

      expect(updateSpy).toHaveBeenCalledWith([{ attributes: { type: 'Account' }, id: ACCOUNT_1, Name: 'Renamed' }]);
      expect(updated.map((record) => record.Name)).toEqual(['Renamed', 'Unchanged']);
    });
  });

  describe('deleteRecords', () => {
    it('treats an already-deleted record as deleted', async () => {
      jest.spyOn(SalesforceApiClient.prototype, 'deleteRecords').mockResolvedValue([
        { id: ACCOUNT_1, success: true, errors: [] },
        {
          id: ACCOUNT_2,
          success: false,
          errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'entity is deleted', fields: [] }],
        },
      ]);
      await expect(
        makeConnector().deleteRecords(accountTableSpec(), [{ Id: ACCOUNT_1 }, { Id: ACCOUNT_2 }]),
      ).resolves.toBeUndefined();
    });

    it('fails when Salesforce refuses a delete, naming the refused record', async () => {
      jest.spyOn(SalesforceApiClient.prototype, 'deleteRecords').mockResolvedValue([
        { id: ACCOUNT_1, success: true, errors: [] },
        {
          success: false,
          errors: [
            { statusCode: 'DELETE_FAILED', message: 'Your attempt to delete Acme could not be completed', fields: [] },
          ],
        },
      ]);
      await expect(
        makeConnector().deleteRecords(accountTableSpec(), [{ Id: ACCOUNT_1 }, { Id: ACCOUNT_2 }]),
      ).rejects.toThrow(
        new SalesforceApiError(`Record ${ACCOUNT_2}: Your attempt to delete Acme could not be completed`, []),
      );
    });
  });

  describe('extractConnectorErrorDetails', () => {
    const connector = makeConnector();

    it('reads the daily request limit as a quota problem, not a permissions problem', () => {
      const details = connector.extractConnectorErrorDetails(
        salesforceAxiosError(403, [{ errorCode: 'REQUEST_LIMIT_EXCEEDED', message: 'TotalRequests Limit exceeded.' }]),
      );
      expect(details.userFriendlyMessage).toBe(
        'You have exceeded the service API quota for Salesforce. TotalRequests Limit exceeded.',
      );
    });

    it("surfaces Salesforce's own error messages", () => {
      const details = connector.extractConnectorErrorDetails(
        salesforceAxiosError(400, [{ errorCode: 'MALFORMED_QUERY', message: 'unexpected token: FROM' }]),
      );
      expect(details.userFriendlyMessage).toBe('Salesforce error: unexpected token: FROM');
    });

    it('flags an edit to a deleted record as remote-record-not-found', () => {
      const details = connector.extractConnectorErrorDetails(
        new SalesforceApiError('entity is deleted', [
          { code: 'ENTITY_IS_DELETED', message: 'entity is deleted', fields: [] },
        ]),
      );
      expect(details.errorCode).toBe('remote_record_not_found');
    });

    it('leaves 401s to the shared credential handling', () => {
      const details = connector.extractConnectorErrorDetails(
        salesforceAxiosError(401, [{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired or invalid' }]),
      );
      expect(details.userFriendlyMessage).toMatch(/no longer valid/);
    });
  });
});
