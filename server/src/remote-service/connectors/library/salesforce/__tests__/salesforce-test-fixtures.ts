import { EntityId } from '../../../types';
import { buildSalesforceJsonTableSpec } from '../salesforce-json-schema';
import { SalesforceFieldDescribe, SalesforceSObjectDescribe, SalesforceSObjectSummary } from '../salesforce-types';

export const TEST_INSTANCE_URL = 'https://acme.my.salesforce.com';

/** A describe field with Salesforce's defaults for a writable, nillable, standard text field. */
export function salesforceField(
  overrides: Partial<SalesforceFieldDescribe> & { name: string },
): SalesforceFieldDescribe {
  return {
    label: overrides.name,
    type: 'string',
    soapType: 'xsd:string',
    extraTypeInfo: null,
    custom: false,
    createable: true,
    updateable: true,
    nillable: true,
    defaultedOnCreate: false,
    calculated: false,
    autoNumber: false,
    nameField: false,
    length: 0,
    precision: 0,
    scale: 0,
    referenceTo: [],
    relationshipName: null,
    compoundFieldName: null,
    picklistValues: [],
    restrictedPicklist: false,
    inlineHelpText: null,
    ...overrides,
  };
}

/** The system fields every Salesforce object carries, as its describe reports them. */
export const SYSTEM_FIELDS: SalesforceFieldDescribe[] = [
  salesforceField({
    name: 'Id',
    label: 'Account ID',
    type: 'id',
    createable: false,
    updateable: false,
    nillable: false,
    defaultedOnCreate: true,
    length: 18,
  }),
  salesforceField({
    name: 'IsDeleted',
    label: 'Deleted',
    type: 'boolean',
    createable: false,
    updateable: false,
    nillable: false,
    defaultedOnCreate: true,
  }),
  salesforceField({
    name: 'CreatedDate',
    label: 'Created Date',
    type: 'datetime',
    createable: false,
    updateable: false,
    nillable: false,
    defaultedOnCreate: true,
  }),
  salesforceField({
    name: 'SystemModstamp',
    label: 'System Modstamp',
    type: 'datetime',
    createable: false,
    updateable: false,
    nillable: false,
    defaultedOnCreate: true,
  }),
];

/** A trimmed Account describe covering each field kind the connector treats differently. */
export const ACCOUNT_DESCRIBE: SalesforceSObjectDescribe = {
  name: 'Account',
  label: 'Account',
  labelPlural: 'Accounts',
  custom: false,
  createable: true,
  updateable: true,
  deletable: true,
  queryable: true,
  fields: [
    SYSTEM_FIELDS[0],
    SYSTEM_FIELDS[1],
    salesforceField({ name: 'Name', label: 'Account Name', nameField: true, nillable: false, length: 255 }),
    salesforceField({
      name: 'ParentId',
      label: 'Parent Account ID',
      type: 'reference',
      referenceTo: ['Account'],
      relationshipName: 'Parent',
      length: 18,
    }),
    salesforceField({
      name: 'OwnerId',
      label: 'Owner ID',
      type: 'reference',
      referenceTo: ['Group', 'User'],
      relationshipName: 'Owner',
      defaultedOnCreate: true,
      nillable: false,
      length: 18,
    }),
    salesforceField({ name: 'BillingCity', label: 'Billing City', compoundFieldName: 'BillingAddress', length: 40 }),
    salesforceField({
      name: 'BillingAddress',
      label: 'Billing Address',
      type: 'address',
      createable: false,
      updateable: false,
    }),
    salesforceField({ name: 'Industry', label: 'Industry', type: 'picklist', length: 255 }),
    salesforceField({
      name: 'Description',
      label: 'Account Description',
      type: 'textarea',
      extraTypeInfo: 'plaintextarea',
      length: 32000,
    }),
    salesforceField({ name: 'NumberOfEmployees', label: 'Employees', type: 'int' }),
    salesforceField({ name: 'AnnualRevenue', label: 'Annual Revenue', type: 'currency' }),
    salesforceField({ name: 'Website', label: 'Website', type: 'url', length: 255 }),
    salesforceField({
      name: 'LastActivityDate',
      label: 'Last Activity',
      type: 'date',
      createable: false,
      updateable: false,
    }),
    SYSTEM_FIELDS[2],
    SYSTEM_FIELDS[3],
    salesforceField({
      name: 'LegacyNumber__c',
      label: 'Legacy Number',
      custom: true,
      createable: true,
      updateable: false,
      length: 20,
    }),
    salesforceField({
      name: 'Notes__c',
      label: 'Notes',
      type: 'textarea',
      extraTypeInfo: 'richtextarea',
      custom: true,
      length: 32768,
    }),
    salesforceField({
      name: 'Active__c',
      label: 'Active',
      type: 'boolean',
      custom: true,
      nillable: false,
      defaultedOnCreate: true,
    }),
    salesforceField({ name: 'Tier__c', label: 'Tier', type: 'multipicklist', custom: true, length: 4099 }),
  ],
};

export const ACCOUNT_TABLE_ID: EntityId = { wsId: 'account', remoteId: ['Account'] };

export function accountTableSpec() {
  return buildSalesforceJsonTableSpec(ACCOUNT_TABLE_ID, ACCOUNT_DESCRIBE, TEST_INSTANCE_URL);
}

/** An object catalog entry with the flags of an ordinary, fully writable standard object. */
export function salesforceSObjectSummary(
  overrides: Partial<SalesforceSObjectSummary> & { name: string },
): SalesforceSObjectSummary {
  return {
    label: overrides.name,
    labelPlural: `${overrides.name}s`,
    custom: false,
    customSetting: false,
    queryable: true,
    retrieveable: true,
    layoutable: true,
    deprecatedAndHidden: false,
    createable: true,
    updateable: true,
    deletable: true,
    ...overrides,
  };
}
