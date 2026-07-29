/**
 * Static TypeBox schemas for QuickBooks Online entity types.
 *
 * AUTO-GENERATED — DO NOT EDIT MANUALLY.
 * To regenerate: cd tools/graphql-codegen && yarn codegen:quickbooks
 *
 * Source: Airbyte QuickBooks connector (MIT license)
 * https://raw.githubusercontent.com/airbytehq/airbyte/master/airbyte-integrations/connectors/source-quickbooks/manifest.yaml
 *
 * Generated at: 2026-03-13T14:08:57.636Z
 *
 * Only `Id` is marked readonly here; the connector applies the remaining
 * read-only annotations (computed + system fields) at build time in
 * `quickbooks-json-schema.ts`.
 * All schemas have additionalProperties: true to handle undocumented fields.
 */
import { type TSchema, Type } from '@sinclair/typebox';
import {
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { QuickBooksEntityType } from './quickbooks-types';

const AccountSchema = Type.Object(
  {
    AccountSubType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    AccountType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    AcctNum: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    Active: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    Classification: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    CurrencyRef: Type.Optional(
      Type.Union([
        Type.Object({
          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    CurrentBalance: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    CurrentBalanceWithSubAccounts: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    FullyQualifiedName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    Id: Type.String({ [X_SCRATCH_READONLY]: true }),
    MetaData: Type.Optional(
      Type.Union([
        Type.Object({
          CreateTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
          LastUpdatedTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
        }),
        Type.Null(),
      ]),
    ),
    Name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    ParentRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'account', linkedTableRemoteId: ['Account'] } },
      ),
    ),
    SubAccount: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    SyncToken: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sparse: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  },
  { $id: 'quickbooks/Account', additionalProperties: true },
);

const BillSchema = Type.Object(
  {
    APAccountRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'account', linkedTableRemoteId: ['Account'] } },
      ),
    ),
    Balance: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    CurrencyRef: Type.Optional(
      Type.Union([
        Type.Object({
          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    DepartmentRef: Type.Optional(
      Type.Union([
        Type.Object({
          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    DocNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    DueDate: Type.Optional(
      Type.Union([Type.String({ format: 'date', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'date' }), Type.Null()]),
    ),
    ExchangeRate: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    Id: Type.String({ [X_SCRATCH_READONLY]: true }),
    Line: Type.Optional(
      Type.Union([
        Type.Array(
          Type.Union([
            Type.Object({
              AccountBasedExpenseLineDetail: Type.Optional(
                Type.Union([
                  Type.Object({
                    AccountRef: Type.Optional(
                      Type.Union(
                        [
                          Type.Object({
                            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          }),
                          Type.Null(),
                        ],
                        {
                          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
                            linkedTableId: 'account',
                            linkedTableRemoteId: ['Account'],
                          },
                        },
                      ),
                    ),
                    BillableStatus: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                    ClassRef: Type.Optional(
                      Type.Union([
                        Type.Object({
                          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                        }),
                        Type.Null(),
                      ]),
                    ),
                    CustomerRef: Type.Optional(
                      Type.Union(
                        [
                          Type.Object({
                            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          }),
                          Type.Null(),
                        ],
                        {
                          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
                            linkedTableId: 'customer',
                            linkedTableRemoteId: ['Customer'],
                          },
                        },
                      ),
                    ),
                    TaxCodeRef: Type.Optional(
                      Type.Union(
                        [
                          Type.Object({
                            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          }),
                          Type.Null(),
                        ],
                        {
                          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
                            linkedTableId: 'taxcode',
                            linkedTableRemoteId: ['TaxCode'],
                          },
                        },
                      ),
                    ),
                  }),
                  Type.Null(),
                ]),
              ),
              Amount: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
              Description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              DetailType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              Id: Type.String({ [X_SCRATCH_READONLY]: true }),
              ItemBasedExpenseLineDetail: Type.Optional(
                Type.Union([
                  Type.Object({
                    BillableStatus: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                    ItemRef: Type.Optional(
                      Type.Union(
                        [
                          Type.Object({
                            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          }),
                          Type.Null(),
                        ],
                        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'item', linkedTableRemoteId: ['Item'] } },
                      ),
                    ),
                    Qty: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
                    TaxCodeRef: Type.Optional(
                      Type.Union(
                        [
                          Type.Object({
                            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          }),
                          Type.Null(),
                        ],
                        {
                          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
                            linkedTableId: 'taxcode',
                            linkedTableRemoteId: ['TaxCode'],
                          },
                        },
                      ),
                    ),
                    UnitPrice: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
                  }),
                  Type.Null(),
                ]),
              ),
              LineNum: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
            }),
            Type.Null(),
          ]),
        ),
        Type.Null(),
      ]),
    ),
    LinkedTxn: Type.Optional(
      Type.Union([
        Type.Array(
          Type.Union([
            Type.Object({
              TxnId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              TxnType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            }),
            Type.Null(),
          ]),
        ),
        Type.Null(),
      ]),
    ),
    MetaData: Type.Optional(
      Type.Union([
        Type.Object({
          CreateTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
          LastUpdatedTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
        }),
        Type.Null(),
      ]),
    ),
    PrivateNote: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    SalesTermRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'term', linkedTableRemoteId: ['Term'] } },
      ),
    ),
    SyncToken: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    TotalAmt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    TxnDate: Type.Optional(
      Type.Union([Type.String({ format: 'date', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'date' }), Type.Null()]),
    ),
    VendorRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'vendor', linkedTableRemoteId: ['Vendor'] } },
      ),
    ),
    domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sparse: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    VendorAddr: Type.Optional(Type.Union([Type.Object({}), Type.Null()])),
  },
  { $id: 'quickbooks/Bill', additionalProperties: true },
);

