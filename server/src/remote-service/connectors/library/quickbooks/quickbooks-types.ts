/**
 * Types for the QuickBooks Online API connector.
 *
 * QuickBooks Online is Intuit's cloud-based accounting platform.
 * API Documentation: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities
 */

import { ConnectorAuthTokenOrProvider } from '../../connector-auth-token';

/**
 * Supported QuickBooks Online entity types.
 * These are queryable via the QBO SQL-like query: SELECT * FROM <EntityType>
 */
export type QuickBooksEntityType =
  | 'Account'
  | 'Bill'
  | 'BillPayment'
  | 'CompanyInfo'
  | 'CreditMemo'
  | 'Customer'
  | 'Deposit'
  | 'Employee'
  | 'Estimate'
  | 'Invoice'
  | 'Item'
  | 'JournalEntry'
  | 'Payment'
  | 'PaymentMethod'
  | 'Purchase'
  | 'PurchaseOrder'
  | 'RefundReceipt'
  | 'SalesReceipt'
  | 'TaxCode'
  | 'TaxRate'
  | 'Term'
  | 'TimeActivity'
  | 'Vendor';

/**
 * Configuration for each entity type.
 */
export interface QuickBooksEntityConfig {
  displayName: string;
  description: string;
  titleField: string;
}

/**
 * Entity configuration map.
 */
export const ENTITY_CONFIG: Record<QuickBooksEntityType, QuickBooksEntityConfig> = {
  Account: { displayName: 'Accounts', description: 'Chart of accounts', titleField: 'Name' },
  Bill: { displayName: 'Bills', description: 'Vendor bills', titleField: 'DocNumber' },
  BillPayment: { displayName: 'Bill Payments', description: 'Payments made on bills', titleField: 'DocNumber' },
  CompanyInfo: { displayName: 'Company Info', description: 'Company information', titleField: 'CompanyName' },
  CreditMemo: { displayName: 'Credit Memos', description: 'Customer credit memos', titleField: 'DocNumber' },
  Customer: { displayName: 'Customers', description: 'Customer records', titleField: 'DisplayName' },
  Deposit: { displayName: 'Deposits', description: 'Bank deposits', titleField: 'Id' },
  Employee: { displayName: 'Employees', description: 'Employee records', titleField: 'DisplayName' },
  Estimate: { displayName: 'Estimates', description: 'Customer estimates', titleField: 'DocNumber' },
  Invoice: { displayName: 'Invoices', description: 'Sales invoices', titleField: 'DocNumber' },
  Item: { displayName: 'Items', description: 'Products and services', titleField: 'Name' },
  JournalEntry: { displayName: 'Journal Entries', description: 'Manual journal entries', titleField: 'DocNumber' },
  Payment: { displayName: 'Payments', description: 'Customer payments', titleField: 'Id' },
  PaymentMethod: { displayName: 'Payment Methods', description: 'Payment method types', titleField: 'Name' },
  Purchase: { displayName: 'Purchases', description: 'Expense transactions', titleField: 'DocNumber' },
  PurchaseOrder: { displayName: 'Purchase Orders', description: 'Vendor purchase orders', titleField: 'DocNumber' },
  RefundReceipt: { displayName: 'Refund Receipts', description: 'Customer refunds', titleField: 'DocNumber' },
  SalesReceipt: { displayName: 'Sales Receipts', description: 'Cash sales', titleField: 'DocNumber' },
  TaxCode: { displayName: 'Tax Codes', description: 'Tax code definitions', titleField: 'Name' },
  TaxRate: { displayName: 'Tax Rates', description: 'Tax rate definitions', titleField: 'Name' },
  Term: { displayName: 'Terms', description: 'Payment terms', titleField: 'Name' },
  TimeActivity: { displayName: 'Time Activities', description: 'Time tracking entries', titleField: 'Id' },
  Vendor: { displayName: 'Vendors', description: 'Vendor/supplier records', titleField: 'DisplayName' },
};

/**
 * All supported entity types as an array.
 */
export const ENTITY_TYPES: QuickBooksEntityType[] = Object.keys(ENTITY_CONFIG) as QuickBooksEntityType[];

