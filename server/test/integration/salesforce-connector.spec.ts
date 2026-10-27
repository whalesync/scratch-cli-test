/**
 * Salesforce connector live API integration test.
 *
 * Exercises the real Salesforce REST API through the actual SalesforceConnector: mints an access token with the
 * OAuth password grant, lists the org's objects, builds schemas from live describes, pulls records (full,
 * resumed, incremental, by id) and checks each stored record is exactly what Salesforce's single-record read
 * returns, then runs create → update → delete round-trips on a standard object (Contact) and a custom object
 * (Entities__c) carrying one value of each writable field type.
 *
 * Requires SALESFORCE_TEST_CLIENT_ID / SALESFORCE_TEST_CLIENT_SECRET / SALESFORCE_TEST_USERNAME /
 * SALESFORCE_TEST_PASSWORD (+ optional SALESFORCE_TEST_LOGIN_HOST) in server/.env.integration — the connected
 * app must allow the username-password flow. Every record the suite creates is named with NAME_PREFIX and
 * deleted in afterAll; leftovers from an interrupted run can be found by that prefix.
 *
 * Run via: cd server && yarn test:integration -- salesforce-connector
 */

// Break the circular import chain: connector.ts → display-names.ts → registry →
// every connector → connector.ts (same shim the other live connector tests use).
jest.mock('src/remote-service/connectors/display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import {
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_LAST_MODIFIED_FIELD,
  X_SCRATCH_READONLY,
  type TableViewBannerGroup,
  type TableViewCol,
} from '@spinner/shared-types';
import axios from 'axios';
import { NonWritableFieldEditError } from 'src/remote-service/connectors/error';
import { SalesforceApiError } from 'src/remote-service/connectors/library/salesforce/salesforce-api-client';
import { SalesforceConnector } from 'src/remote-service/connectors/library/salesforce/salesforce-connector';
import {
  SALESFORCE_API_VERSION,
  SALESFORCE_PRODUCTION_LOGIN_HOST,
} from 'src/remote-service/connectors/library/salesforce/salesforce-types';
import {
  BaseJsonTableSpec,
  ConnectorFile,
  PullRecordFilesResult,
  TablePreview,
} from 'src/remote-service/connectors/types';

jest.setTimeout(180_000);

const CLIENT_ID = process.env.SALESFORCE_TEST_CLIENT_ID;
const CLIENT_SECRET = process.env.SALESFORCE_TEST_CLIENT_SECRET;
const USERNAME = process.env.SALESFORCE_TEST_USERNAME;
const PASSWORD = process.env.SALESFORCE_TEST_PASSWORD;
const LOGIN_HOST = process.env.SALESFORCE_TEST_LOGIN_HOST ?? SALESFORCE_PRODUCTION_LOGIN_HOST;

const HAS_CREDS = Boolean(CLIENT_ID && CLIENT_SECRET && USERNAME && PASSWORD);
const describeIfCreds = HAS_CREDS ? describe : describe.skip;

const NAME_PREFIX = 'ScratchIT';

interface PasswordGrantSession {
  accessToken: string;
  instanceUrl: string;
}

