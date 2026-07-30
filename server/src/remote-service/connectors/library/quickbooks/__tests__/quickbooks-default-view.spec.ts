import { Type } from '@sinclair/typebox';
import {
  TableViewCol,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { buildQuickBooksDefaultView } from '../quickbooks-default-view';

/**
 * Build a Ref field (object with name + value, wrapped in Optional Union), matching
 * the codegen's shape: the foreign-key annotation rides on the Union, not the object.
 */
function refField(linkedTableId?: string) {
  const obj = Type.Object({
    name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  });
  return Type.Optional(
    Type.Union(
      [obj, Type.Null()],
      linkedTableId
        ? { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId, linkedTableRemoteId: [linkedTableId] } }
        : undefined,
    ),
  );
}

/** Build a Ref field QBO returns WITHOUT a `name` — e.g. `ParentRef`, `Vendor.TermRef`. */
function valueOnlyRefField(linkedTableId?: string) {
  const obj = Type.Object({ value: Type.Optional(Type.Union([Type.String(), Type.Null()])) });
  return Type.Optional(
    Type.Union(
      [obj, Type.Null()],
      linkedTableId
        ? { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId, linkedTableRemoteId: [linkedTableId] } }
        : undefined,
    ),
  );
}

/** Build a date field matching the QuickBooks schema pattern. */
function dateField() {
  return Type.Optional(
    Type.Union([Type.String({ format: 'date', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'date' }), Type.Null()]),
  );
}

/** Build a datetime field matching the QuickBooks schema pattern. */
function datetimeField() {
  return Type.Optional(
    Type.Union([Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }), Type.Null()]),
  );
}

/** Build a MetaData field matching the QuickBooks schema pattern. */
function metaDataField() {
  return Type.Optional(
    Type.Union([
      Type.Object({
        CreateTime: datetimeField(),
        LastUpdatedTime: datetimeField(),
      }),
      Type.Null(),
    ]),
  );
}

function makeCustomerSchema() {
  return Type.Object(
    {
      Active: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
      Balance: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
      CompanyName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      DisplayName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      Id: Type.String({ [X_SCRATCH_READONLY]: true }),
      MetaData: metaDataField(),
      PrimaryEmailAddr: Type.Optional(
        Type.Union([Type.Object({ Address: Type.Optional(Type.Union([Type.String(), Type.Null()])) }), Type.Null()]),
      ),
      PrimaryPhone: Type.Optional(
        Type.Union([
          Type.Object({ FreeFormNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])) }),
          Type.Null(),
        ]),
      ),
      CurrencyRef: refField(),
      ParentRef: valueOnlyRefField('Customer'),
      WebAddr: Type.Optional(
        Type.Union([Type.Object({ URI: Type.Optional(Type.Union([Type.String(), Type.Null()])) }), Type.Null()]),
      ),
      SyncToken: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      sparse: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    },
    { additionalProperties: true },
  );
}

function makeInvoiceSchema() {
  return Type.Object(
    {
      Balance: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
      CustomerRef: refField('Customer'),
      DocNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      DueDate: dateField(),
      Id: Type.String({ [X_SCRATCH_READONLY]: true }),
      MetaData: metaDataField(),
      SyncToken: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      TotalAmt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
      TxnDate: dateField(),
      domain: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      sparse: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    },
    { additionalProperties: true },
  );
}

