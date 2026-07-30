import { TSchema, Type } from '@sinclair/typebox';
import { TableView, TableViewCol, X_SCRATCH_FOREIGN_KEY_OPTIONS, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { EntityId } from '../../../types';
import { buildStripeDefaultView } from '../stripe-default-view';
import { buildStripeJsonTableSpec } from '../stripe-json-schema';
import { StripeEntityType } from '../stripe-types';

/** The view a real (generated) Stripe schema produces — the shape Live Export actually sees. */
function realView(entityType: StripeEntityType): TableView {
  const id = { wsId: entityType, remoteId: [entityType] } as unknown as EntityId;
  return buildStripeDefaultView(buildStripeJsonTableSpec(id, entityType).schema, entityType);
}

function col(view: TableView, path: string): TableViewCol | undefined {
  return view.cols.find((c) => c.kind === 'col' && c.path === path) as TableViewCol | undefined;
}

function colNames(view: TableView): string[] {
  return view.cols.map((c) => (c as TableViewCol).name ?? '');
}

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
    const livemodeIdx = paths.indexOf('livemode');
    const objectIdx = paths.indexOf('object');

    expect(paths.indexOf('address.city')).toBeGreaterThan(createdIdx);
    expect(livemodeIdx).toBeGreaterThan(createdIdx);
    expect(objectIdx).toBeGreaterThan(createdIdx);
  });

  it('should propagate readonly from schema', () => {
    expect(col(view, 'id')?.readonly).toBe(true);
    expect(col(view, 'name')?.readonly).toBeUndefined();
  });

  it('should map number fields to number type', () => {
    expect(col(view, 'balance')?.type).toBe('number');
  });

  it('should map boolean fields to checkbox type', () => {
    expect(col(view, 'delinquent')?.type).toBe('checkbox');
  });

  it('should map Record (metadata) to object type', () => {
    expect(col(view, 'metadata')?.type).toBe('object');
  });

  it('should hide only genuine plumbing', () => {
    expect(col(view, 'object')?.hidden).toBe(true);
    expect(col(view, 'livemode')?.hidden).toBe(true);
    expect(col(view, 'metadata')?.hidden).toBe(true);
  });

  it('should not hide business fields', () => {
    expect(col(view, 'name')?.hidden).toBeUndefined();
    expect(col(view, 'email')?.hidden).toBeUndefined();
  });

  it('should format snake_case field names as Title Case', () => {
    expect(col(view, 'created')?.name).toBe('Created');

    const invoiceView = buildStripeDefaultView(
      Type.Object({ amount_due: Type.Number({ [X_SCRATCH_READONLY]: true }) }),
      'invoices',
    );
    expect(col(invoiceView, 'amount_due')?.name).toBe('Amount Due');
  });

  it('should handle an empty schema gracefully', () => {
    expect(buildStripeDefaultView(Type.Object({}), 'customers').cols).toEqual([]);
  });

  it('should not produce any banner groups', () => {
    expect(view.cols.filter((c) => c.kind === 'banner-group').length).toBe(0);
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
      const paths = buildStripeDefaultView(chargeSchema, 'charges').cols.map((c) => (c as TableViewCol).path);

      expect(paths.slice(0, 6)).toEqual(['id', 'customer', 'amount', 'currency', 'status', 'paid']);
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
      const paths = buildStripeDefaultView(invoiceSchema, 'invoices').cols.map((c) => (c as TableViewCol).path);

      expect(paths.slice(0, 6)).toEqual(['number', 'id', 'customer', 'status', 'currency', 'amount_due']);
    });
  });

  // ── DEV-11145: Unix-epoch timestamps export as real dates, not raw numbers ──
  describe('Unix-epoch timestamps', () => {
    const customers = realView('customers');

    it('builds a date-backed column for an annotated timestamp', () => {
      const created = col(customers, 'created');

      // Rendered through the text cell (the only one that reads displayTransformer)…
      expect(created?.type).toBe('string');
      // …but exported as a real datetime, so the destination column keeps time-of-day.
      expect(created?.logicalType).toBe('datetime');
      expect(created?.displayTransformer).toEqual({ type: 'epoch_to_iso', options: { unit: 'seconds' } });
      expect(created?.codec?.toCore).toEqual({ type: 'epoch_to_iso', options: { unit: 'seconds' } });
      expect(created?.readonly).toBe(true);
    });

    it('leaves a genuine number alone', () => {
      const balance = col(customers, 'balance');

      expect(balance?.type).toBe('number');
      expect(balance?.logicalType).toBeUndefined();
      expect(balance?.codec).toBeUndefined();
    });

    it('converts nullable timestamps on subscriptions too', () => {
      const subscriptions = realView('subscriptions');

      for (const path of ['canceled_at', 'ended_at', 'start_date', 'trial_start', 'trial_end', 'created']) {
        expect(col(subscriptions, path)?.logicalType).toBe('datetime');
      }
    });

    it('converts timestamps nested inside an expanded composite', () => {
      const invoices = realView('invoices');

      expect(col(invoices, 'status_transitions.paid_at')?.logicalType).toBe('datetime');
      expect(col(invoices, 'status_transitions.paid_at')?.name).toBe('Status Transitions (Paid At)');
    });
  });

  // ── DEV-11148: address/shipping/images/items/billing_details reach a destination ──
  describe('previously dropped fields', () => {
    it('expands a customer address into one column per subfield plus a hidden raw container', () => {
      const customers = realView('customers');

      expect(col(customers, 'address.city')?.name).toBe('Address (City)');
      expect(col(customers, 'address.postal_code')?.name).toBe('Address (Postal Code)');
      expect(col(customers, 'address.city')?.hidden).toBeUndefined();
      expect(col(customers, 'address')?.name).toBe('Address (raw)');
      expect(col(customers, 'address')?.hidden).toBe(true);
    });

    it('recurses one level so a nested shipping address becomes real columns', () => {
      const customers = realView('customers');

      expect(col(customers, 'shipping.name')?.name).toBe('Shipping (Name)');
      expect(col(customers, 'shipping.address.line1')?.name).toBe('Shipping (Address Line1)');
      expect(col(customers, 'shipping.address.line1')?.hidden).toBeUndefined();
    });

    it('expands charge billing details', () => {
      const charges = realView('charges');

      expect(col(charges, 'billing_details.email')?.name).toBe('Billing Details (Email)');
      expect(col(charges, 'billing_details.address.city')?.name).toBe('Billing Details (Address City)');
    });

    it('exposes product images and subscription items instead of dropping them', () => {
      expect(col(realView('products'), 'images')?.hidden).toBeUndefined();
      expect(col(realView('subscriptions'), 'items')?.hidden).toBeUndefined();
    });

    it('keeps only genuine plumbing hidden', () => {
      const customers = realView('customers');
      const hiddenPaths = customers.cols
        .filter((c) => c.kind === 'col' && c.hidden && !(c.name ?? '').endsWith('(raw)'))
        .map((c) => (c as TableViewCol).path);

      expect(hiddenPaths.sort()).toEqual(['invoice_prefix', 'livemode', 'metadata', 'object']);
    });

    it('does not collide names between an address and a shipping address', () => {
      const names = colNames(realView('customers'));

      expect(new Set(names).size).toBe(names.length);
    });
  });

  // ── DEV-11149: prices.recurring plucks interval rather than exporting raw JSON ──
  describe('prices.recurring', () => {
    const prices = realView('prices');

    it('offers the useful inner scalars as subfields with interval preselected', () => {
      const recurring = col(prices, 'recurring');

      expect(recurring?.subfields).toEqual([
        { name: 'Interval', relativePath: 'interval', type: 'string', readonly: true },
        { name: 'Interval Count', relativePath: 'interval_count', type: 'number', readonly: true },
        { name: 'Usage Type', relativePath: 'usage_type', type: 'string', readonly: true },
      ]);
      expect(recurring?.selectedSubfield).toBe(0);
    });

    it('keeps the raw container reachable rather than expanding it away', () => {
      expect(col(prices, 'recurring')?.path).toBe('recurring');
      expect(col(prices, 'recurring')?.hidden).toBeUndefined();
    });

    it('only offers subfields the schema actually declares', () => {
      const view = buildStripeDefaultView(
        Type.Object({ recurring: Type.Object({ interval: Type.String() }) }),
        'prices',
      );

      expect(col(view, 'recurring')?.subfields).toEqual([
        { name: 'Interval', relativePath: 'interval', type: 'string' },
      ]);
    });
  });

  // The view is regenerated from a schema that may have been JSON-parsed off disk, where TypeBox's
  // `Kind` symbols are gone. A Kind-based type mapping silently types every column `undefined` there.
  it('types columns identically from a JSON round-tripped schema', () => {
    const id = { wsId: 'customers', remoteId: ['customers'] } as unknown as EntityId;
    const liveSchema = buildStripeJsonTableSpec(id, 'customers').schema;
    const roundTrippedSchema = JSON.parse(JSON.stringify(liveSchema)) as TSchema;

    const live = buildStripeDefaultView(liveSchema, 'customers');
    const roundTripped = buildStripeDefaultView(roundTrippedSchema, 'customers');

    expect(roundTripped).toEqual(live);
    expect(col(roundTripped, 'balance')?.type).toBe('number');
    expect(col(roundTripped, 'delinquent')?.type).toBe('checkbox');
  });
});
