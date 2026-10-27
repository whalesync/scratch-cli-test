import { NonWritableFieldEditError } from '../../../error';
import {
  buildSalesforceCreateRecordBody,
  buildSalesforceUpdateRecordBodyFromChangedFields,
  buildSalesforceUpdateRecordBodyFromFullRecord,
} from '../salesforce-write-payload';
import { accountTableSpec } from './salesforce-test-fixtures';

const RECORD_ID = '001Hs000030ab2tIAA';

describe('buildSalesforceCreateRecordBody', () => {
  const spec = accountTableSpec();

  it("sends the file's fields with the object type in attributes", () => {
    expect(
      buildSalesforceCreateRecordBody({ Name: 'Acme', Industry: 'Energy', NumberOfEmployees: 12, Website: null }, spec),
    ).toEqual({
      attributes: { type: 'Account' },
      Name: 'Acme',
      Industry: 'Energy',
      NumberOfEmployees: 12,
      Website: null,
    });
  });

  it("replaces the record's own attributes and drops an empty Id", () => {
    expect(
      buildSalesforceCreateRecordBody(
        { attributes: { type: 'Account', url: '/services/data/v66.0/sobjects/Account/x' }, Id: null, Name: 'Acme' },
        spec,
      ),
    ).toEqual({ attributes: { type: 'Account' }, Name: 'Acme' });
  });

  it('drops read-only fields that are null, but sends read-only fields with a value for Salesforce to reject', () => {
    expect(
      buildSalesforceCreateRecordBody(
        { Name: 'Acme', CreatedDate: null, IsDeleted: false, BillingAddress: null },
        spec,
      ),
    ).toEqual({ attributes: { type: 'Account' }, Name: 'Acme', IsDeleted: false });
  });

  it('sends set-on-create-only fields', () => {
    expect(buildSalesforceCreateRecordBody({ Name: 'Acme', LegacyNumber__c: 'L-1' }, spec)).toEqual({
      attributes: { type: 'Account' },
      Name: 'Acme',
      LegacyNumber__c: 'L-1',
    });
  });
});

describe('buildSalesforceUpdateRecordBodyFromChangedFields', () => {
  const spec = accountTableSpec();

  it('sends only the changed fields, with the type and id', () => {
    expect(
      buildSalesforceUpdateRecordBodyFromChangedFields(RECORD_ID, { Industry: 'Energy', Website: null }, spec),
    ).toEqual({ attributes: { type: 'Account' }, id: RECORD_ID, Industry: 'Energy', Website: null });
  });

  it('refuses read-only and set-on-create-only edits, naming each kind', () => {
    let thrown: unknown;
    try {
      buildSalesforceUpdateRecordBodyFromChangedFields(
        RECORD_ID,
        { Industry: 'Energy', CreatedDate: '2020-01-01', BillingAddress: { city: 'Paris' }, LegacyNumber__c: 'L-2' },
        spec,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NonWritableFieldEditError);
    expect((thrown as Error).message).toBe(
      'Fields "CreatedDate", "BillingAddress" are read-only and cannot be published. ' +
        'Field "LegacyNumber__c" cannot be edited after the record is created. ' +
        'Undo the change to these fields, then publish again.',
    );
  });

  it("refuses an edit to the record's attributes or Id", () => {
    expect(() =>
      buildSalesforceUpdateRecordBodyFromChangedFields(RECORD_ID, { attributes: { type: 'Lead' } }, spec),
    ).toThrow(NonWritableFieldEditError);
    expect(() => buildSalesforceUpdateRecordBodyFromChangedFields(RECORD_ID, { Id: '001000000000000' }, spec)).toThrow(
      NonWritableFieldEditError,
    );
  });
});

describe('buildSalesforceUpdateRecordBodyFromFullRecord', () => {
  it('sends every updateable field and leaves out the ones the record merely carries', () => {
    expect(
      buildSalesforceUpdateRecordBodyFromFullRecord(
        RECORD_ID,
        {
          attributes: { type: 'Account', url: '/x' },
          Id: RECORD_ID,
          Name: 'Acme',
          CreatedDate: '2020-01-01T00:00:00.000+0000',
          BillingAddress: { city: 'Paris' },
          BillingCity: 'Paris',
          LegacyNumber__c: 'L-1',
        },
        accountTableSpec(),
      ),
    ).toEqual({ attributes: { type: 'Account' }, id: RECORD_ID, Name: 'Acme', BillingCity: 'Paris' });
  });
});
