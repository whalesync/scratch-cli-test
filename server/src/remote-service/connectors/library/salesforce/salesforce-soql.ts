/**
 * SOQL construction for the Salesforce connector.
 *
 * Every name and value interpolated into a query is validated here first. Object and field API names come from
 * Salesforce's own describe, and record ids from stored records, but a SOQL string is still a query language: a
 * malformed id or name must fail loudly rather than change what the query selects.
 */

/** Object and field API names: a letter, then letters, digits and underscores (`Account`, `ns__Thing__c`). */
const SALESFORCE_API_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/** A Salesforce record id: 15 case-sensitive or 18 case-insensitive alphanumeric characters. */
const SALESFORCE_RECORD_ID_PATTERN = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

export function isSalesforceRecordId(value: string): boolean {
  return SALESFORCE_RECORD_ID_PATTERN.test(value);
}

function assertSalesforceApiName(apiName: string): string {
  if (!SALESFORCE_API_NAME_PATTERN.test(apiName)) {
    throw new Error(`"${apiName}" is not a valid Salesforce API name`);
  }
  return apiName;
}

function salesforceRecordIdLiteral(recordId: string): string {
  if (!isSalesforceRecordId(recordId)) {
    throw new Error(`"${recordId}" is not a valid Salesforce record id`);
  }
  return `'${recordId}'`;
}

/**
 * A SOQL datetime literal (`2026-10-27T09:15:00Z`). SOQL datetime literals are unquoted and documented without
 * fractional seconds, so the instant is truncated to the second.
 */
export function salesforceDateTimeLiteral(instant: Date): string {
  return instant.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** `Id IN ('…', '…')` for a targeted pull of specific records. */
export function recordIdIsOneOfPredicate(recordIds: string[]): string {
  if (recordIds.length === 0) {
    throw new Error('recordIdIsOneOfPredicate needs at least one record id');
  }
  return `Id IN (${recordIds.map(salesforceRecordIdLiteral).join(',')})`;
}

/** `Id > '…'`: resumes an `ORDER BY Id` pull after the last record it delivered. */
export function recordIdIsAfterPredicate(lastPulledRecordId: string): string {
  return `Id > ${salesforceRecordIdLiteral(lastPulledRecordId)}`;
}

/** `<field> > <datetime>`: the incremental pull's modified-since filter. */
export function fieldIsAfterInstantPredicate(datetimeFieldApiName: string, instant: Date): string {
  return `${assertSalesforceApiName(datetimeFieldApiName)} > ${salesforceDateTimeLiteral(instant)}`;
}

/**
 * `SELECT <every field> FROM <object> [WHERE …] [ORDER BY Id]`.
 *
 * Selecting every describe field returns each record in the same shape as Salesforce's single-record read
 * (`GET /sobjects/{object}/{id}`) — `attributes`, then every field in describe order, compound address/location
 * values included — which is the shape the connector stores.
 */
export function buildSelectEveryFieldQuery(params: {
  objectApiName: string;
  fieldApiNames: string[];
  wherePredicates: string[];
  orderByRecordId: boolean;
}): string {
  if (params.fieldApiNames.length === 0) {
    throw new Error(`No fields to select from ${params.objectApiName}`);
  }
  const selectList = params.fieldApiNames.map(assertSalesforceApiName).join(',');
  let soql = `SELECT ${selectList} FROM ${assertSalesforceApiName(params.objectApiName)}`;
  if (params.wherePredicates.length > 0) {
    soql += ` WHERE ${params.wherePredicates.map((predicate) => `(${predicate})`).join(' AND ')}`;
  }
  if (params.orderByRecordId) {
    soql += ' ORDER BY Id';
  }
  return soql;
}