async function mintPasswordGrantSession(): Promise<PasswordGrantSession> {
  const response = await axios.post<{ access_token: string; instance_url: string }>(
    `https://${LOGIN_HOST}/services/oauth2/token`,
    new URLSearchParams({
      grant_type: 'password',
      client_id: CLIENT_ID ?? '',
      client_secret: CLIENT_SECRET ?? '',
      username: USERNAME ?? '',
      password: PASSWORD ?? '',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return { accessToken: response.data.access_token, instanceUrl: response.data.instance_url };
}

/** A raw REST call outside the connector, for checking what the connector stored against what Salesforce has. */
async function salesforceRestGet<T>(session: PasswordGrantSession, pathAfterVersion: string): Promise<T> {
  const response = await axios.get<T>(
    `${session.instanceUrl}/services/data/${SALESFORCE_API_VERSION}/${pathAfterVersion}`,
    { headers: { Authorization: `Bearer ${session.accessToken}` } },
  );
  return response.data;
}

async function soqlCount(session: PasswordGrantSession, soqlWithoutSelect: string): Promise<number> {
  const result = await salesforceRestGet<{ totalSize: number }>(
    session,
    `query/?q=${encodeURIComponent(`SELECT COUNT() ${soqlWithoutSelect}`)}`,
  );
  return result.totalSize;
}

async function pullAll(
  connector: SalesforceConnector,
  spec: BaseJsonTableSpec,
  options: { lastPulledRecordId?: string; since?: Date } = {},
): Promise<{ files: ConnectorFile[]; result: PullRecordFilesResult; progressCheckpoints: (string | undefined)[] }> {
  const files: ConnectorFile[] = [];
  const progressCheckpoints: (string | undefined)[] = [];
  const result = await connector.pullRecordFiles(
    spec,
    ({ files: batch, connectorProgress }) => {
      files.push(...batch);
      progressCheckpoints.push(connectorProgress?.lastPulledRecordId);
      return Promise.resolve();
    },
    options.lastPulledRecordId ? { lastPulledRecordId: options.lastPulledRecordId } : {},
    options.since ? { pullMode: 'incremental', since: options.since } : { pullMode: 'full' },
  );
  return { files, result, progressCheckpoints };
}

function schemaProperty(spec: BaseJsonTableSpec, fieldApiName: string): Record<string, unknown> | undefined {
  return (spec.schema as unknown as { properties: Record<string, Record<string, unknown>> }).properties[fieldApiName];
}

describeIfCreds('SalesforceConnector — live API', () => {
  let session: PasswordGrantSession;
  let connector: SalesforceConnector;
  let tables: TablePreview[];
  const createdRecordIdsToCleanUp: { spec: BaseJsonTableSpec; id: string }[] = [];

  beforeAll(async () => {
    session = await mintPasswordGrantSession();
    connector = new SalesforceConnector(session.instanceUrl, session.accessToken);
    tables = await connector.listTables();
  });

  afterAll(async () => {
    for (const { spec, id } of createdRecordIdsToCleanUp) {
      await connector.deleteRecords(spec, [{ Id: id }]).catch(() => undefined);
    }
  });

  function tableFor(objectApiName: string): TablePreview {
    const table = tables.find((candidate) => candidate.id.remoteId[0] === objectApiName);
    if (!table) throw new Error(`Expected a ${objectApiName} table`);
    return table;
  }

  describe('discovery', () => {
    it('connects', async () => {
      await expect(connector.testConnection()).resolves.toBeUndefined();
    });

    it('lists core, custom, and other standard objects in that order, with lowercase wsIds', () => {
      const account = tableFor('Account');
      expect(account.id).toEqual({ wsId: 'account', remoteId: ['Account'] });
      expect(account.parentPath).toBe('Core CRM objects');
      expect(tableFor('Entities__c').parentPath).toBe('Custom objects');
      expect(tableFor('BusinessHours').parentPath).toBe('Other standard objects');

      const groupOrder = tables.map((table) => table.parentPath);
      expect(groupOrder.indexOf('Custom objects')).toBeGreaterThan(groupOrder.lastIndexOf('Core CRM objects'));
      expect(groupOrder.indexOf('Other standard objects')).toBeGreaterThan(groupOrder.lastIndexOf('Custom objects'));
    });

    it('disables objects Salesforce only returns per parent record', () => {
      const contentDocumentLink = tableFor('ContentDocumentLink');
      expect(contentDocumentLink.disabled).toBe(true);
      expect(contentDocumentLink.disabledReason).toMatch(/one parent record/);
    });

    it('keeps system objects like feeds and histories out of the picker', () => {
      expect(tables.find((table) => table.id.remoteId[0] === 'AccountHistory')).toBeUndefined();
      expect(tables.find((table) => table.id.remoteId[0] === 'AccountFeed')).toBeUndefined();
    });

    it('builds the Account schema from its live describe', async () => {
      const spec = await connector.fetchJsonTableSpec(tableFor('Account').id);
      expect(spec.idPath).toBe('Id');
      expect(spec.titlePath).toBe('Name');
      expect(spec.remoteWebUrl).toBe(`${session.instanceUrl}/lightning/o/Account/list`);
      expect(schemaProperty(spec, 'SystemModstamp')?.[X_SCRATCH_LAST_MODIFIED_FIELD]).toBe(true);
      expect(schemaProperty(spec, 'BillingAddress')?.[X_SCRATCH_READONLY]).toBe(true);
      expect(schemaProperty(spec, 'BillingCity')?.[X_SCRATCH_READONLY]).toBeUndefined();
      expect(schemaProperty(spec, 'ParentId')?.[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({
        linkedTableId: 'account',
        linkedTableRemoteId: ['Account'],
        isSingleValued: true,
      });
      // Polymorphic or not, OwnerId on Account points only at User.
      expect(schemaProperty(spec, 'OwnerId')?.[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual(
        expect.objectContaining({ linkedTableId: 'user' }),
      );
      expect((spec.schema as { required?: string[] }).required).toEqual(expect.arrayContaining(['Id', 'Name']));

      const view = connector.buildDefaultView(spec);
      expect((view.cols[0] as TableViewCol).path).toBe('Name');
    });

    it('leaves polymorphic lookups without a foreign key', async () => {
      const spec = await connector.fetchJsonTableSpec(tableFor('Entities__c').id);
      // Custom-object OwnerId points at User or Group.
      expect(schemaProperty(spec, 'OwnerId')?.[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toBeUndefined();
      expect(schemaProperty(spec, 'categories__c')?.[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual(
        expect.objectContaining({ linkedTableId: 'events__c', linkedTableRemoteId: ['Events__c'] }),
      );
      const view = connector.buildDefaultView(spec);
      const customFieldsGroup = view.cols.find(
        (col): col is TableViewBannerGroup => col.kind === 'banner-group' && col.name === 'Custom Fields',
      );
      expect(customFieldsGroup?.cols.map((col) => col.path)).toEqual(
        expect.arrayContaining(['date__c', 'datetime__c', 'currency__c']),
      );
    });
  });

  describe('pull', () => {
    let accountSpec: BaseJsonTableSpec;

    beforeAll(async () => {
      accountSpec = await connector.fetchJsonTableSpec(tableFor('Account').id);
    });

    it('pulls every Account, each record exactly as Salesforce reads it back on its own', async () => {
      const { files, result, progressCheckpoints } = await pullAll(connector, accountSpec);
      expect(result).toEqual({});
      expect(files.length).toBe(await soqlCount(session, 'FROM Account'));
      expect(files.length).toBeGreaterThan(1);

      const recordIds = files.map((file) => String(file.Id));
      expect([...recordIds].sort()).toEqual(recordIds.slice().sort());
      expect(progressCheckpoints[progressCheckpoints.length - 1]).toBe(recordIds[recordIds.length - 1]);

      // Connector Prime Directive: the stored record IS the single-record read, key for key, in the same order.
      const singleRecordRead = await salesforceRestGet<Record<string, unknown>>(
        session,
        `sobjects/Account/${recordIds[0]}`,
      );
      expect(files[0]).toEqual(singleRecordRead);
      expect(Object.keys(files[0])).toEqual(Object.keys(singleRecordRead));
    });

    it('resumes after the last pulled record', async () => {
      const { files: everyAccount } = await pullAll(connector, accountSpec);
      const firstRecordId = String(everyAccount[0].Id);
      const { files: resumed } = await pullAll(connector, accountSpec, { lastPulledRecordId: firstRecordId });
      expect(resumed.map((file) => file.Id)).toEqual(everyAccount.slice(1).map((file) => file.Id));
    });

    it('pulls incrementally by SystemModstamp and returns a watermark taken before the first request', async () => {
      const pullStartedAt = Date.now();
      const { files, result } = await pullAll(connector, accountSpec, { since: new Date('2100-01-01T00:00:00Z') });
      expect(files).toEqual([]);
      expect(result.newWatermark?.getTime()).toBeGreaterThanOrEqual(pullStartedAt - 1000);
      expect(result.newWatermark?.getTime()).toBeLessThanOrEqual(Date.now());

      const { files: modifiedSinceEpoch } = await pullAll(connector, accountSpec, {
        since: new Date('2000-01-01T00:00:00Z'),
      });
      expect(modifiedSinceEpoch.length).toBe(await soqlCount(session, 'FROM Account'));
    });

    it('pulls specific records by id and silently skips ids that no longer exist', async () => {
      const { files: everyAccount } = await pullAll(connector, accountSpec);
      const wantedRecordIds = everyAccount.slice(0, 2).map((file) => String(file.Id));
      const pulled: ConnectorFile[] = [];
      await connector.pullRecordFilesByIds(accountSpec, [...wantedRecordIds, '001000000000000AAA'], ({ files }) => {
        pulled.push(...files);
        return Promise.resolve();
      });
      expect(pulled.map((file) => file.Id).sort()).toEqual(wantedRecordIds.sort());
    });

    it('pulls a wide object whose query is too long for a GET request', async () => {
      const permissionSetLicenseTable = tables.find((table) => table.id.remoteId[0] === 'PermissionSetLicense');
      if (!permissionSetLicenseTable) return;
      const spec = await connector.fetchJsonTableSpec(permissionSetLicenseTable.id);
      const { files } = await pullAll(connector, spec);
      expect(files.length).toBe(await soqlCount(session, 'FROM PermissionSetLicense'));
    });
  });

  describe('write round-trips', () => {
    let contactSpec: BaseJsonTableSpec;
    let entitySpec: BaseJsonTableSpec;
    let someAccountId: string;

    beforeAll(async () => {
      contactSpec = await connector.fetchJsonTableSpec(tableFor('Contact').id);
      entitySpec = await connector.fetchJsonTableSpec(tableFor('Entities__c').id);
      const { files } = await pullAll(connector, await connector.fetchJsonTableSpec(tableFor('Account').id));
      someAccountId = String(files[0].Id);
    });

    it('creates, updates (including a lookup and a clear) and deletes a Contact', async () => {
      const [created] = await connector.createRecords(contactSpec, [
        {
          FirstName: 'Ada',
          LastName: `${NAME_PREFIX} Lovelace`,
          Email: 'ada@example.com',
          Birthdate: '1815-12-10',
          MailingCity: 'London',
          AccountId: someAccountId,
          // A null read-only field carries nothing to create and must not fail the create.
          CreatedDate: null,
        },
      ]);
      const createdId = String(created.Id);
      createdRecordIdsToCleanUp.push({ spec: contactSpec, id: createdId });

      // The returned record is the read-back, with Salesforce-computed values.
      const createdAttributes = created.attributes as { type: string; url: string };
      expect(createdAttributes.type).toBe('Contact');
      expect(createdAttributes.url).toContain(createdId);
      expect(created.Name).toBe(`Ada ${NAME_PREFIX} Lovelace`);
      expect(created.MailingAddress).toEqual(expect.objectContaining({ city: 'London' }));
      expect(created.AccountId).toBe(someAccountId);
      expect(created.CreatedDate).toEqual(expect.any(String));

      const [updated] = await connector.updateRecords(
        contactSpec,
        [created],
        [{ Title: 'Countess', MailingCity: null, AccountId: null }],
      );
      expect(updated.Title).toBe('Countess');
      expect(updated.MailingCity).toBeNull();
      expect(updated.AccountId).toBeNull();
      expect(updated.Email).toBe('ada@example.com');

      const readBack = await salesforceRestGet<Record<string, unknown>>(session, `sobjects/Contact/${createdId}`);
      expect(readBack.Title).toBe('Countess');

      await connector.deleteRecords(contactSpec, [updated]);
      expect(await soqlCount(session, `FROM Contact WHERE Id = '${createdId}'`)).toBe(0);
      // Deleting an already-deleted record is a success.
      await expect(connector.deleteRecords(contactSpec, [updated])).resolves.toBeUndefined();
    });

    it('round-trips every writable field type on a custom object', async () => {
      const writableValues = {
        Name: `${NAME_PREFIX} entity`,
        date__c: '2026-10-27',
        datetime__c: '2026-10-27T09:15:30.000+0000',
        number__c: 42.5,
        percent__c: 12.5,
        currency__c: 1999.99,
        longtext__c: 'Line one\nLine two 🎉',
        email__c: 'entity@example.com',
        url__c: 'www.example.com/path',
        singleselect__c: 'First',
        boolean__c: true,
        phonenumber__c: '(555) 010-0000',
        slug__c: 'scratch-it-entity',
      };
      const [created] = await connector.createRecords(entitySpec, [writableValues]);
      createdRecordIdsToCleanUp.push({ spec: entitySpec, id: String(created.Id) });
      expect(created).toEqual(expect.objectContaining(writableValues));

      const changedValues = {
        date__c: '2027-01-01',
        datetime__c: '2027-01-01T00:00:00.000+0000',
        number__c: -3,
        boolean__c: false,
        singleselect__c: 'a value that is not a defined option',
        longtext__c: null,
      };
      const [updated] = await connector.updateRecords(entitySpec, [created], [changedValues]);
      expect(updated).toEqual(expect.objectContaining({ ...writableValues, ...changedValues }));
      await connector.deleteRecords(entitySpec, [updated]);
    });

    it('refuses a read-only field edit instead of dropping it', async () => {
      const { files } = await pullAll(connector, contactSpec);
      await expect(
        connector.updateRecords(contactSpec, [files[0]], [{ CreatedDate: '2020-01-01T00:00:00.000+0000' }]),
      ).rejects.toThrow(NonWritableFieldEditError);
      await expect(
        connector.updateRecords(contactSpec, [files[0]], [{ MailingAddress: { city: 'Paris' } }]),
      ).rejects.toThrow(/"MailingAddress" is read-only/);
    });

    it('creates nothing when one record of a batch is rejected, and names the rejected record', async () => {
      const lastNameOfValidRecord = `${NAME_PREFIX} batch ${Date.now()}`;
      const createAttempt = connector.createRecords(contactSpec, [
        { LastName: lastNameOfValidRecord },
        { FirstName: 'NoLastName' },
      ]);
      await expect(createAttempt).rejects.toThrow(SalesforceApiError);
      await expect(createAttempt).rejects.toThrow(/Record 2: Required fields are missing: \[LastName\]/);
      expect(await soqlCount(session, `FROM Contact WHERE LastName = '${lastNameOfValidRecord}'`)).toBe(0);
    });

    it('reports an edit to a deleted record as remote-record-not-found', async () => {
      const [created] = await connector.createRecords(contactSpec, [{ LastName: `${NAME_PREFIX} doomed` }]);
      await connector.deleteRecords(contactSpec, [created]);
      const updateError = await connector
        .updateRecords(contactSpec, [created], [{ Title: 'Ghost' }])
        .catch((error: unknown) => error);
      expect(updateError).toBeInstanceOf(SalesforceApiError);
      expect(connector.extractConnectorErrorDetails(updateError).errorCode).toBe('remote_record_not_found');
    });
  });
});
