/**
 * QuickBooks Online connector live API integration test.
 *
 * Exercises the real QBO Accounting API: validates credentials, lists every
 * supported entity type as a table, builds a schema (with the read-only
 * annotations applied), and runs create → update → delete round-trips on the
 * Customer name-list entity.
 *
 * The centerpiece is the **sparse-update nested-container** case (the DEV-10653
 * review finding): QBO's `sparse: true` replaces each supplied top-level field
 * wholesale — it does NOT deep-merge nested objects. So editing a single sub-field
 * of an address must re-send the *entire* address, or QBO nulls the siblings. The
 * round-trip creates a Customer with a multi-field `BillAddr`, edits only `City`,
 * pulls the record back, and asserts `Line1`/`PostalCode` survived.
 *
 * Credentials live in `.env.integration` for a QBO **sandbox** company. Two ways
 * to supply the token (realm id is always required):
 *   - QUICKBOOKS_REALM_ID + QUICKBOOKS_ACCESS_TOKEN — a token minted by hand
 *     (expires ~1h), or
 *   - QUICKBOOKS_REALM_ID + QUICKBOOKS_CLIENT_ID + QUICKBOOKS_CLIENT_SECRET +
 *     QUICKBOOKS_REFRESH_TOKEN — the suite mints a fresh access token at startup
 *     via the OAuth token endpoint (refresh tokens roll ~100 days), so runs don't
 *     fight the 1h expiry. Optional QUICKBOOKS_SANDBOX=false to hit production.
 * This suite is not wired into the post-deploy CI pipeline (OAuth-only); it
 * self-skips when creds are absent (so CI stays green) and is run by hand:
 *
 *   cd server && yarn test:integration -- quickbooks-connector
 */

