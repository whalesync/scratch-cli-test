import { Type } from '@sinclair/typebox';
import { TableViewCol, X_SCRATCH_CONNECTOR_DATA_TYPE, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { buildQuickBooksDefaultView } from '../quickbooks-default-view';

/** Build a Ref field (object with name + value, wrapped in Optional Union). */
function refField() {
  const obj = Type.Object({
    name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    value: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  });
  return Type.Optional(Type.Union([obj, Type.Null()]));
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
      CustomerRef: refField(),
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

  describe('Ref subfields', () => {
    const view = buildQuickBooksDefaultView(makeInvoiceSchema(), 'Invoice');

    it('should add name subfield to CustomerRef', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'CustomerRef') as TableViewCol;
      expect(col.subfields).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(col.subfields![0].relativePath).toBe('name');
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(col.subfields![0].name).toBe('Name');
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(col.subfields![0].type).toBe('string');
      expect(col.selectedSubfield).toBe(0);
    });

    it('should not add subfields to non-Ref object fields', () => {
      const customerView = buildQuickBooksDefaultView(makeCustomerSchema(), 'Customer');
      const col = customerView.cols.find((c) => c.kind === 'col' && c.path === 'PrimaryEmailAddr') as TableViewCol;
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