/**
 * How a delete on a given entity is expressed against the QuickBooks API.
 *
 * QBO splits its entities into two families with fundamentally different delete
 * semantics, plus a handful that can't be deleted at all:
 * - `hardDeleteViaOperationParam` — **transaction** entities (Invoice, Bill,
 *   Payment, …) support a real, permanent delete: `POST /{entity}?operation=delete`
 *   with `{ Id, SyncToken }`. This is irreversible.
 * - `deactivateViaActiveFalse` — **name-list** entities (Customer, Vendor, Item,
 *   Account, …) cannot be hard-deleted. The API only lets you set `Active: false`
 *   (a sparse update), which hides the record but preserves it. This is reversible
 *   and honors "default to non-destructive, reversible actions".
 * - `notDeletable` — the `CompanyInfo` singleton and the read-only tax entities
 *   have no delete path at all.
 */
export type QuickBooksDeleteBehavior = 'hardDeleteViaOperationParam' | 'deactivateViaActiveFalse' | 'notDeletable';

/**
 * Per-entity write capabilities. Drives the entity-family routing in the
 * connector's create/update/delete methods so each operation either does the
 * right QBO call or fails fast with a clear "not supported for this entity"
 * message (rather than sending a request the API will reject opaquely).
 */
export interface QuickBooksWriteCapabilities {
  canCreate: boolean;
  canUpdate: boolean;
  deleteBehavior: QuickBooksDeleteBehavior;
}

/**
 * Write capabilities for every supported entity type.
 *
 * Derived from the QuickBooks Online Accounting API: 13 transaction entities
 * support full create/update/hard-delete; 7 name-list entities support
 * create/update and deactivate-only; `CompanyInfo` is an update-only singleton;
 * `TaxCode`/`TaxRate` are read-only here (writable only through the separate
 * `/taxservice` endpoint, which is out of scope for this connector).
 */
export const ENTITY_WRITE_CAPABILITIES: Record<QuickBooksEntityType, QuickBooksWriteCapabilities> = {
  // ── Transaction entities — full CRUD, permanent delete ──
  Bill: { canCreate: true, canUpdate: true, deleteBehavior: 'hardDeleteViaOperationParam' },
  BillPayment: { canCreate: true, canUpdate: true, deleteBehavior: 'hardDeleteViaOperationParam' },
  CreditMemo: { canCreate: true, canUpdate: true, deleteBehavior: 'hardDeleteViaOperationParam' },
  Deposit: { canCreate: true, canUpdate: true, deleteBehavior: 'hardDeleteViaOperationParam' },
  Estimate: { canCreate: true, canUpdate: true, deleteBehavior: 'hardDeleteViaOperationParam' },
  Invoice: { canCreate: true, canUpdate: true, deleteBehavior: 'hardDeleteViaOperationParam' },
  JournalEntry: { canCreate: true, canUpdate: true, deleteBehavior: 'hardDeleteViaOperationParam' },
  Payment: { canCreate: true, canUpdate: true, deleteBehavior: 'hardDeleteViaOperationParam' },
  Purchase: { canCreate: true, canUpdate: true, deleteBehavior: 'hardDeleteViaOperationParam' },
  PurchaseOrder: { canCreate: true, canUpdate: true, deleteBehavior: 'hardDeleteViaOperationParam' },
  RefundReceipt: { canCreate: true, canUpdate: true, deleteBehavior: 'hardDeleteViaOperationParam' },
  SalesReceipt: { canCreate: true, canUpdate: true, deleteBehavior: 'hardDeleteViaOperationParam' },
  TimeActivity: { canCreate: true, canUpdate: true, deleteBehavior: 'hardDeleteViaOperationParam' },
  // ── Name-list entities — create + update, deactivate-only (no hard delete) ──
  Account: { canCreate: true, canUpdate: true, deleteBehavior: 'deactivateViaActiveFalse' },
  Customer: { canCreate: true, canUpdate: true, deleteBehavior: 'deactivateViaActiveFalse' },
  Employee: { canCreate: true, canUpdate: true, deleteBehavior: 'deactivateViaActiveFalse' },
  Item: { canCreate: true, canUpdate: true, deleteBehavior: 'deactivateViaActiveFalse' },
  PaymentMethod: { canCreate: true, canUpdate: true, deleteBehavior: 'deactivateViaActiveFalse' },
  Term: { canCreate: true, canUpdate: true, deleteBehavior: 'deactivateViaActiveFalse' },
  Vendor: { canCreate: true, canUpdate: true, deleteBehavior: 'deactivateViaActiveFalse' },
  // ── Singleton — update only ──
  CompanyInfo: { canCreate: false, canUpdate: true, deleteBehavior: 'notDeletable' },
  // ── Read-only (writable only via the separate /taxservice endpoint — out of scope) ──
  TaxCode: { canCreate: false, canUpdate: false, deleteBehavior: 'notDeletable' },
  TaxRate: { canCreate: false, canUpdate: false, deleteBehavior: 'notDeletable' },
};

