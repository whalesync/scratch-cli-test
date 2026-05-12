import { Type } from '@sinclair/typebox';
import { TableViewCol, X_SCRATCH_FOREIGN_KEY_OPTIONS, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { buildStripeDefaultView } from '../stripe-default-view';

describe('buildStripeDefaultView', () => {
  function buildCustomerSchema() {
    return Type.Object({
      id: Type.String({ [X_SCRATCH_READONLY]: true }),
      object: Type.String({ [X_SCRATCH_READONLY]: true }),
      name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      email: Type.Optional(Type.Union([Type.String({ format: 'email' }), Type.Null()])),
      phone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      address: Type.Optional(
        Type.Union(
          [
            Type.Object({
              city: Type.Union([Type.String(), Type.Null()]),
              country: Type.Union([Type.String(), Type.Null()]),
            }),
            Type.Null(),
          ],
          { [X_SCRATCH_READONLY]: true },
        ),
      ),
      metadata: Type.Optional(Type.Record(Type.String(), Type.String(), { [X_SCRATCH_READONLY]: true })),
      currency: Type.Optional(Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true })),
      balance: Type.Optional(Type.Number({ [X_SCRATCH_READONLY]: true })),
      delinquent: Type.Optional(Type.Boolean({ [X_SCRATCH_READONLY]: true })),
      livemode: Type.Boolean({ [X_SCRATCH_READONLY]: true }),
      created: Type.Number({ [X_SCRATCH_READONLY]: true }),
    });
  }

  const schema = buildCustomerSchema();
  const view = buildStripeDefaultView(schema, 'customers');

  it('should return a view named "Default"', () => {
    expect(view.name).toBe('Default');
  });

  it('should place priority fields first in the expected order for customers', () => {
    const paths = view.cols.map((c) => (c as TableViewCol).path);
    const nameIdx = paths.indexOf('name');
    const idIdx = paths.indexOf('id');
    const emailIdx = paths.indexOf('email');
    const phoneIdx = paths.indexOf('phone');
    const descIdx = paths.indexOf('description');
    const currencyIdx = paths.indexOf('currency');
    const balanceIdx = paths.indexOf('balance');
    const createdIdx = paths.indexOf('created');

    expect(nameIdx).toBe(0);
    expect(idIdx).toBeLessThan(emailIdx);
    expect(emailIdx).toBeLessThan(phoneIdx);
    expect(phoneIdx).toBeLessThan(descIdx);
    expect(descIdx).toBeLessThan(currencyIdx);
    expect(currencyIdx).toBeLessThan(balanceIdx);
    expect(balanceIdx).toBeLessThan(createdIdx);
  });

  it('should place non-priority fields after priority fields alphabetically', () => {
    const paths = view.cols.map((c) => (c as TableViewCol).path);
    const createdIdx = paths.indexOf('created'); // last priority field
    const addressIdx = paths.indexOf('address');
    const livemodeIdx = paths.indexOf('livemode');
    const objectIdx = paths.indexOf('object');

    expect(addressIdx).toBeGreaterThan(createdIdx);
    expect(livemodeIdx).toBeGreaterThan(createdIdx);
    expect(objectIdx).toBeGreaterThan(createdIdx);
  });

  it('should propagate readonly from schema', () => {
    const idCol = view.cols.find((c) => c.kind === 'col' && c.path === 'id') as TableViewCol;
    expect(idCol.readonly).toBe(true);

    const nameCol = view.cols.find((c) => c.kind === 'col' && c.path === 'name') as TableViewCol;
    expect(nameCol.readonly).toBeUndefined();
  });

  it('should map number fields to number type', () => {
    const balance = view.cols.find((c) => c.kind === 'col' && c.path === 'balance') as TableViewCol;
    expect(balance.type).toBe('number');

    const created = view.cols.find((c) => c.kind === 'col' && c.path === 'created') as TableViewCol;
    expect(created.type).toBe('number');
  });

  it('should map boolean fields to checkbox type', () => {
    const delinquent = view.cols.find((c) => c.kind === 'col' && c.path === 'delinquent') as TableViewCol;
    expect(delinquent.type).toBe('checkbox');
  });

  it('should map nested object unions to object type', () => {
    const address = view.cols.find((c) => c.kind === 'col' && c.path === 'address') as TableViewCol;
    expect(address.type).toBe('object');
  });

  it('should map Record (metadata) to object type', () => {
    const metadata = view.cols.find((c) => c.kind === 'col' && c.path === 'metadata') as TableViewCol;
    expect(metadata.type).toBe('object');
  });

  it('should hide system fields', () => {
    const objectCol = view.cols.find((c) => c.kind === 'col' && c.path === 'object') as TableViewCol;
    expect(objectCol.hidden).toBe(true);

    const livemodeCol = view.cols.find((c) => c.kind === 'col' && c.path === 'livemode') as TableViewCol;
    expect(livemodeCol.hidden).toBe(true);

    const metadataCol = view.cols.find((c) => c.kind === 'col' && c.path === 'metadata') as TableViewCol;
    expect(metadataCol.hidden).toBe(true);

    const addressCol = view.cols.find((c) => c.kind === 'col' && c.path === 'address') as TableViewCol;
    expect(addressCol.hidden).toBe(true);
  });

  it('should not hide business fields', () => {
    const nameCol = view.cols.find((c) => c.kind === 'col' && c.path === 'name') as TableViewCol;
    expect(nameCol.hidden).toBeUndefined();

    const emailCol = view.cols.find((c) => c.kind === 'col' && c.path === 'email') as TableViewCol;
    expect(emailCol.hidden).toBeUndefined();
  });

  it('should format snake_case field names as Title Case', () => {
    const col = view.cols.find((c) => c.kind === 'col' && c.path === 'created') as TableViewCol;
    expect(col.name).toBe('Created');

    // Multi-word field (not in this schema but test the formatter indirectly via another entity)
    const invoiceView = buildStripeDefaultView(
      Type.Object({
        amount_due: Type.Number({ [X_SCRATCH_READONLY]: true }),
      }),
      'invoices',
    );
    const amountDue = invoiceView.cols.find((c) => c.kind === 'col' && c.path === 'amount_due') as TableViewCol;
    expect(amountDue.name).toBe('Amount Due');
  });

  it('should handle an empty schema gracefully', () => {
    const empty = Type.Object({});
    const emptyView = buildStripeDefaultView(empty, 'customers');
    expect(emptyView.cols).toEqual([]);
  });

  it('should not produce any banner groups', () => {
    const groups = view.cols.filter((c) => c.kind === 'banner-group');
    expect(groups.length).toBe(0);
  });

  describe('entity-specific priority ordering', () => {
    it('should prioritize amount and status for charges', () => {
      const chargeSchema = Type.Object({
        id: Type.String({ [X_SCRATCH_READONLY]: true }),
        object: Type.String({ [X_SCRATCH_READONLY]: true }),
        customer: Type.Optional(
          Type.Union([Type.String(), Type.Null()], {
            [X_SCRATCH_READONLY]: true,
            [X_SCRATCH_FOREIGN_KEY_OPTIONS]: { linkedTableId: 'customers' },
          }),
        ),
        amount: Type.Number({ [X_SCRATCH_READONLY]: true }),
        currency: Type.String({ [X_SCRATCH_READONLY]: true }),
        status: Type.String({ [X_SCRATCH_READONLY]: true }),
        paid: Type.Boolean({ [X_SCRATCH_READONLY]: true }),
        captured: Type.Boolean({ [X_SCRATCH_READONLY]: true }),
        refunded: Type.Boolean({ [X_SCRATCH_READONLY]: true }),
        description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        created: Type.Number({ [X_SCRATCH_READONLY]: true }),
        livemode: Type.Boolean({ [X_SCRATCH_READONLY]: true }),
      });
      const chargeView = buildStripeDefaultView(chargeSchema, 'charges');
      const paths = chargeView.cols.map((c) => (c as TableViewCol).path);

      expect(paths[0]).toBe('id');
      expect(paths[1]).toBe('customer');
      expect(paths[2]).toBe('amount');
      expect(paths[3]).toBe('currency');
      expect(paths[4]).toBe('status');
      expect(paths[5]).toBe('paid');
    });

    it('should prioritize number and amount_due for invoices', () => {
      const invoiceSchema = Type.Object({
        id: Type.String({ [X_SCRATCH_READONLY]: true }),
        object: Type.String({ [X_SCRATCH_READONLY]: true }),
        number: Type.Optional(Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true })),
        customer: Type.Optional(Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true })),
        status: Type.Optional(Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true })),
        currency: Type.String({ [X_SCRATCH_READONLY]: true }),
        amount_due: Type.Number({ [X_SCRATCH_READONLY]: true }),
        total: Type.Number({ [X_SCRATCH_READONLY]: true }),
        paid: Type.Boolean({ [X_SCRATCH_READONLY]: true }),
        created: Type.Number({ [X_SCRATCH_READONLY]: true }),
        livemode: Type.Boolean({ [X_SCRATCH_READONLY]: true }),
      });
      const invoiceView = buildStripeDefaultView(invoiceSchema, 'invoices');
      const paths = invoiceView.cols.map((c) => (c as TableViewCol).path);

      expect(paths[0]).toBe('number');
      expect(paths[1]).toBe('id');
      expect(paths[2]).toBe('customer');
      expect(paths[3]).toBe('status');
      expect(paths[4]).toBe('currency');
      expect(paths[5]).toBe('amount_due');
    });
  });
});