describe('buildQuickBooksDefaultView', () => {
  describe('view basics', () => {
    it('should return a view named "Default"', () => {
      const view = buildQuickBooksDefaultView(makeCustomerSchema(), 'Customer');
      expect(view.name).toBe('Default');
    });
  });

  describe('priority ordering for Customer', () => {
    const view = buildQuickBooksDefaultView(makeCustomerSchema(), 'Customer');
    const paths = view.cols.map((c) => (c as TableViewCol).path);

    it('should place DisplayName first', () => {
      expect(paths[0]).toBe('DisplayName');
    });

    it('should place Id second', () => {
      expect(paths[1]).toBe('Id');
    });

    it('should place priority fields before non-priority fields', () => {
      const displayNameIdx = paths.indexOf('DisplayName');
      const balanceIdx = paths.indexOf('Balance');
      const companyNameIdx = paths.indexOf('CompanyName');
      // All are priority fields, but DisplayName < Balance < CompanyName in priority order
      expect(displayNameIdx).toBeLessThan(balanceIdx);
      expect(balanceIdx).toBeLessThan(companyNameIdx);
    });
  });

  describe('priority ordering for Invoice', () => {
    const view = buildQuickBooksDefaultView(makeInvoiceSchema(), 'Invoice');
    const paths = view.cols.map((c) => (c as TableViewCol).path);

    it('should place DocNumber first', () => {
      expect(paths[0]).toBe('DocNumber');
    });

    it('should place Id second', () => {
      expect(paths[1]).toBe('Id');
    });

    it('should place CustomerRef third', () => {
      expect(paths[2]).toBe('CustomerRef');
    });

    it('should place TotalAmt before Balance', () => {
      const totalAmtIdx = paths.indexOf('TotalAmt');
      const balanceIdx = paths.indexOf('Balance');
      expect(totalAmtIdx).toBeLessThan(balanceIdx);
    });
  });

  describe('hidden fields', () => {
    const view = buildQuickBooksDefaultView(makeCustomerSchema(), 'Customer');

    it('should hide MetaData', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'MetaData') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should hide SyncToken', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'SyncToken') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should hide domain', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'domain') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should hide sparse', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'sparse') as TableViewCol;
      expect(col.hidden).toBe(true);
    });

    it('should not hide regular fields', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'DisplayName') as TableViewCol;
      expect(col.hidden).toBeUndefined();
    });
  });

  describe('type mapping', () => {
    const view = buildQuickBooksDefaultView(makeInvoiceSchema(), 'Invoice');

    it('should map date connector data type to date', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'DueDate') as TableViewCol;
      expect(col.type).toBe('date');
    });

    it('should map number fields to number', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'TotalAmt') as TableViewCol;
      expect(col.type).toBe('number');
    });

    it('should map boolean fields to checkbox', () => {
      const customerView = buildQuickBooksDefaultView(makeCustomerSchema(), 'Customer');
      const col = customerView.cols.find((c) => c.kind === 'col' && c.path === 'Active') as TableViewCol;
      expect(col.type).toBe('checkbox');
    });

    it('should map object fields to object', () => {
      const customerView = buildQuickBooksDefaultView(makeCustomerSchema(), 'Customer');
      const col = customerView.cols.find((c) => c.kind === 'col' && c.path === 'MetaData') as TableViewCol;
      expect(col.type).toBe('object');
    });

    it('should map datetime connector data type to date', () => {
      const schema = Type.Object({
        CreatedAt: Type.Optional(
          Type.Union([Type.String({ format: 'date-time', [X_SCRATCH_CONNECTOR_DATA_TYPE]: 'datetime' }), Type.Null()]),
        ),
      });
      const v = buildQuickBooksDefaultView(schema, 'Unknown');
      const col = v.cols.find((c) => c.kind === 'col' && c.path === 'CreatedAt') as TableViewCol;
      expect(col.type).toBe('date');
    });
  });

  describe('readonly propagation', () => {
    const view = buildQuickBooksDefaultView(makeCustomerSchema(), 'Customer');

    it('should mark Id as readonly', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'Id') as TableViewCol;
      expect(col.readonly).toBe(true);
    });

    it('should not mark non-readonly fields as readonly', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'DisplayName') as TableViewCol;
      expect(col.readonly).toBeUndefined();
    });
  });

  describe('Ref columns with a foreign-key target (DEV-11132)', () => {
    const view = buildQuickBooksDefaultView(makeInvoiceSchema(), 'Invoice');
    const col = view.cols.find((c) => c.kind === 'col' && c.path === 'CustomerRef') as TableViewCol;

    it('should declare the foreign key from the schema annotation', () => {
      expect(col.foreignKey).toEqual({
        linkedTableId: 'Customer',
        linkedTableRemoteId: ['Customer'],
        isSingleValued: true,
      });
    });

    it('should NOT collapse to a subfield, which would bypass foreign-key resolution', () => {
      expect(col.subfields).toBeUndefined();
      expect(col.selectedSubfield).toBeUndefined();
      expect(col.path).toBe('CustomerRef');
    });

    it('should export the ref id via codec.toCore while displaying its name', () => {
      expect(col.codec?.toCore).toEqual({ type: 'jsonpath', options: { expression: '$.value' } });
      expect(col.displayTransformer).toEqual({ type: 'jsonpath', options: { expression: '$.name' } });
    });

    it('should display the id for a ref QBO returns without a name', () => {
      const customerView = buildQuickBooksDefaultView(makeCustomerSchema(), 'Customer');
      const parentCol = customerView.cols.find((c) => c.kind === 'col' && c.path === 'ParentRef') as TableViewCol;
      expect(parentCol.foreignKey?.linkedTableId).toBe('Customer');
      expect(parentCol.displayTransformer).toEqual({ type: 'jsonpath', options: { expression: '$.value' } });
      expect(parentCol.codec?.toCore).toEqual({ type: 'jsonpath', options: { expression: '$.value' } });
    });
  });

  describe('Ref columns with no foreign-key target', () => {
    const view = buildQuickBooksDefaultView(makeCustomerSchema(), 'Customer');
    const col = view.cols.find((c) => c.kind === 'col' && c.path === 'CurrencyRef') as TableViewCol;

    it('should collapse an unlinked ref to its name label', () => {
      expect(col.foreignKey).toBeUndefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(col.subfields![0]).toEqual({ relativePath: 'name', name: 'Name', type: 'string' });
      expect(col.selectedSubfield).toBe(0);
    });
  });

  describe('single-value wrapper objects (DEV-11135)', () => {
    const view = buildQuickBooksDefaultView(makeCustomerSchema(), 'Customer');

    function subfieldOf(path: string) {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === path) as TableViewCol;
      expect(col.selectedSubfield).toBe(0);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return col.subfields![0];
    }

    it('should unwrap PrimaryEmailAddr to its Address, typed as an email', () => {
      expect(subfieldOf('PrimaryEmailAddr')).toEqual({ relativePath: 'Address', name: 'Address', type: 'email' });
    });

    it('should unwrap PrimaryPhone to its FreeFormNumber, typed as a phone', () => {
      expect(subfieldOf('PrimaryPhone')).toEqual({ relativePath: 'FreeFormNumber', name: 'Number', type: 'phone' });
    });

    it('should unwrap WebAddr to its URI, typed as a url', () => {
      expect(subfieldOf('WebAddr')).toEqual({ relativePath: 'URI', name: 'URI', type: 'url' });
    });

    it('should leave a genuinely composite object whole', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'MetaData') as TableViewCol;
      expect(col.subfields).toBeUndefined();
    });

    it('should leave a wrapper whose inner property the schema does not declare whole', () => {
      const schema = Type.Object({ PrimaryEmailAddr: Type.Optional(Type.Union([Type.Object({}), Type.Null()])) });
      const v = buildQuickBooksDefaultView(schema, 'Unknown');
      const col = v.cols.find((c) => c.kind === 'col' && c.path === 'PrimaryEmailAddr') as TableViewCol;
      expect(col.subfields).toBeUndefined();
    });
  });

  describe('fallback ordering for unknown entity types', () => {
    const schema = Type.Object({
      Name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      Active: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
      Id: Type.String({ [X_SCRATCH_READONLY]: true }),
    });
    const view = buildQuickBooksDefaultView(schema, 'UnknownEntity');
    const paths = view.cols.map((c) => (c as TableViewCol).path);

    it('should place Id first for unknown entity types', () => {
      expect(paths[0]).toBe('Id');
    });

    it('should keep remaining fields in schema order', () => {
      expect(paths[1]).toBe('Name');
      expect(paths[2]).toBe('Active');
    });
  });

  describe('empty schema', () => {
    it('should handle an empty schema', () => {
      const schema = Type.Object({});
      const view = buildQuickBooksDefaultView(schema, 'Customer');
      expect(view.name).toBe('Default');
      expect(view.cols).toHaveLength(0);
    });
  });
});
