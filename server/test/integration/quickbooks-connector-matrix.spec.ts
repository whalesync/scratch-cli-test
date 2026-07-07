/**
 * QuickBooks Online connector — full write matrix (live API).
 *
 * A data-driven create → edit → delete round-trip for **every writable entity**
 * (20 of 23): 13 transactions (create/update/hard-delete) and 7 name-list
 * entities (create/update/deactivate). Plus CompanyInfo (update-only) and the
 * read-only gating on TaxCode/TaxRate. Each case:
 *   1. creates the record with its required fields + live FK refs (resolved from
 *      the sandbox's own sample data),
 *   2. edits one writable scalar and asserts it round-trips,
 *   3. deletes it via the entity's family behavior and asserts the outcome
 *      (hard-deleted → gone; name-list → Active:false).
 *
 * Credentials + self-refresh live in `quickbooks-live-helpers`. Self-skips when
 * creds are absent. Run: `cd server && yarn test:integration -- quickbooks-connector-matrix`.
 */

// Break the connector → display-names circular import (mocks are per-file).
jest.mock('src/remote-service/connectors/display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import { QuickBooksConnector } from 'src/remote-service/connectors/library/quickbooks/quickbooks-connector';
import {
  ENTITY_WRITE_CAPABILITIES,
  QuickBooksEntityType,
} from 'src/remote-service/connectors/library/quickbooks/quickbooks-types';
import { BaseJsonTableSpec, ConnectorFile } from 'src/remote-service/connectors/types';
import {
  createConnector,
  fetchById,
  hasLiveCreds,
  queryFirstId,
  recordExistsViaQuery,
} from './quickbooks-live-helpers';

jest.setTimeout(300_000);

const RUN = Date.now();
let seq = 0;
// Short unique names: several name-list entities (PaymentMethod, Term) cap Name at
// 31 chars, so keep the marker terse rather than a long descriptive prefix.
const uniq = (label: string): string => `MTX ${label} ${RUN % 1_000_000}-${seq++}`;
const today = (): string => new Date(RUN).toISOString().slice(0, 10);

/** Live FK reference ids resolved from the sandbox once, shared by all cases. */
interface Refs {
  customer: string;
  vendor: string;
  item: string;
  employee: string;
  income: string;
  expense: string;
  bank: string;
  paymentBillId: string; // an unpaid Bill created in beforeAll for the BillPayment case
  paymentAmount: number;
}

// ── Line builders (QBO's per-detail-type line shapes) ──
const salesItemLine = (itemId: string, amount: number) => ({
  Amount: amount,
  DetailType: 'SalesItemLineDetail',
  SalesItemLineDetail: { ItemRef: { value: itemId } },
});
const acctExpenseLine = (accountId: string, amount: number) => ({
  Amount: amount,
  DetailType: 'AccountBasedExpenseLineDetail',
  AccountBasedExpenseLineDetail: { AccountRef: { value: accountId } },
});
const journalLine = (posting: 'Debit' | 'Credit', accountId: string, amount: number) => ({
  Amount: amount,
  DetailType: 'JournalEntryLineDetail',
  JournalEntryLineDetail: { PostingType: posting, AccountRef: { value: accountId } },
});
const depositLine = (accountId: string, amount: number) => ({
  Amount: amount,
  DetailType: 'DepositLineDetail',
  DepositLineDetail: { AccountRef: { value: accountId } },
});

interface EntityCase {
  entity: QuickBooksEntityType;
  /** Create payload with required fields + FK refs. */
  build: (r: Refs) => ConnectorFile;
  /** A writable scalar to edit and assert round-trips. */
  editKey: string;
  /** New value; a function receives the record id (for fields that must stay unique, e.g. Name). */
  editValue: string | ((id: string) => string);
  /** Set to skip with a documented reason (keeps the gap visible in test output). */
  skip?: string;
}

const CASES: EntityCase[] = [
  // ── Name-list entities (create + update + deactivate) ──
  {
    entity: 'Customer',
    build: () => ({ DisplayName: uniq('Customer') }),
    editKey: 'CompanyName',
    editValue: 'Edited Co',
  },
  { entity: 'Vendor', build: () => ({ DisplayName: uniq('Vendor') }), editKey: 'CompanyName', editValue: 'Edited Co' },
  {
    entity: 'Employee',
    build: () => ({ GivenName: 'Test', FamilyName: uniq('Emp') }),
    editKey: 'PrintOnCheckName',
    editValue: 'Edited Name',
  },
  {
    entity: 'Item',
    build: (r) => ({ Name: uniq('Item'), Type: 'Service', IncomeAccountRef: { value: r.income } }),
    editKey: 'Description',
    editValue: 'Edited description',
  },
  {
    entity: 'Account',
    build: () => ({ Name: uniq('Account'), AccountType: 'Expense' }),
    editKey: 'Description',
    editValue: 'Edited description',
  },
  {
    entity: 'PaymentMethod',
    build: () => ({ Name: uniq('PM') }),
    editKey: 'Name',
    editValue: (id) => `MTX PM ren ${id}`,
  },
  {
    entity: 'Term',
    build: () => ({ Name: uniq('Term'), DueDays: 30 }),
    editKey: 'Name',
    editValue: (id) => `MTX Term ren ${id}`,
  },

  // ── Transaction entities (create + update + hard-delete) ──
  {
    entity: 'Invoice',
    build: (r) => ({ CustomerRef: { value: r.customer }, Line: [salesItemLine(r.item, 100)] }),
    editKey: 'PrivateNote',
    editValue: 'Edited note',
  },
  {
    entity: 'Estimate',
    build: (r) => ({ CustomerRef: { value: r.customer }, Line: [salesItemLine(r.item, 100)] }),
    editKey: 'PrivateNote',
    editValue: 'Edited note',
  },
  {
    entity: 'SalesReceipt',
    build: (r) => ({ CustomerRef: { value: r.customer }, Line: [salesItemLine(r.item, 100)] }),
    editKey: 'PrivateNote',
    editValue: 'Edited note',
  },
  {
    entity: 'CreditMemo',
    build: (r) => ({ CustomerRef: { value: r.customer }, Line: [salesItemLine(r.item, 100)] }),
    editKey: 'PrivateNote',
    editValue: 'Edited note',
  },
  {
    entity: 'RefundReceipt',
    build: (r) => ({
      CustomerRef: { value: r.customer },
      DepositToAccountRef: { value: r.bank },
      Line: [salesItemLine(r.item, 25)],
    }),
    editKey: 'PrivateNote',
    editValue: 'Edited note',
  },
  {
    entity: 'Bill',
    build: (r) => ({ VendorRef: { value: r.vendor }, Line: [acctExpenseLine(r.expense, 50)] }),
    editKey: 'PrivateNote',
    editValue: 'Edited note',
  },
  {
    entity: 'Purchase',
    build: (r) => ({
      PaymentType: 'Cash',
      AccountRef: { value: r.bank },
      Line: [acctExpenseLine(r.expense, 50)],
    }),
    editKey: 'PrivateNote',
    editValue: 'Edited note',
  },
  {
    entity: 'PurchaseOrder',
    // Account-based line: the sandbox's sample Service item has no expense account,
    // so an item-based PO line can't resolve an account ("Select an account").
    build: (r) => ({ VendorRef: { value: r.vendor }, Line: [acctExpenseLine(r.expense, 50)] }),
    editKey: 'PrivateNote',
    editValue: 'Edited note',
  },
  {
    entity: 'JournalEntry',
    build: (r) => ({ Line: [journalLine('Debit', r.expense, 10), journalLine('Credit', r.bank, 10)] }),
    editKey: 'PrivateNote',
    editValue: 'Edited note',
  },
  {
    entity: 'Payment',
    build: (r) => ({ CustomerRef: { value: r.customer }, TotalAmt: 10 }),
    editKey: 'PrivateNote',
    editValue: 'Edited note',
  },
  {
    entity: 'BillPayment',
    build: (r) => ({
      VendorRef: { value: r.vendor },
      TotalAmt: r.paymentAmount,
      PayType: 'Check',
      CheckPayment: { BankAccountRef: { value: r.bank } },
      Line: [{ Amount: r.paymentAmount, LinkedTxn: [{ TxnId: r.paymentBillId, TxnType: 'Bill' }] }],
    }),
    editKey: 'PrivateNote',
    editValue: 'Edited note',
  },
  {
    entity: 'Deposit',
    build: (r) => ({ DepositToAccountRef: { value: r.bank }, Line: [depositLine(r.income, 20)] }),
    editKey: 'PrivateNote',
    editValue: 'Edited note',
  },
  {
    entity: 'TimeActivity',
    build: (r) => ({
      NameOf: 'Employee',
      EmployeeRef: { value: r.employee },
      TxnDate: today(),
      Hours: 1,
      Minutes: 30,
    }),
    editKey: 'Description',
    editValue: 'Edited description',
  },
];

const describeIfCreds = hasLiveCreds ? describe : describe.skip;

describeIfCreds('QuickBooksConnector — full write matrix', () => {
  let connector: QuickBooksConnector;
  let refs: Refs;
  const specByEntity = new Map<QuickBooksEntityType, BaseJsonTableSpec>();
  const createdForCleanup: { entity: QuickBooksEntityType; id: string }[] = [];

  async function getSpec(entity: QuickBooksEntityType): Promise<BaseJsonTableSpec> {
    const cached = specByEntity.get(entity);
    if (cached) return cached;
    const spec = await connector.fetchJsonTableSpec({ wsId: entity.toLowerCase(), remoteId: [entity] });
    specByEntity.set(entity, spec);
    return spec;
  }

  beforeAll(async () => {
    connector = await createConnector();
    const [customer, vendor, item, employee, income, expense, bank] = await Promise.all([
      queryFirstId('Customer'),
      queryFirstId('Vendor'),
      queryFirstId('Item'),
      queryFirstId('Employee'),
      queryFirstId('Account', "AccountType = 'Income'"),
      queryFirstId('Account', "AccountType = 'Expense'"),
      queryFirstId('Account', "AccountType = 'Bank'"),
    ]);

    // Create an unpaid Bill for the BillPayment case to link + pay.
    const paymentAmount = 25;
    const billSpec = await getSpec('Bill');
    const [bill] = await connector.createRecords(billSpec, [
      { VendorRef: { value: vendor }, Line: [acctExpenseLine(expense, paymentAmount)] } as ConnectorFile,
    ]);
    const paymentBillId = String((bill as Record<string, unknown>).Id);
    createdForCleanup.push({ entity: 'Bill', id: paymentBillId });

    refs = { customer, vendor, item, employee, income, expense, bank, paymentBillId, paymentAmount };
  });

  afterAll(async () => {
    // Best-effort cleanup (successful cases already deleted their own record).
    // Reverse order so a BillPayment is removed before the Bill it links to.
    for (const { entity, id } of [...createdForCleanup].reverse()) {
      const spec = specByEntity.get(entity);
      if (!spec) continue;
      await connector.deleteRecords(spec, [{ Id: id } as ConnectorFile]).catch(() => undefined);
    }
  });

  const runnable = CASES.filter((c) => !c.skip);
  const skipped = CASES.filter((c) => c.skip);

  it.each(runnable)('$entity: create → edit a field → delete round-trips', async (testCase) => {
    const { entity, build, editKey, editValue } = testCase;
    const spec = await getSpec(entity);

    // ── Create ──
    const [created] = await connector.createRecords(spec, [build(refs)]);
    const record = created as Record<string, unknown>;
    const id = String(record.Id);
    expect(id).toBeTruthy();
    createdForCleanup.push({ entity, id });

    // ── Edit one writable scalar via a sparse changedFields diff ──
    const value = typeof editValue === 'function' ? editValue(id) : editValue;
    const editedFile: ConnectorFile = { ...record, [editKey]: value };
    await connector.updateRecords(spec, [editedFile], [{ [editKey]: value }]);

    const afterEdit = await fetchById(connector, spec, id);
    expect(afterEdit).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(afterEdit![editKey]).toBe(value);

    // ── Delete per the entity's family behavior ──
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await connector.deleteRecords(spec, [afterEdit!]);
    if (ENTITY_WRITE_CAPABILITIES[entity].deleteBehavior === 'hardDeleteViaOperationParam') {
      expect(await recordExistsViaQuery(entity, id)).toBe(false); // permanently gone
    } else {
      const afterDelete = await fetchById(connector, spec, id);
      expect(afterDelete).not.toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(afterDelete!.Active).toBe(false); // deactivated, not deleted
    }
  });

  // Surface intentionally-skipped entities in the test output (no silent gaps).
  for (const c of skipped) {
    it.skip(`${c.entity}: skipped — ${c.skip}`, () => undefined);
  }
});

// ===========================================================================
// Non-CRUD tables: CompanyInfo (update-only) + read-only gating (TaxCode/TaxRate)
// ===========================================================================

describeIfCreds('QuickBooksConnector — update-only + read-only tables', () => {
  let connector: QuickBooksConnector;

  beforeAll(async () => {
    connector = await createConnector();
  });

  it('CompanyInfo: updates a field and rejects create/delete', async () => {
    const spec = await connector.fetchJsonTableSpec({ wsId: 'companyinfo', remoteId: ['CompanyInfo'] });
    const companyId = await queryFirstId('CompanyInfo');
    const current = await fetchById(connector, spec, companyId);
    expect(current).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const originalName = current!.CompanyName as string;

    // Edit a writable scalar, then revert it.
    const newName = `MTX Co ${RUN}`;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await connector.updateRecords(spec, [{ ...current! }], [{ CompanyName: newName }]);
    const afterEdit = await fetchById(connector, spec, companyId);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(afterEdit!.CompanyName).toBe(newName);

    // Revert to the original name.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await connector.updateRecords(spec, [{ ...afterEdit! }], [{ CompanyName: originalName }]);

    // Create + delete are unsupported for the singleton.
    await expect(connector.createRecords(spec, [{}])).rejects.toThrow(/not supported/i);
    await expect(connector.deleteRecords(spec, [{ Id: companyId } as ConnectorFile])).rejects.toThrow(/not supported/i);
  });

  it.each(['TaxCode', 'TaxRate'] as QuickBooksEntityType[])('%s: rejects all writes (read-only)', async (entity) => {
    const spec = await connector.fetchJsonTableSpec({ wsId: entity.toLowerCase(), remoteId: [entity] });
    await expect(connector.createRecords(spec, [{}])).rejects.toThrow(/not supported/i);
    await expect(connector.updateRecords(spec, [{ Id: '1' }], [{}])).rejects.toThrow(/not supported/i);
    await expect(connector.deleteRecords(spec, [{ Id: '1' } as ConnectorFile])).rejects.toThrow(/not supported/i);
  });
});