const BillPaymentSchema = Type.Object(
  {
    APAccountRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'account', linkedTableRemoteId: ['Account'] } },
      ),
    ),
    CheckPayment: Type.Optional(
      Type.Union([
        Type.Object({
          BankAccountRef: Type.Optional(
            Type.Union(
              [
                Type.Object({
                  name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                  value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                }),
                Type.Null(),
              ],
              { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'account', linkedTableRemoteId: ['Account'] } },
            ),
          ),
          PrintStatus: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    CreditCardPayment: Type.Optional(
      Type.Union([
        Type.Object({
          CCAccountRef: Type.Optional(
            Type.Union(
              [
                Type.Object({
                  name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                  value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                }),
                Type.Null(),
              ],
              { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'account', linkedTableRemoteId: ['Account'] } },
            ),
          ),
        }),
        Type.Null(),
      ]),
    ),
    CurrencyRef: Type.Optional(
      Type.Union([
        Type.Object({
          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    DepartmentRef: Type.Optional(
      Type.Union([
        Type.Object({
          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    DocNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    ExchangeRate: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    Id: Type.String({ [X_SCRATCH_READONLY]: true }),
    Line: Type.Optional(
      Type.Union([
        Type.Array(
          Type.Union([
            Type.Object({
              Amount: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
              LinkedTxn: Type.Optional(
                Type.Union([
                  Type.Array(
                    Type.Union([
                      Type.Object({
                        TxnId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                        TxnType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                      }),
                      Type.Null(),
                    ]),
                  ),
                  Type.Null(),
                ]),
              ),
            }),
            Type.Null(),
          ]),
        ),
        Type.Null(),
      ]),
    ),
    MetaData: Type.Optional(
      Type.Union([
        Type.Object({
          CreateTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
          LastUpdatedTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
        }),
        Type.Null(),
      ]),
    ),
    PayType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    SyncToken: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    TotalAmt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    TxnDate: Type.Optional(
      Type.Union([Type.String({ format: 'date', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'date' }), Type.Null()]),
    ),
    VendorRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'vendor', linkedTableRemoteId: ['Vendor'] } },
      ),
    ),
    domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sparse: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  },
  { $id: 'quickbooks/BillPayment', additionalProperties: true },
);

const CompanyInfoSchema = Type.Object(
  {
    Id: Type.String({ [X_SCRATCH_READONLY]: true }),
    SyncToken: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    MetaData: Type.Optional(
      Type.Union([
        Type.Object({
          CreateTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
          LastUpdatedTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
        }),
        Type.Null(),
      ]),
    ),
    CompanyName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    LegalName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    CompanyAddr: Type.Optional(Type.Object({})),
    CustomerCommunicationAddr: Type.Optional(Type.Object({})),
    LegalAddr: Type.Optional(Type.Object({})),
    PrimaryPhone: Type.Optional(Type.Object({})),
    CompanyStartDate: Type.Optional(
      Type.Union([Type.String({ format: 'date', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'date' }), Type.Null()]),
    ),
    FiscalYearStartMonth: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    Country: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    Email: Type.Optional(Type.Object({})),
    WebAddr: Type.Optional(Type.Object({})),
    SupportedLanguages: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    NameValue: Type.Optional(Type.Array(Type.Object({}))),
    CustomerCommunicationEmailAddr: Type.Optional(Type.Object({})),
    DefaultTimeZone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { $id: 'quickbooks/CompanyInfo', additionalProperties: true },
);

const CreditMemoSchema = Type.Object(
  {
    ApplyTaxAfterDiscount: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    Balance: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    BillAddr: Type.Optional(
      Type.Union([
        Type.Object({
          Id: Type.String({ [X_SCRATCH_READONLY]: true }),
          Lat: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line1: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line2: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line3: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line4: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Long: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    BillEmail: Type.Optional(
      Type.Union([
        Type.Object({
          Address: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    ClassRef: Type.Optional(
      Type.Union([
        Type.Object({
          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    CurrencyRef: Type.Optional(
      Type.Union([
        Type.Object({
          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    CustomField: Type.Optional(
      Type.Union([
        Type.Array(
          Type.Union([
            Type.Object({
              DefinitionId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              Name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              Type: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            }),
            Type.Null(),
          ]),
        ),
        Type.Null(),
      ]),
    ),
    CustomerMemo: Type.Optional(
      Type.Union([
        Type.Object({
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    CustomerRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'customer', linkedTableRemoteId: ['Customer'] } },
      ),
    ),
    DocNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    EmailStatus: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    ExchangeRate: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    HomeTotalAmt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    Id: Type.String({ [X_SCRATCH_READONLY]: true }),
    Line: Type.Optional(
      Type.Union([
        Type.Array(
          Type.Union([
            Type.Object({
              Amount: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
              Description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              DetailType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              Id: Type.String({ [X_SCRATCH_READONLY]: true }),
              LineNum: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
              SalesItemLineDetail: Type.Optional(
                Type.Union([
                  Type.Object({
                    ItemRef: Type.Optional(
                      Type.Union(
                        [
                          Type.Object({
                            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          }),
                          Type.Null(),
                        ],
                        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'item', linkedTableRemoteId: ['Item'] } },
                      ),
                    ),
                    Qty: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
                    TaxCodeRef: Type.Optional(
                      Type.Union(
                        [
                          Type.Object({
                            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          }),
                          Type.Null(),
                        ],
                        {
                          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
                            linkedTableId: 'taxcode',
                            linkedTableRemoteId: ['TaxCode'],
                          },
                        },
                      ),
                    ),
                    UnitPrice: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
                  }),
                  Type.Null(),
                ]),
              ),
              SubTotalLineDetail: Type.Optional(Type.Union([Type.Object({}), Type.Null()])),
            }),
            Type.Null(),
          ]),
        ),
        Type.Null(),
      ]),
    ),
    MetaData: Type.Optional(
      Type.Union([
        Type.Object({
          CreateTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
          LastUpdatedTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
        }),
        Type.Null(),
      ]),
    ),
    PrintStatus: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    RemainingCredit: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    SalesTermRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'term', linkedTableRemoteId: ['Term'] } },
      ),
    ),
    ShipAddr: Type.Optional(
      Type.Union([
        Type.Object({
          City: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          CountrySubDivisionCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Id: Type.String({ [X_SCRATCH_READONLY]: true }),
          Lat: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line1: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Long: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          PostalCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    SyncToken: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    TotalAmt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    TxnDate: Type.Optional(
      Type.Union([Type.String({ format: 'date', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'date' }), Type.Null()]),
    ),
    TxnTaxDetail: Type.Optional(
      Type.Union([
        Type.Object({
          TotalTax: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sparse: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    FreeFormAddress: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  },
  { $id: 'quickbooks/CreditMemo', additionalProperties: true },
);

const CustomerSchema = Type.Object(
  {
    Active: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    Balance: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    BalanceWithJobs: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    BillAddr: Type.Optional(
      Type.Union([
        Type.Object({
          City: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Country: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          CountrySubDivisionCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Id: Type.String({ [X_SCRATCH_READONLY]: true }),
          Lat: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line1: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Long: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          PostalCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    BillWithParent: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    CompanyName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    CurrencyRef: Type.Optional(
      Type.Union([
        Type.Object({
          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    DefaultTaxCodeRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'taxcode', linkedTableRemoteId: ['TaxCode'] } },
      ),
    ),
    DisplayName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    FamilyName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    Fax: Type.Optional(
      Type.Union([
        Type.Object({
          FreeFormNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    FullyQualifiedName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    GivenName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    Id: Type.String({ [X_SCRATCH_READONLY]: true }),
    Job: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    Level: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    MetaData: Type.Optional(
      Type.Union([
        Type.Object({
          CreateTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
          LastUpdatedTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
        }),
        Type.Null(),
      ]),
    ),
    MiddleName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    Mobile: Type.Optional(
      Type.Union([
        Type.Object({
          FreeFormNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    ParentRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'customer', linkedTableRemoteId: ['Customer'] } },
      ),
    ),
    PaymentMethodRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'paymentmethod', linkedTableRemoteId: ['PaymentMethod'] } },
      ),
    ),
    PreferredDeliveryMethod: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    PrimaryEmailAddr: Type.Optional(
      Type.Union([
        Type.Object({
          Address: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    PrimaryPhone: Type.Optional(
      Type.Union([
        Type.Object({
          FreeFormNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    PrintOnCheckName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    ResaleNum: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    SalesTermRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'term', linkedTableRemoteId: ['Term'] } },
      ),
    ),
    ShipAddr: Type.Optional(
      Type.Union([
        Type.Object({
          City: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Country: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          CountrySubDivisionCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Id: Type.String({ [X_SCRATCH_READONLY]: true }),
          Lat: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line1: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Long: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          PostalCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    SyncToken: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    Taxable: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    WebAddr: Type.Optional(
      Type.Union([
        Type.Object({
          URI: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sparse: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    IsProject: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    ClientEntityId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    V4IDPseudonym: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { $id: 'quickbooks/Customer', additionalProperties: true },
);

const DepositSchema = Type.Object(
  {
    CashBack: Type.Optional(
      Type.Union([
        Type.Object({
          AccountRef: Type.Optional(
            Type.Union(
              [
                Type.Object({
                  name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                  value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                }),
                Type.Null(),
              ],
              { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'account', linkedTableRemoteId: ['Account'] } },
            ),
          ),
          Amount: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
          Memo: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    CurrencyRef: Type.Optional(
      Type.Union([
        Type.Object({
          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    DepartmentRef: Type.Optional(
      Type.Union([
        Type.Object({
          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    DepositToAccountRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'account', linkedTableRemoteId: ['Account'] } },
      ),
    ),
    ExchangeRate: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    Id: Type.String({ [X_SCRATCH_READONLY]: true }),
    Line: Type.Optional(
      Type.Union([
        Type.Array(
          Type.Union([
            Type.Object({
              Amount: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
              DepositLineDetail: Type.Optional(
                Type.Union([
                  Type.Object({
                    AccountRef: Type.Optional(
                      Type.Union(
                        [
                          Type.Object({
                            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          }),
                          Type.Null(),
                        ],
                        {
                          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
                            linkedTableId: 'account',
                            linkedTableRemoteId: ['Account'],
                          },
                        },
                      ),
                    ),
                    CheckNum: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                    Entity: Type.Optional(
                      Type.Union([
                        Type.Object({
                          type: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                        }),
                        Type.Null(),
                      ]),
                    ),
                    PaymentMethodRef: Type.Optional(
                      Type.Union(
                        [
                          Type.Object({
                            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          }),
                          Type.Null(),
                        ],
                        {
                          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
                            linkedTableId: 'paymentmethod',
                            linkedTableRemoteId: ['PaymentMethod'],
                          },
                        },
                      ),
                    ),
                  }),
                  Type.Null(),
                ]),
              ),
              DetailType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              Id: Type.String({ [X_SCRATCH_READONLY]: true }),
              LineNum: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
              LinkedTxn: Type.Optional(
                Type.Union([
                  Type.Array(
                    Type.Union([
                      Type.Object({
                        TxnId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                        TxnLineId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                        TxnType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                      }),
                      Type.Null(),
                    ]),
                  ),
                  Type.Null(),
                ]),
              ),
            }),
            Type.Null(),
          ]),
        ),
        Type.Null(),
      ]),
    ),
    MetaData: Type.Optional(
      Type.Union([
        Type.Object({
          CreateTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
          LastUpdatedTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
        }),
        Type.Null(),
      ]),
    ),
    PrivateNote: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    SyncToken: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    TotalAmt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    TxnDate: Type.Optional(
      Type.Union([Type.String({ format: 'date', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'date' }), Type.Null()]),
    ),
    domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sparse: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    TxnTaxDetail: Type.Optional(Type.Union([Type.Object({}), Type.Null()])),
  },
  { $id: 'quickbooks/Deposit', additionalProperties: true },
);

const EmployeeSchema = Type.Object(
  {
    Active: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    BillRate: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    BillableTime: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    BirthDate: Type.Optional(
      Type.Union([Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }), Type.Null()]),
    ),
    DisplayName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    EmployeeNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    FamilyName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    Gender: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    GivenName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    HiredDate: Type.Optional(
      Type.Union([Type.String({ format: 'date', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'date' }), Type.Null()]),
    ),
    Id: Type.String({ [X_SCRATCH_READONLY]: true }),
    MetaData: Type.Optional(
      Type.Union([
        Type.Object({
          CreateTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
          LastUpdatedTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
        }),
        Type.Null(),
      ]),
    ),
    MiddleName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    Mobile: Type.Optional(Type.Union([Type.Object({}), Type.Null()])),
    Organization: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    PrimaryAddr: Type.Optional(Type.Union([Type.Object({}), Type.Null()])),
    PrimaryEmailAddr: Type.Optional(Type.Union([Type.Object({}), Type.Null()])),
    PrimaryPhone: Type.Optional(
      Type.Union([
        Type.Object({
          FreeFormNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    PrintOnCheckName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    ReleasedDate: Type.Optional(
      Type.Union([Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }), Type.Null()]),
    ),
    Suffix: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    SyncToken: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    Title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sparse: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    V4IDPseudonym: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { $id: 'quickbooks/Employee', additionalProperties: true },
);

const EstimateSchema = Type.Object(
  {
    ApplyTaxAfterDiscount: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    BillAddr: Type.Optional(
      Type.Union([
        Type.Object({
          Id: Type.String({ [X_SCRATCH_READONLY]: true }),
          Lat: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line1: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line2: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line3: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line4: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Long: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    BillEmail: Type.Optional(
      Type.Union([
        Type.Object({
          Address: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    CurrencyRef: Type.Optional(
      Type.Union([
        Type.Object({
          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    CustomField: Type.Optional(
      Type.Union([
        Type.Array(
          Type.Union([
            Type.Object({
              DefinitionId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              Name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              Type: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            }),
            Type.Null(),
          ]),
        ),
        Type.Null(),
      ]),
    ),
    CustomerMemo: Type.Optional(
      Type.Union([
        Type.Object({
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    CustomerRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'customer', linkedTableRemoteId: ['Customer'] } },
      ),
    ),
    DeliveryInfo: Type.Optional(
      Type.Union([
        Type.Object({
          DeliveryType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    DocNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    EmailStatus: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    ExchangeRate: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    HomeTotalAmt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    Id: Type.String({ [X_SCRATCH_READONLY]: true }),
    Line: Type.Optional(
      Type.Union([
        Type.Array(
          Type.Union([
            Type.Object({
              Amount: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
              Description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              DetailType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              Id: Type.String({ [X_SCRATCH_READONLY]: true }),
              LineNum: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
              SalesItemLineDetail: Type.Optional(
                Type.Union([
                  Type.Object({
                    ItemRef: Type.Optional(
                      Type.Union(
                        [
                          Type.Object({
                            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          }),
                          Type.Null(),
                        ],
                        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'item', linkedTableRemoteId: ['Item'] } },
                      ),
                    ),
                    Qty: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
                    TaxCodeRef: Type.Optional(
                      Type.Union(
                        [
                          Type.Object({
                            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          }),
                          Type.Null(),
                        ],
                        {
                          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
                            linkedTableId: 'taxcode',
                            linkedTableRemoteId: ['TaxCode'],
                          },
                        },
                      ),
                    ),
                    UnitPrice: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
                  }),
                  Type.Null(),
                ]),
              ),
              SubTotalLineDetail: Type.Optional(Type.Union([Type.Object({}), Type.Null()])),
            }),
            Type.Null(),
          ]),
        ),
        Type.Null(),
      ]),
    ),
    LinkedTxn: Type.Optional(
      Type.Union([
        Type.Array(
          Type.Union([
            Type.Object({
              TxnId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              TxnType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            }),
            Type.Null(),
          ]),
        ),
        Type.Null(),
      ]),
    ),
    MetaData: Type.Optional(
      Type.Union([
        Type.Object({
          CreateTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
          LastUpdatedTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
        }),
        Type.Null(),
      ]),
    ),
    PrintStatus: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    ShipAddr: Type.Optional(
      Type.Union([
        Type.Object({
          City: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          CountrySubDivisionCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Id: Type.String({ [X_SCRATCH_READONLY]: true }),
          Lat: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line1: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Long: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          PostalCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    SyncToken: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    TotalAmt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    TxnDate: Type.Optional(
      Type.Union([Type.String({ format: 'date', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'date' }), Type.Null()]),
    ),
    TxnStatus: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    TxnTaxDetail: Type.Optional(
      Type.Union([
        Type.Object({
          TaxLine: Type.Optional(
            Type.Union([
              Type.Array(
                Type.Union([
                  Type.Object({
                    Amount: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
                    DetailType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                    TaxLineDetail: Type.Optional(
                      Type.Union([
                        Type.Object({
                          NetAmountTaxable: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
                          PercentBased: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
                          TaxPercent: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
                          TaxRateRef: Type.Optional(
                            Type.Union(
                              [
                                Type.Object({
                                  value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                                }),
                                Type.Null(),
                              ],
                              {
                                [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
                                  linkedTableId: 'taxrate',
                                  linkedTableRemoteId: ['TaxRate'],
                                },
                              },
                            ),
                          ),
                        }),
                        Type.Null(),
                      ]),
                    ),
                  }),
                  Type.Null(),
                ]),
              ),
              Type.Null(),
            ]),
          ),
          TotalTax: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
          TxnTaxCodeRef: Type.Optional(
            Type.Union(
              [
                Type.Object({
                  value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                }),
                Type.Null(),
              ],
              { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'taxcode', linkedTableRemoteId: ['TaxCode'] } },
            ),
          ),
        }),
        Type.Null(),
      ]),
    ),
    domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sparse: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    FreeFormAddress: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  },
  { $id: 'quickbooks/Estimate', additionalProperties: true },
);

const InvoiceSchema = Type.Object(
  {
    AllowIPNPayment: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    AllowOnlineACHPayment: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    AllowOnlineCreditCardPayment: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    AllowOnlinePayment: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    ApplyTaxAfterDiscount: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    Balance: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    BillAddr: Type.Optional(
      Type.Union([
        Type.Object({
          City: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          CountrySubDivisionCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Id: Type.String({ [X_SCRATCH_READONLY]: true }),
          Lat: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line1: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line2: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line3: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line4: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Long: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          PostalCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    BillEmail: Type.Optional(
      Type.Union([
        Type.Object({
          Address: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    CurrencyRef: Type.Optional(
      Type.Union([
        Type.Object({
          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    CustomField: Type.Optional(
      Type.Union([
        Type.Array(
          Type.Union([
            Type.Object({
              DefinitionId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              Name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              StringValue: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              Type: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            }),
            Type.Null(),
          ]),
        ),
        Type.Null(),
      ]),
    ),
    CustomerMemo: Type.Optional(
      Type.Union([
        Type.Object({
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    CustomerRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'customer', linkedTableRemoteId: ['Customer'] } },
      ),
    ),
    DeliveryInfo: Type.Optional(
      Type.Union([
        Type.Object({
          DeliveryType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    DocNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    DueDate: Type.Optional(
      Type.Union([Type.String({ format: 'date', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'date' }), Type.Null()]),
    ),
    EmailStatus: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    ExchangeRate: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    HomeTotalAmt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    Id: Type.String({ [X_SCRATCH_READONLY]: true }),
    Line: Type.Optional(
      Type.Union([
        Type.Array(
          Type.Union([
            Type.Object({
              Amount: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
              Description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              DetailType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              DiscountLineDetail: Type.Optional(
                Type.Union([
                  Type.Object({
                    DiscountAccountRef: Type.Optional(
                      Type.Union(
                        [
                          Type.Object({
                            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          }),
                          Type.Null(),
                        ],
                        {
                          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
                            linkedTableId: 'account',
                            linkedTableRemoteId: ['Account'],
                          },
                        },
                      ),
                    ),
                    DiscountPercent: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
                    PercentBased: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
                  }),
                  Type.Null(),
                ]),
              ),
              Id: Type.String({ [X_SCRATCH_READONLY]: true }),
              LineNum: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
              LinkedTxn: Type.Optional(
                Type.Union([
                  Type.Array(
                    Type.Union([
                      Type.Object({
                        TxnId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                        TxnType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                      }),
                      Type.Null(),
                    ]),
                  ),
                  Type.Null(),
                ]),
              ),
              SalesItemLineDetail: Type.Optional(
                Type.Union([
                  Type.Object({
                    ClassRef: Type.Optional(
                      Type.Union([
                        Type.Object({
                          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                        }),
                        Type.Null(),
                      ]),
                    ),
                    ItemRef: Type.Optional(
                      Type.Union(
                        [
                          Type.Object({
                            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          }),
                          Type.Null(),
                        ],
                        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'item', linkedTableRemoteId: ['Item'] } },
                      ),
                    ),
                    Qty: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
                    ServiceDate: Type.Optional(
                      Type.Union([
                        Type.String({ format: 'date', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'date' }),
                        Type.Null(),
                      ]),
                    ),
                    TaxCodeRef: Type.Optional(
                      Type.Union(
                        [
                          Type.Object({
                            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          }),
                          Type.Null(),
                        ],
                        {
                          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
                            linkedTableId: 'taxcode',
                            linkedTableRemoteId: ['TaxCode'],
                          },
                        },
                      ),
                    ),
                    UnitPrice: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
                  }),
                  Type.Null(),
                ]),
              ),
              SubTotalLineDetail: Type.Optional(Type.Union([Type.Object({}), Type.Null()])),
            }),
            Type.Null(),
          ]),
        ),
        Type.Null(),
      ]),
    ),
    LinkedTxn: Type.Optional(
      Type.Union([
        Type.Array(
          Type.Union([
            Type.Object({
              TxnId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              TxnType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            }),
            Type.Null(),
          ]),
        ),
        Type.Null(),
      ]),
    ),
    MetaData: Type.Optional(
      Type.Union([
        Type.Object({
          CreateTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
          LastUpdatedTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
        }),
        Type.Null(),
      ]),
    ),
    PrintStatus: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    PrivateNote: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    SalesTermRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'term', linkedTableRemoteId: ['Term'] } },
      ),
    ),
    ShipAddr: Type.Optional(
      Type.Union([
        Type.Object({
          City: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          CountrySubDivisionCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Id: Type.String({ [X_SCRATCH_READONLY]: true }),
          Lat: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line1: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Long: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          PostalCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    SyncToken: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    TotalAmt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    TxnDate: Type.Optional(
      Type.Union([Type.String({ format: 'date', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'date' }), Type.Null()]),
    ),
    TxnTaxDetail: Type.Optional(
      Type.Union([
        Type.Object({
          TaxLine: Type.Optional(
            Type.Union([
              Type.Array(
                Type.Union([
                  Type.Object({
                    Amount: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
                    DetailType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                    TaxLineDetail: Type.Optional(
                      Type.Union([
                        Type.Object({
                          NetAmountTaxable: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
                          PercentBased: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
                          TaxPercent: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
                          TaxRateRef: Type.Optional(
                            Type.Union(
                              [
                                Type.Object({
                                  value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                                }),
                                Type.Null(),
                              ],
                              {
                                [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
                                  linkedTableId: 'taxrate',
                                  linkedTableRemoteId: ['TaxRate'],
                                },
                              },
                            ),
                          ),
                        }),
                        Type.Null(),
                      ]),
                    ),
                  }),
                  Type.Null(),
                ]),
              ),
              Type.Null(),
            ]),
          ),
          TotalTax: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
          TxnTaxCodeRef: Type.Optional(
            Type.Union(
              [
                Type.Object({
                  value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                }),
                Type.Null(),
              ],
              { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'taxcode', linkedTableRemoteId: ['TaxCode'] } },
            ),
          ),
        }),
        Type.Null(),
      ]),
    ),
    domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sparse: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    FreeFormAddress: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    ShipFromAddr: Type.Optional(Type.Union([Type.Object({}), Type.Null()])),
  },
  { $id: 'quickbooks/Invoice', additionalProperties: true },
);

const ItemSchema = Type.Object(
  {
    Active: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    AssetAccountRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'account', linkedTableRemoteId: ['Account'] } },
      ),
    ),
    Description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    ExpenseAccountRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'account', linkedTableRemoteId: ['Account'] } },
      ),
    ),
    FullyQualifiedName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    Id: Type.String({ [X_SCRATCH_READONLY]: true }),
    IncomeAccountRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'account', linkedTableRemoteId: ['Account'] } },
      ),
    ),
    InvStartDate: Type.Optional(
      Type.Union([Type.String({ format: 'date', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'date' }), Type.Null()]),
    ),
    MetaData: Type.Optional(
      Type.Union([
        Type.Object({
          CreateTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
          LastUpdatedTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
        }),
        Type.Null(),
      ]),
    ),
    Name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    PurchaseCost: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    PurchaseDesc: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    QtyOnHand: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    SyncToken: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    Taxable: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    TrackQtyOnHand: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    Type: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    UnitPrice: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sparse: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  },
  { $id: 'quickbooks/Item', additionalProperties: true },
);

const JournalEntrySchema = Type.Object(
  {
    Adjustment: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    CurrencyRef: Type.Optional(
      Type.Union([
        Type.Object({
          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    DocNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    ExchangeRate: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    Id: Type.String({ [X_SCRATCH_READONLY]: true }),
    Line: Type.Optional(
      Type.Union([
        Type.Array(
          Type.Union([
            Type.Object({
              Amount: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
              Description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              DetailType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              Id: Type.String({ [X_SCRATCH_READONLY]: true }),
              JournalEntryLineDetail: Type.Optional(
                Type.Union([
                  Type.Object({
                    AccountRef: Type.Optional(
                      Type.Union(
                        [
                          Type.Object({
                            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          }),
                          Type.Null(),
                        ],
                        {
                          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
                            linkedTableId: 'account',
                            linkedTableRemoteId: ['Account'],
                          },
                        },
                      ),
                    ),
                    ClassRef: Type.Optional(
                      Type.Union([
                        Type.Object({
                          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                        }),
                        Type.Null(),
                      ]),
                    ),
                    Entity: Type.Optional(
                      Type.Union([
                        Type.Object({
                          EntityRef: Type.Optional(
                            Type.Union([
                              Type.Object({
                                name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                                value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                              }),
                              Type.Null(),
                            ]),
                          ),
                          Type: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                        }),
                        Type.Null(),
                      ]),
                    ),
                    PostingType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                  }),
                  Type.Null(),
                ]),
              ),
            }),
            Type.Null(),
          ]),
        ),
        Type.Null(),
      ]),
    ),
    MetaData: Type.Optional(
      Type.Union([
        Type.Object({
          CreateTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
          LastUpdatedTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
        }),
        Type.Null(),
      ]),
    ),
    PrivateNote: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    SyncToken: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    TaxRateRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'taxrate', linkedTableRemoteId: ['TaxRate'] } },
      ),
    ),
    TxnDate: Type.Optional(
      Type.Union([Type.String({ format: 'date', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'date' }), Type.Null()]),
    ),
    TxnTaxDetail: Type.Optional(
      Type.Union([
        Type.Object({
          TaxLine: Type.Optional(
            Type.Union([
              Type.Array(
                Type.Union([
                  Type.Object({
                    Amount: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
                    DetailType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                    TaxLineDetail: Type.Optional(
                      Type.Union([
                        Type.Object({
                          NetAmountTaxable: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
                          OverrideDeltaAmount: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
                          PercentBased: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
                          TaxInclusiveAmount: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
                          TaxPercent: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
                          TaxRateRef: Type.Optional(
                            Type.Union(
                              [
                                Type.Object({
                                  name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                                  value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                                }),
                                Type.Null(),
                              ],
                              {
                                [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
                                  linkedTableId: 'taxrate',
                                  linkedTableRemoteId: ['TaxRate'],
                                },
                              },
                            ),
                          ),
                        }),
                        Type.Null(),
                      ]),
                    ),
                  }),
                  Type.Null(),
                ]),
              ),
              Type.Null(),
            ]),
          ),
          TotalTax: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
          TxnTaxCodeRef: Type.Optional(
            Type.Union(
              [
                Type.Object({
                  name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                  value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                }),
                Type.Null(),
              ],
              { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'taxcode', linkedTableRemoteId: ['TaxCode'] } },
            ),
          ),
        }),
        Type.Null(),
      ]),
    ),
    domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sparse: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    TotalAmt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  },
  { $id: 'quickbooks/JournalEntry', additionalProperties: true },
);

const PaymentSchema = Type.Object(
  {
    ARAccountRef: Type.Optional(
      Type.Union([
        Type.Object({
          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    CurrencyRef: Type.Optional(
      Type.Union([
        Type.Object({
          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    CustomerRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'customer', linkedTableRemoteId: ['Customer'] } },
      ),
    ),
    DepositToAccountRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'account', linkedTableRemoteId: ['Account'] } },
      ),
    ),
    ExchangeRate: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    Id: Type.String({ [X_SCRATCH_READONLY]: true }),
    Line: Type.Optional(
      Type.Union([
        Type.Array(
          Type.Union([
            Type.Object({
              Amount: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
              LineEx: Type.Optional(
                Type.Union([
                  Type.Object({
                    any: Type.Optional(
                      Type.Union([
                        Type.Array(
                          Type.Union([
                            Type.Object({
                              declaredType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                              globalScope: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
                              name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                              nil: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
                              scope: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                              typeSubstituted: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
                              value: Type.Optional(
                                Type.Union([
                                  Type.Object({
                                    Name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                                    Value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                                  }),
                                  Type.Null(),
                                ]),
                              ),
                            }),
                            Type.Null(),
                          ]),
                        ),
                        Type.Null(),
                      ]),
                    ),
                  }),
                  Type.Null(),
                ]),
              ),
              LinkedTxn: Type.Optional(
                Type.Union([
                  Type.Array(
                    Type.Union([
                      Type.Object({
                        TxnId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                        TxnType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                      }),
                      Type.Null(),
                    ]),
                  ),
                  Type.Null(),
                ]),
              ),
            }),
            Type.Null(),
          ]),
        ),
        Type.Null(),
      ]),
    ),
    LinkedTxn: Type.Optional(
      Type.Union([
        Type.Array(
          Type.Union([
            Type.Object({
              TxnId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              TxnType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            }),
            Type.Null(),
          ]),
        ),
        Type.Null(),
      ]),
    ),
    MetaData: Type.Optional(
      Type.Union([
        Type.Object({
          CreateTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
          LastUpdatedTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
        }),
        Type.Null(),
      ]),
    ),
    PaymentMethodRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'paymentmethod', linkedTableRemoteId: ['PaymentMethod'] } },
      ),
    ),
    PaymentRefNum: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    PrivateNote: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    ProcessPayment: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    SyncToken: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    TotalAmt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    TxnDate: Type.Optional(
      Type.Union([Type.String({ format: 'date', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'date' }), Type.Null()]),
    ),
    UnappliedAmt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sparse: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  },
  { $id: 'quickbooks/Payment', additionalProperties: true },
);

const PaymentMethodSchema = Type.Object(
  {
    Active: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    Id: Type.String({ [X_SCRATCH_READONLY]: true }),
    MetaData: Type.Optional(
      Type.Union([
        Type.Object({
          CreateTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
          LastUpdatedTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
        }),
        Type.Null(),
      ]),
    ),
    Name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    SyncToken: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    Type: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sparse: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  },
  { $id: 'quickbooks/PaymentMethod', additionalProperties: true },
);

const PurchaseSchema = Type.Object(
  {
    AccountRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'account', linkedTableRemoteId: ['Account'] } },
      ),
    ),
    Credit: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    CurrencyRef: Type.Optional(
      Type.Union([
        Type.Object({
          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    DocNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    EntityRef: Type.Optional(
      Type.Union([
        Type.Object({
          type: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    ExchangeRate: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    Id: Type.String({ [X_SCRATCH_READONLY]: true }),
    Line: Type.Optional(
      Type.Union([
        Type.Array(
          Type.Union([
            Type.Object({
              AccountBasedExpenseLineDetail: Type.Optional(
                Type.Union([
                  Type.Object({
                    AccountRef: Type.Optional(
                      Type.Union(
                        [
                          Type.Object({
                            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          }),
                          Type.Null(),
                        ],
                        {
                          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
                            linkedTableId: 'account',
                            linkedTableRemoteId: ['Account'],
                          },
                        },
                      ),
                    ),
                    BillableStatus: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                    ClassRef: Type.Optional(
                      Type.Union([
                        Type.Object({
                          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                        }),
                        Type.Null(),
                      ]),
                    ),
                    CustomerRef: Type.Optional(
                      Type.Union(
                        [
                          Type.Object({
                            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          }),
                          Type.Null(),
                        ],
                        {
                          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
                            linkedTableId: 'customer',
                            linkedTableRemoteId: ['Customer'],
                          },
                        },
                      ),
                    ),
                    TaxCodeRef: Type.Optional(
                      Type.Union(
                        [
                          Type.Object({
                            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          }),
                          Type.Null(),
                        ],
                        {
                          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
                            linkedTableId: 'taxcode',
                            linkedTableRemoteId: ['TaxCode'],
                          },
                        },
                      ),
                    ),
                  }),
                  Type.Null(),
                ]),
              ),
              Amount: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
              Description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              DetailType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              Id: Type.String({ [X_SCRATCH_READONLY]: true }),
              ItemBasedExpenseLineDetail: Type.Optional(
                Type.Union([
                  Type.Object({
                    BillableStatus: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                    ItemRef: Type.Optional(
                      Type.Union(
                        [
                          Type.Object({
                            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          }),
                          Type.Null(),
                        ],
                        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'item', linkedTableRemoteId: ['Item'] } },
                      ),
                    ),
                    Qty: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
                    TaxCodeRef: Type.Optional(
                      Type.Union(
                        [
                          Type.Object({
                            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          }),
                          Type.Null(),
                        ],
                        {
                          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
                            linkedTableId: 'taxcode',
                            linkedTableRemoteId: ['TaxCode'],
                          },
                        },
                      ),
                    ),
                    UnitPrice: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
                  }),
                  Type.Null(),
                ]),
              ),
            }),
            Type.Null(),
          ]),
        ),
        Type.Null(),
      ]),
    ),
    MetaData: Type.Optional(
      Type.Union([
        Type.Object({
          CreateTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
          LastUpdatedTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
        }),
        Type.Null(),
      ]),
    ),
    PaymentType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    PrintStatus: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    PrivateNote: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    PurchaseEx: Type.Optional(
      Type.Union([
        Type.Object({
          any: Type.Optional(
            Type.Union([
              Type.Array(
                Type.Union([
                  Type.Object({
                    declaredType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                    globalScope: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
                    name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                    nil: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
                    scope: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                    typeSubstituted: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
                    value: Type.Optional(
                      Type.Union([
                        Type.Object({
                          Name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          Value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                        }),
                        Type.Null(),
                      ]),
                    ),
                  }),
                  Type.Null(),
                ]),
              ),
              Type.Null(),
            ]),
          ),
        }),
        Type.Null(),
      ]),
    ),
    RemitToAddr: Type.Optional(
      Type.Union([
        Type.Object({
          City: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          CountrySubDivisionCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Id: Type.String({ [X_SCRATCH_READONLY]: true }),
          Lat: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line1: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Long: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          PostalCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    SyncToken: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    TotalAmt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    TxnDate: Type.Optional(
      Type.Union([Type.String({ format: 'date', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'date' }), Type.Null()]),
    ),
    domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sparse: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  },
  { $id: 'quickbooks/Purchase', additionalProperties: true },
);

const PurchaseOrderSchema = Type.Object(
  {
    APAccountRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'account', linkedTableRemoteId: ['Account'] } },
      ),
    ),
    ClassRef: Type.Optional(
      Type.Union([
        Type.Object({
          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    CurrencyRef: Type.Optional(
      Type.Union([
        Type.Object({
          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    CustomField: Type.Optional(
      Type.Union([
        Type.Array(
          Type.Union([
            Type.Object({
              DefinitionId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              Name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              Type: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            }),
            Type.Null(),
          ]),
        ),
        Type.Null(),
      ]),
    ),
    DepartmentRef: Type.Optional(
      Type.Union([
        Type.Object({
          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    DocNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    DueDate: Type.Optional(
      Type.Union([Type.String({ format: 'date', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'date' }), Type.Null()]),
    ),
    EmailStatus: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    ExchangeRate: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    Id: Type.String({ [X_SCRATCH_READONLY]: true }),
    Line: Type.Optional(
      Type.Union([
        Type.Array(
          Type.Union([
            Type.Object({
              Amount: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
              Description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              DetailType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              Id: Type.String({ [X_SCRATCH_READONLY]: true }),
              ItemBasedExpenseLineDetail: Type.Optional(
                Type.Union([
                  Type.Object({
                    BillableStatus: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                    ClassRef: Type.Optional(
                      Type.Union([
                        Type.Object({
                          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                        }),
                        Type.Null(),
                      ]),
                    ),
                    CustomerRef: Type.Optional(
                      Type.Union(
                        [
                          Type.Object({
                            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          }),
                          Type.Null(),
                        ],
                        {
                          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
                            linkedTableId: 'customer',
                            linkedTableRemoteId: ['Customer'],
                          },
                        },
                      ),
                    ),
                    ItemRef: Type.Optional(
                      Type.Union(
                        [
                          Type.Object({
                            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          }),
                          Type.Null(),
                        ],
                        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'item', linkedTableRemoteId: ['Item'] } },
                      ),
                    ),
                    Qty: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
                    TaxCodeRef: Type.Optional(
                      Type.Union(
                        [
                          Type.Object({
                            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          }),
                          Type.Null(),
                        ],
                        {
                          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
                            linkedTableId: 'taxcode',
                            linkedTableRemoteId: ['TaxCode'],
                          },
                        },
                      ),
                    ),
                    UnitPrice: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
                  }),
                  Type.Null(),
                ]),
              ),
              LineNum: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
            }),
            Type.Null(),
          ]),
        ),
        Type.Null(),
      ]),
    ),
    LinkedTxn: Type.Optional(
      Type.Union([
        Type.Array(
          Type.Union([
            Type.Object({
              TxnId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              TxnType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            }),
            Type.Null(),
          ]),
        ),
        Type.Null(),
      ]),
    ),
    Memo: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    MetaData: Type.Optional(
      Type.Union([
        Type.Object({
          CreateTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
          LastUpdatedTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
        }),
        Type.Null(),
      ]),
    ),
    POStatus: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    PrivateNote: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    SalesTermRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'term', linkedTableRemoteId: ['Term'] } },
      ),
    ),
    ShipAddr: Type.Optional(
      Type.Union([
        Type.Object({
          Id: Type.String({ [X_SCRATCH_READONLY]: true }),
          Lat: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line1: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line2: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line3: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Long: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    ShipTo: Type.Optional(
      Type.Union([
        Type.Object({
          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    SyncToken: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    TotalAmt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    TxnDate: Type.Optional(
      Type.Union([Type.String({ format: 'date', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'date' }), Type.Null()]),
    ),
    TxnTaxDetail: Type.Optional(Type.Union([Type.Object({}), Type.Null()])),
    VendorAddr: Type.Optional(
      Type.Union([
        Type.Object({
          City: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Country: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Id: Type.String({ [X_SCRATCH_READONLY]: true }),
          Lat: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line1: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line2: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line3: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line4: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Long: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    VendorRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'vendor', linkedTableRemoteId: ['Vendor'] } },
      ),
    ),
    domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sparse: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  },
  { $id: 'quickbooks/PurchaseOrder', additionalProperties: true },
);

const RefundReceiptSchema = Type.Object(
  {
    ApplyTaxAfterDiscount: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    Balance: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    BillAddr: Type.Optional(
      Type.Union([
        Type.Object({
          Id: Type.String({ [X_SCRATCH_READONLY]: true }),
          Lat: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line1: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line2: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line3: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line4: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Long: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    BillEmail: Type.Optional(
      Type.Union([
        Type.Object({
          Address: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    CurrencyRef: Type.Optional(
      Type.Union([
        Type.Object({
          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    CustomField: Type.Optional(
      Type.Union([
        Type.Array(
          Type.Union([
            Type.Object({
              DefinitionId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              Name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              Type: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            }),
            Type.Null(),
          ]),
        ),
        Type.Null(),
      ]),
    ),
    CustomerMemo: Type.Optional(
      Type.Union([
        Type.Object({
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    CustomerRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'customer', linkedTableRemoteId: ['Customer'] } },
      ),
    ),
    DepositToAccountRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'account', linkedTableRemoteId: ['Account'] } },
      ),
    ),
    DocNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    ExchangeRate: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    HomeTotalAmt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    Id: Type.String({ [X_SCRATCH_READONLY]: true }),
    Line: Type.Optional(
      Type.Union([
        Type.Array(
          Type.Union([
            Type.Object({
              Amount: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
              Description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              DetailType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              Id: Type.String({ [X_SCRATCH_READONLY]: true }),
              LineNum: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
              SalesItemLineDetail: Type.Optional(
                Type.Union([
                  Type.Object({
                    ItemRef: Type.Optional(
                      Type.Union(
                        [
                          Type.Object({
                            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          }),
                          Type.Null(),
                        ],
                        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'item', linkedTableRemoteId: ['Item'] } },
                      ),
                    ),
                    Qty: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
                    TaxCodeRef: Type.Optional(
                      Type.Union(
                        [
                          Type.Object({
                            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          }),
                          Type.Null(),
                        ],
                        {
                          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
                            linkedTableId: 'taxcode',
                            linkedTableRemoteId: ['TaxCode'],
                          },
                        },
                      ),
                    ),
                    UnitPrice: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
                  }),
                  Type.Null(),
                ]),
              ),
              SubTotalLineDetail: Type.Optional(Type.Union([Type.Object({}), Type.Null()])),
            }),
            Type.Null(),
          ]),
        ),
        Type.Null(),
      ]),
    ),
    MetaData: Type.Optional(
      Type.Union([
        Type.Object({
          CreateTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
          LastUpdatedTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
        }),
        Type.Null(),
      ]),
    ),
    PaymentMethodRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'paymentmethod', linkedTableRemoteId: ['PaymentMethod'] } },
      ),
    ),
    PrintStatus: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    SyncToken: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    TotalAmt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    TxnDate: Type.Optional(
      Type.Union([Type.String({ format: 'date', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'date' }), Type.Null()]),
    ),
    TxnTaxDetail: Type.Optional(
      Type.Union([
        Type.Object({
          TotalTax: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sparse: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    FreeFormAddress: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  },
  { $id: 'quickbooks/RefundReceipt', additionalProperties: true },
);

const SalesReceiptSchema = Type.Object(
  {
    ApplyTaxAfterDiscount: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    Balance: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    BillAddr: Type.Optional(
      Type.Union([
        Type.Object({
          Id: Type.String({ [X_SCRATCH_READONLY]: true }),
          Lat: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line1: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line2: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line3: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line4: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Long: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    BillEmail: Type.Optional(
      Type.Union([
        Type.Object({
          Address: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    CurrencyRef: Type.Optional(
      Type.Union([
        Type.Object({
          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    CustomField: Type.Optional(
      Type.Union([
        Type.Array(
          Type.Union([
            Type.Object({
              DefinitionId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              Name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              Type: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            }),
            Type.Null(),
          ]),
        ),
        Type.Null(),
      ]),
    ),
    CustomerMemo: Type.Optional(
      Type.Union([
        Type.Object({
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    CustomerRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'customer', linkedTableRemoteId: ['Customer'] } },
      ),
    ),
    DepositToAccountRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'account', linkedTableRemoteId: ['Account'] } },
      ),
    ),
    DocNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    EmailStatus: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    ExchangeRate: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    HomeTotalAmt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    Id: Type.String({ [X_SCRATCH_READONLY]: true }),
    Line: Type.Optional(
      Type.Union([
        Type.Array(
          Type.Union([
            Type.Object({
              Amount: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
              Description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              DetailType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              DiscountLineDetail: Type.Optional(
                Type.Union([
                  Type.Object({
                    DiscountAccountRef: Type.Optional(
                      Type.Union(
                        [
                          Type.Object({
                            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          }),
                          Type.Null(),
                        ],
                        {
                          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
                            linkedTableId: 'account',
                            linkedTableRemoteId: ['Account'],
                          },
                        },
                      ),
                    ),
                    DiscountPercent: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
                    PercentBased: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
                  }),
                  Type.Null(),
                ]),
              ),
              Id: Type.String({ [X_SCRATCH_READONLY]: true }),
              LineNum: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
              SalesItemLineDetail: Type.Optional(
                Type.Union([
                  Type.Object({
                    ItemRef: Type.Optional(
                      Type.Union(
                        [
                          Type.Object({
                            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          }),
                          Type.Null(),
                        ],
                        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'item', linkedTableRemoteId: ['Item'] } },
                      ),
                    ),
                    Qty: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
                    TaxCodeRef: Type.Optional(
                      Type.Union(
                        [
                          Type.Object({
                            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          }),
                          Type.Null(),
                        ],
                        {
                          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
                            linkedTableId: 'taxcode',
                            linkedTableRemoteId: ['TaxCode'],
                          },
                        },
                      ),
                    ),
                    UnitPrice: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
                  }),
                  Type.Null(),
                ]),
              ),
              SubTotalLineDetail: Type.Optional(Type.Union([Type.Object({}), Type.Null()])),
            }),
            Type.Null(),
          ]),
        ),
        Type.Null(),
      ]),
    ),
    LinkedTxn: Type.Optional(
      Type.Union([
        Type.Array(
          Type.Union([
            Type.Object({
              TxnId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              TxnType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            }),
            Type.Null(),
          ]),
        ),
        Type.Null(),
      ]),
    ),
    MetaData: Type.Optional(
      Type.Union([
        Type.Object({
          CreateTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
          LastUpdatedTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
        }),
        Type.Null(),
      ]),
    ),
    PaymentMethodRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'paymentmethod', linkedTableRemoteId: ['PaymentMethod'] } },
      ),
    ),
    PaymentRefNum: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    PrintStatus: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    ShipAddr: Type.Optional(
      Type.Union([
        Type.Object({
          City: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Country: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          CountrySubDivisionCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Id: Type.String({ [X_SCRATCH_READONLY]: true }),
          Lat: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line1: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Long: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          PostalCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    SyncToken: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    TotalAmt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    TxnDate: Type.Optional(
      Type.Union([Type.String({ format: 'date', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'date' }), Type.Null()]),
    ),
    TxnTaxDetail: Type.Optional(
      Type.Union([
        Type.Object({
          TotalTax: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sparse: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    FreeFormAddress: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    ShipFromAddr: Type.Optional(Type.Union([Type.Object({}), Type.Null()])),
  },
  { $id: 'quickbooks/SalesReceipt', additionalProperties: true },
);

const TaxCodeSchema = Type.Object(
  {
    Active: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    Description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    Hidden: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    Id: Type.String({ [X_SCRATCH_READONLY]: true }),
    MetaData: Type.Optional(
      Type.Union([
        Type.Object({
          CreateTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
          LastUpdatedTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
        }),
        Type.Null(),
      ]),
    ),
    Name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    PurchaseTaxRateList: Type.Optional(Type.Union([Type.Object({}), Type.Null()])),
    SalesTaxRateList: Type.Optional(
      Type.Union([
        Type.Object({
          TaxRateDetail: Type.Optional(
            Type.Union([
              Type.Array(
                Type.Union([
                  Type.Object({
                    TaxOrder: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
                    TaxRateRef: Type.Optional(
                      Type.Union(
                        [
                          Type.Object({
                            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                          }),
                          Type.Null(),
                        ],
                        {
                          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
                            linkedTableId: 'taxrate',
                            linkedTableRemoteId: ['TaxRate'],
                          },
                        },
                      ),
                    ),
                    TaxTypeApplicable: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                  }),
                  Type.Null(),
                ]),
              ),
              Type.Null(),
            ]),
          ),
        }),
        Type.Null(),
      ]),
    ),
    SyncToken: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    TaxGroup: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    Taxable: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sparse: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    TaxCodeConfigType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { $id: 'quickbooks/TaxCode', additionalProperties: true },
);

const TaxRateSchema = Type.Object(
  {
    Active: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    AgencyRef: Type.Optional(
      Type.Union([
        Type.Object({
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    Description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    DisplayType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    EffectiveTaxRate: Type.Optional(Type.String()),
    Id: Type.String({ [X_SCRATCH_READONLY]: true }),
    MetaData: Type.Optional(
      Type.Union([
        Type.Object({
          CreateTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
          LastUpdatedTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
        }),
        Type.Null(),
      ]),
    ),
    Name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    RateValue: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    SpecialTaxType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    SyncToken: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sparse: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  },
  { $id: 'quickbooks/TaxRate', additionalProperties: true },
);

const TermSchema = Type.Object(
  {
    Active: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    DayOfMonthDue: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    DiscountDayOfMonth: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    DiscountDays: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    DiscountPercent: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    DueDays: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    DueNextMonthDays: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    Id: Type.String({ [X_SCRATCH_READONLY]: true }),
    MetaData: Type.Optional(
      Type.Union([
        Type.Object({
          CreateTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
          LastUpdatedTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
        }),
        Type.Null(),
      ]),
    ),
    Name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    SyncToken: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    Type: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sparse: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  },
  { $id: 'quickbooks/Term', additionalProperties: true },
);

const TimeActivitySchema = Type.Object(
  {
    BillableStatus: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    CustomerRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'customer', linkedTableRemoteId: ['Customer'] } },
      ),
    ),
    Description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    EmployeeRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'employee', linkedTableRemoteId: ['Employee'] } },
      ),
    ),
    HourlyRate: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    Hours: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    Id: Type.String({ [X_SCRATCH_READONLY]: true }),
    ItemRef: Type.Optional(
      Type.Union(
        [
          Type.Object({
            name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ],
        { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'item', linkedTableRemoteId: ['Item'] } },
      ),
    ),
    MetaData: Type.Optional(
      Type.Union([
        Type.Object({
          CreateTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
          LastUpdatedTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
        }),
        Type.Null(),
      ]),
    ),
    Minutes: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    NameOf: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    SyncToken: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    Taxable: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    TxnDate: Type.Optional(
      Type.Union([Type.String({ format: 'date', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'date' }), Type.Null()]),
    ),
    domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sparse: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    CostRate: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    Seconds: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    TimeChargeId: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  },
  { $id: 'quickbooks/TimeActivity', additionalProperties: true },
);

const VendorSchema = Type.Object(
  {
    AcctNum: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    Active: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    Balance: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    BillAddr: Type.Optional(
      Type.Union([
        Type.Object({
          City: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Country: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          CountrySubDivisionCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Id: Type.String({ [X_SCRATCH_READONLY]: true }),
          Lat: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Line1: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          Long: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          PostalCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    CompanyName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    CurrencyRef: Type.Optional(
      Type.Union([
        Type.Object({
          name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    DisplayName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    FamilyName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    Fax: Type.Optional(
      Type.Union([
        Type.Object({
          FreeFormNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    GivenName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    Id: Type.String({ [X_SCRATCH_READONLY]: true }),
    MetaData: Type.Optional(
      Type.Union([
        Type.Object({
          CreateTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
          LastUpdatedTime: Type.Optional(
            Type.Union([
              Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }),
              Type.Null(),
            ]),
          ),
        }),
        Type.Null(),
      ]),
    ),
    MiddleName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    Mobile: Type.Optional(
      Type.Union([
        Type.Object({
          FreeFormNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    PrimaryEmailAddr: Type.Optional(
      Type.Union([
        Type.Object({
          Address: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    PrimaryPhone: Type.Optional(
      Type.Union([
        Type.Object({
          FreeFormNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    PrintOnCheckName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    Suffix: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    SyncToken: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    TaxIdentifier: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    TermRef: Type.Optional(
      Type.Union([
        Type.Object({
          value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    Title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    Vendor1099: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    WebAddr: Type.Optional(
      Type.Union([
        Type.Object({
          URI: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        Type.Null(),
      ]),
    ),
    domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    V4IDPseudonym: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    BillRate: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  },
  { $id: 'quickbooks/Vendor', additionalProperties: true },
);

/**
 * Map from QuickBooks entity type to its static TypeBox schema.
 */
export const QBO_SCHEMA_MAP: Record<QuickBooksEntityType, TSchema> = {
  Account: AccountSchema,
  Bill: BillSchema,
  BillPayment: BillPaymentSchema,
  CompanyInfo: CompanyInfoSchema,
  CreditMemo: CreditMemoSchema,
  Customer: CustomerSchema,
  Deposit: DepositSchema,
  Employee: EmployeeSchema,
  Estimate: EstimateSchema,
  Invoice: InvoiceSchema,
  Item: ItemSchema,
  JournalEntry: JournalEntrySchema,
  Payment: PaymentSchema,
  PaymentMethod: PaymentMethodSchema,
  Purchase: PurchaseSchema,
  PurchaseOrder: PurchaseOrderSchema,
  RefundReceipt: RefundReceiptSchema,
  SalesReceipt: SalesReceiptSchema,
  TaxCode: TaxCodeSchema,
  TaxRate: TaxRateSchema,
  Term: TermSchema,
  TimeActivity: TimeActivitySchema,
  Vendor: VendorSchema,
};