/**
 * Fields that QBO requires on **every sparse update** for certain entities, even
 * when they didn't change. Discovered via the live integration matrix: a Bill
 * sparse update that changes only `PrivateNote` is rejected with
 * `400 "Required parameter VendorRef is missing"`; Purchase likewise needs
 * `PaymentType` + `AccountRef`, and Deposit needs `DepositToAccountRef`. The
 * connector carries these from the record file into the sparse payload so an edit
 * to any field on these entities still publishes.
 *
 * Most entities (Invoice, Estimate, Customer, …) accept a minimal sparse update
 * and so have no entry here. This is deliberately a small, empirically-verified
 * allow-list rather than "re-send everything", to keep the payload minimal and
 * avoid re-sending fields whose read shape differs from their write shape.
 */
export const ENTITY_REQUIRED_UPDATE_FIELDS: Partial<Record<QuickBooksEntityType, string[]>> = {
  Bill: ['VendorRef'],
  Purchase: ['PaymentType', 'AccountRef'],
  Deposit: ['DepositToAccountRef'],
  // Without Type/DueDays, a Term sparse update fails with "Please select the day of
  // the month for 'Date-driven'" — QBO can't tell a standard term from a date-driven one.
  Term: ['Type', 'DueDays'],
};

/**
 * Starter templates for newly-created records, keyed by entity type. These seed
 * the minimum fields QBO requires on create so a brand-new record is closer to
 * publishable in the grid; the user still fills in concrete values (and any
 * foreign-key `value` ids). Entities without an entry start from a blank record
 * (the base connector default).
 *
 * Kept intentionally minimal — just the required-on-create fields per Intuit's
 * API reference — rather than a full example payload.
 */
export const ENTITY_NEW_FILE_TEMPLATES: Partial<Record<QuickBooksEntityType, Record<string, unknown>>> = {
  // Name-list: a single required display/name field.
  Customer: { DisplayName: '' },
  Vendor: { DisplayName: '' },
  Employee: { GivenName: '', FamilyName: '' },
  Item: { Name: '', Type: 'Service' },
  Account: { Name: '', AccountType: '' },
  PaymentMethod: { Name: '' },
  Term: { Name: '' },
  // Transactions: a parent ref plus at least one line (QBO rejects a line-less txn).
  Invoice: {
    CustomerRef: { value: '' },
    Line: [{ DetailType: 'SalesItemLineDetail', Amount: 0, SalesItemLineDetail: { ItemRef: { value: '' } } }],
  },
  Estimate: {
    CustomerRef: { value: '' },
    Line: [{ DetailType: 'SalesItemLineDetail', Amount: 0, SalesItemLineDetail: { ItemRef: { value: '' } } }],
  },
  SalesReceipt: {
    CustomerRef: { value: '' },
    Line: [{ DetailType: 'SalesItemLineDetail', Amount: 0, SalesItemLineDetail: { ItemRef: { value: '' } } }],
  },
  Bill: {
    VendorRef: { value: '' },
    Line: [
      {
        DetailType: 'AccountBasedExpenseLineDetail',
        Amount: 0,
        AccountBasedExpenseLineDetail: { AccountRef: { value: '' } },
      },
    ],
  },
  PurchaseOrder: {
    VendorRef: { value: '' },
    Line: [
      { DetailType: 'ItemBasedExpenseLineDetail', Amount: 0, ItemBasedExpenseLineDetail: { ItemRef: { value: '' } } },
    ],
  },
};

/**
 * Credentials required to make QuickBooks API calls.
 */
export interface QuickBooksCredentials {
  /**
   * A provider that returns the connection's currently valid OAuth access token
   * (a literal token is also accepted, for tests). QuickBooks access tokens last
   * an hour, so the client re-resolves this per request rather than baking one in
   * — a job that outlived the token otherwise 401'd for the rest of its run
   * (DEV-11270).
   */
  accessToken: ConnectorAuthTokenOrProvider;
  realmId: string;
}

/**
 * Progress state for resumable pulls.
 * Extends JsonSafeObject for compatibility with the Connector base class.
 */
export interface QuickBooksDownloadProgress {
  [key: string]: number | undefined;
  nextStartPosition?: number;
}

/**
 * QuickBooks API query response shape.
 */
export interface QuickBooksQueryResponse {
  QueryResponse: Record<string, unknown> & {
    startPosition?: number;
    maxResults?: number;
    totalCount?: number;
  };
}
