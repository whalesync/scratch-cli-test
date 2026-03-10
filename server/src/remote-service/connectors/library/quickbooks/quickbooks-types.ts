/**
 * Types for the QuickBooks Online API connector.
 *
 * QuickBooks Online is Intuit's cloud-based accounting platform.
 * API Documentation: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities
 */

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
 * Credentials required to make QuickBooks API calls.
 */
export interface QuickBooksCredentials {
  accessToken: string;
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