// Break the circular import chain: connector.ts → display-names.ts → all
// connectors → connector.ts (same shim the other live connector tests use).
jest.mock('src/remote-service/connectors/display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import { QuickBooksConnector } from 'src/remote-service/connectors/library/quickbooks/quickbooks-connector';
import { ENTITY_TYPES } from 'src/remote-service/connectors/library/quickbooks/quickbooks-types';
import { BaseJsonTableSpec, ConnectorFile, EntityId } from 'src/remote-service/connectors/types';
import {
  createConnector,
  fetchById,
  hasLiveCreds,
  queryFirstId,
  recordExistsViaQuery,
} from './quickbooks-live-helpers';

jest.setTimeout(120_000);

/** The entity the CRUD suite operates on. Customer is the safest name-list entity:
 * its only required create field is `DisplayName`, it carries the nested `BillAddr`
 * address we need for the regression, and its "delete" is a reversible deactivate. */
const CUSTOMER_ENTITY_ID: EntityId = { wsId: 'customer', remoteId: ['Customer'] };
const INVOICE_ENTITY_ID: EntityId = { wsId: 'invoice', remoteId: ['Invoice'] };

const TEST_NAME_PREFIX = 'Scratch integration test';

// Skip the whole suite unless a realm id plus a usable token source is configured.
const describeIfCreds = hasLiveCreds ? describe : describe.skip;

describeIfCreds('QuickBooksConnector — live API', () => {
  let connector: QuickBooksConnector;

  beforeAll(async () => {
    connector = await createConnector();
  });

  describe('testConnection', () => {
    it('authenticates against the sandbox company', async () => {
      await expect(connector.testConnection()).resolves.not.toThrow();
    });
  });

  describe('listTables', () => {
    it('lists every supported entity type', async () => {
      const tables = await connector.listTables();
      expect(tables).toHaveLength(ENTITY_TYPES.length);
      expect(tables.map((t) => t.id.remoteId[0])).toEqual(expect.arrayContaining(['Customer', 'Invoice', 'Vendor']));
    });
  });

  describe('fetchJsonTableSpec', () => {
    it('builds a Customer schema with computed/system fields marked read-only', async () => {
      const spec = await connector.fetchJsonTableSpec(CUSTOMER_ENTITY_ID);
      const properties = (spec.schema as { properties?: Record<string, Record<string, unknown>> }).properties ?? {};
      expect(properties.Balance?.['x-scratch-readonly']).toBe(true);
      expect(properties.SyncToken?.['x-scratch-readonly']).toBe(true);
    });
  });
});

// ===========================================================================
// CRUD round-trip (the sparse-update nested-container regression)
// ===========================================================================

describeIfCreds('QuickBooksConnector — CRUD round-trip', () => {
  let connector: QuickBooksConnector;
  let tableSpec: BaseJsonTableSpec;
  const createdCustomerIds: string[] = [];

  beforeAll(async () => {
    connector = await createConnector();
    tableSpec = await connector.fetchJsonTableSpec(CUSTOMER_ENTITY_ID);
  });

  afterAll(async () => {
    // Deactivate any customer this suite created (QBO can't hard-delete them).
    for (const id of createdCustomerIds) {
      await connector.deleteRecords(tableSpec, [{ Id: id } as ConnectorFile]).catch(() => undefined);
    }
  });

  it('creates a Customer, edits one address sub-field, and preserves the other address fields', async () => {
    const displayName = `${TEST_NAME_PREFIX} ${Date.now()}`;
    const originalAddr = { Line1: '123 Main St', City: 'Springfield', PostalCode: '11111' };

    // ── Create (with a multi-field nested BillAddr) ──
    const [created] = await connector.createRecords(tableSpec, [
      { DisplayName: displayName, BillAddr: { ...originalAddr } } as ConnectorFile,
    ]);
    const createdRecord = created as Record<string, unknown>;
    const id = String(createdRecord.Id);
    expect(id).toBeTruthy();
    createdCustomerIds.push(id);

    const createdAddr = createdRecord.BillAddr as Record<string, unknown>;
    expect(createdAddr.Line1).toBe(originalAddr.Line1);

    // ── Update ONLY BillAddr.City via a deep-sparse changedFields diff ──
    // `files[i]` is the full (edited) record; `changedFields[i]` is the sparse
    // diff — exactly what the publish pipeline passes. The connector must re-send
    // the entire BillAddr from the file so QBO doesn't null Line1/PostalCode.
    const editedFile: ConnectorFile = {
      ...createdRecord,
      BillAddr: { ...createdAddr, City: 'Shelbyville' },
    };
    await connector.updateRecords(tableSpec, [editedFile], [{ BillAddr: { City: 'Shelbyville' } }]);

    // ── Pull the record back and assert the siblings survived ──
    const afterUpdate = await fetchById(connector, tableSpec, id);
    expect(afterUpdate).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const updatedAddr = afterUpdate!.BillAddr as Record<string, unknown>;
    expect(updatedAddr.City).toBe('Shelbyville'); // the edit landed
    expect(updatedAddr.Line1).toBe(originalAddr.Line1); // sibling NOT nulled (the regression)
    expect(updatedAddr.PostalCode).toBe(originalAddr.PostalCode); // sibling NOT nulled
  });

  it('deactivates a Customer on delete (name-list entities are not hard-deletable)', async () => {
    const displayName = `${TEST_NAME_PREFIX} del ${Date.now()}`;
    const [created] = await connector.createRecords(tableSpec, [{ DisplayName: displayName } as ConnectorFile]);
    const id = String((created as Record<string, unknown>).Id);
    createdCustomerIds.push(id);

    await connector.deleteRecords(tableSpec, [created]);

    // The record still exists but is now inactive (deactivate, not hard-delete).
    const afterDelete = await fetchById(connector, tableSpec, id);
    expect(afterDelete).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(afterDelete!.Active).toBe(false);
  });
});

// ===========================================================================
// Transaction round-trip (the Line-array analog of the address regression,
// plus the hard-delete path — both untested against real QBO until now)
// ===========================================================================

describeIfCreds('QuickBooksConnector — transaction round-trip (Invoice)', () => {
  let connector: QuickBooksConnector;
  let tableSpec: BaseJsonTableSpec;
  let customerId: string;
  let itemId: string;
  const createdInvoiceIds: string[] = [];

  beforeAll(async () => {
    connector = await createConnector();
    tableSpec = await connector.fetchJsonTableSpec(INVOICE_ENTITY_ID);
    customerId = await queryFirstId('Customer');
    itemId = await queryFirstId('Item');
  });

  afterAll(async () => {
    for (const id of createdInvoiceIds) {
      await connector.deleteRecords(tableSpec, [{ Id: id } as ConnectorFile]).catch(() => undefined);
    }
  });

  it('edits one invoice line and preserves the other, then hard-deletes', async () => {
    const itemLine = (amount: number) => ({
      Amount: amount,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: itemId } },
    });

    // ── Create an invoice with two line items ──
    const [created] = await connector.createRecords(tableSpec, [
      { CustomerRef: { value: customerId }, Line: [itemLine(100), itemLine(50)] } as ConnectorFile,
    ]);
    const createdRecord = created as Record<string, unknown>;
    const id = String(createdRecord.Id);
    createdInvoiceIds.push(id);

    // QBO returns the lines with server-assigned Ids plus a trailing SubTotalLine.
    // Edit ONLY the first item line's amount; leave everything else as QBO stored it.
    const createdLines = (createdRecord.Line as Record<string, unknown>[]).map((line) => ({ ...line }));
    const itemLineIndexes = createdLines
      .map((line, index) => (line.DetailType === 'SalesItemLineDetail' ? index : -1))
      .filter((index) => index >= 0);
    expect(itemLineIndexes).toHaveLength(2);
    const siblingLineId = String(createdLines[itemLineIndexes[1]].Id);
    createdLines[itemLineIndexes[0]] = { ...createdLines[itemLineIndexes[0]], Amount: 111 };

    // The full (edited) record is `files[i]`; the sparse diff carries the Line array.
    // The connector must re-send the entire Line array so QBO doesn't drop the sibling.
    const editedFile: ConnectorFile = { ...createdRecord, Line: createdLines };
    await connector.updateRecords(tableSpec, [editedFile], [{ Line: createdLines }]);

    // ── Pull back: the edited line changed, the sibling line survived unchanged ──
    const afterUpdate = await fetchById(connector, tableSpec, id);
    expect(afterUpdate).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const updatedItemLines = (afterUpdate!.Line as Record<string, unknown>[]).filter(
      (line) => line.DetailType === 'SalesItemLineDetail',
    );
    expect(updatedItemLines).toHaveLength(2); // sibling line NOT dropped
    const editedLine = updatedItemLines.find((line) => Number(line.Amount) === 111);
    const siblingLine = updatedItemLines.find((line) => String(line.Id) === siblingLineId);
    expect(editedLine).toBeDefined(); // the edit landed
    expect(siblingLine).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(Number(siblingLine!.Amount)).toBe(50); // sibling amount preserved

    // ── Hard delete (transactions are permanently deletable) ──
    await connector.deleteRecords(tableSpec, [afterUpdate as ConnectorFile]);
    expect(await recordExistsViaQuery('Invoice', id)).toBe(false); // permanently gone (not just deactivated)
  });
});
