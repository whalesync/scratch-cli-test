import { TableViewBannerGroup, TableViewCol } from '@spinner/shared-types';
import { buildSalesforceDefaultView } from '../salesforce-default-view';
import { accountTableSpec } from './salesforce-test-fixtures';

describe('buildSalesforceDefaultView', () => {
  const view = buildSalesforceDefaultView(accountTableSpec());
  const topLevelCols = view.cols.filter((col): col is TableViewCol => col.kind === 'col');
  const customFieldsGroup = view.cols.find(
    (col): col is TableViewBannerGroup => col.kind === 'banner-group' && col.name === 'Custom Fields',
  );
  const allCols = [...topLevelCols, ...(customFieldsGroup?.cols ?? [])];
  const colAt = (path: string): TableViewCol | undefined => allCols.find((col) => col.path === path);

  it('leads with the name field, then standard fields in describe order', () => {
    expect(topLevelCols.map((col) => col.path)).toEqual([
      'Name',
      'attributes',
      'Id',
      'IsDeleted',
      'ParentId',
      'OwnerId',
      'BillingCity',
      'BillingAddress',
      'Industry',
      'Description',
      'NumberOfEmployees',
      'AnnualRevenue',
      'Website',
      'LastActivityDate',
      'CreatedDate',
      'SystemModstamp',
    ]);
  });

  it("gathers the org's custom fields under a Custom Fields banner", () => {
    expect(customFieldsGroup?.cols.map((col) => col.path)).toEqual([
      'LegacyNumber__c',
      'Notes__c',
      'Active__c',
      'Tier__c',
    ]);
    expect(view.cols[view.cols.length - 1]).toBe(customFieldsGroup);
  });

  it('hides system plumbing and compound address values', () => {
    for (const hiddenPath of ['attributes', 'IsDeleted', 'SystemModstamp', 'BillingAddress']) {
      expect(colAt(hiddenPath)?.hidden).toBe(true);
    }
    expect(colAt('BillingCity')?.hidden).toBeUndefined();
    expect(colAt('Id')?.hidden).toBeUndefined();
  });

  it('names columns by their Salesforce labels', () => {
    expect(colAt('Name')?.name).toBe('Account Name');
    expect(colAt('Id')?.name).toBe('Record ID');
  });

  it('maps Salesforce field types to column types', () => {
    expect(colAt('Active__c')?.type).toBe('checkbox');
    expect(colAt('NumberOfEmployees')?.type).toBe('number');
    expect(colAt('AnnualRevenue')?.type).toBe('number');
    expect(colAt('LastActivityDate')?.type).toBe('date');
    expect(colAt('Website')?.type).toBe('url');
    expect(colAt('Notes__c')?.type).toBe('richtext');
    expect(colAt('BillingAddress')?.type).toBe('object');
    expect(colAt('Industry')?.type).toBe('string');
    expect(colAt('Tier__c')?.type).toBe('string');
  });

  it('declares datetimes as timestamps for export, since their schema carries no date-time format', () => {
    expect(colAt('CreatedDate')).toEqual(expect.objectContaining({ type: 'date', logicalType: 'datetime' }));
    expect(colAt('LastActivityDate')?.logicalType).toBeUndefined();
  });

  it('carries read-only and write-once flags from the schema', () => {
    expect(colAt('CreatedDate')?.readonly).toBe(true);
    expect(colAt('Name')?.readonly).toBe(false);
    expect(colAt('LegacyNumber__c')).toEqual(expect.objectContaining({ readonly: false, writeOnce: true }));
  });

  it('links single-target lookups as single-valued foreign keys', () => {
    expect(colAt('ParentId')?.foreignKey).toEqual({
      linkedTableId: 'account',
      linkedTableRemoteId: ['Account'],
      isSingleValued: true,
    });
    expect(colAt('OwnerId')?.foreignKey).toBeUndefined();
  });
});
