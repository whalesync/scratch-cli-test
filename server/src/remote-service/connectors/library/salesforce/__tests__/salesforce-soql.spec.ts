import {
  buildSelectEveryFieldQuery,
  fieldIsAfterInstantPredicate,
  isSalesforceRecordId,
  recordIdIsAfterPredicate,
  recordIdIsOneOfPredicate,
  salesforceDateTimeLiteral,
} from '../salesforce-soql';

describe('Salesforce SOQL construction', () => {
  it('selects every field in Id order', () => {
    expect(
      buildSelectEveryFieldQuery({
        objectApiName: 'Account',
        fieldApiNames: ['Id', 'Name', 'ns__Score__c'],
        wherePredicates: [],
        orderByRecordId: true,
      }),
    ).toBe('SELECT Id,Name,ns__Score__c FROM Account ORDER BY Id');
  });

  it('ANDs parenthesized predicates', () => {
    expect(
      buildSelectEveryFieldQuery({
        objectApiName: 'Contact',
        fieldApiNames: ['Id'],
        wherePredicates: [
          fieldIsAfterInstantPredicate('SystemModstamp', new Date('2026-10-27T09:15:30.123Z')),
          recordIdIsAfterPredicate('003Hs00004lKcQfIAK'),
        ],
        orderByRecordId: true,
      }),
    ).toBe(
      "SELECT Id FROM Contact WHERE (SystemModstamp > 2026-10-27T09:15:30Z) AND (Id > '003Hs00004lKcQfIAK') ORDER BY Id",
    );
  });

  it('builds an Id IN list', () => {
    expect(recordIdIsOneOfPredicate(['001Hs000030ab2tIAA', '001Hs000030ab2t'])).toBe(
      "Id IN ('001Hs000030ab2tIAA','001Hs000030ab2t')",
    );
  });

  it('formats datetime literals to the second, unquoted', () => {
    expect(salesforceDateTimeLiteral(new Date('2026-01-02T03:04:05.678Z'))).toBe('2026-01-02T03:04:05Z');
  });

  it.each(["001' OR Name != '", '001Hs000030ab2', '001Hs000030ab2tIAA1', ''])(
    'refuses %p as a record id',
    (notARecordId) => {
      expect(isSalesforceRecordId(notARecordId)).toBe(false);
      expect(() => recordIdIsAfterPredicate(notARecordId)).toThrow(/not a valid Salesforce record id/);
    },
  );

  it.each(['Account; DELETE', 'Name,(SELECT Id FROM Contacts)', '1Field', 'Field Name'])(
    'refuses %p as an API name',
    (notAnApiName) => {
      expect(() =>
        buildSelectEveryFieldQuery({
          objectApiName: 'Account',
          fieldApiNames: [notAnApiName],
          wherePredicates: [],
          orderByRecordId: false,
        }),
      ).toThrow(/not a valid Salesforce API name/);
    },
  );
});
