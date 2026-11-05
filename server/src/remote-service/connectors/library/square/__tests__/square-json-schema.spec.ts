import { X_SCRATCH_FOREIGN_KEY_OPTIONS, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { EntityId } from '../../../types';
import { buildSquareJsonTableSpec, buildSquareRecordSchema, nonNullArmOf } from '../square-json-schema';
import { SQUARE_ENTITY_CONFIG_BY_ENTITY_TYPE, SQUARE_ENTITY_TYPES, SquareEntityType } from '../square-types';

interface SchemaNode {
  type?: string;
  format?: string;
  properties?: Record<string, SchemaNode>;
  anyOf?: SchemaNode[];
  [annotation: string]: unknown;
}

function topLevelProperties(entityType: SquareEntityType): Record<string, SchemaNode> {
  return (buildSquareRecordSchema(entityType) as SchemaNode).properties ?? {};
}

function tableId(entityType: SquareEntityType): EntityId {
  return { wsId: entityType, remoteId: [entityType] } as unknown as EntityId;
}

describe('buildSquareRecordSchema', () => {
  it.each(SQUARE_ENTITY_TYPES)('%s has an id and marks every top-level field read-only', (entityType) => {
    const properties = topLevelProperties(entityType);
    expect(properties.id).toBeDefined();
    for (const fieldSchema of Object.values(properties)) {
      expect(fieldSchema[X_SCRATCH_READONLY]).toBe(true);
    }
  });

  it('keeps only the catalog data property that matches the table', () => {
    const variationFieldNames = Object.keys(topLevelProperties('catalog_item_variations'));
    expect(variationFieldNames).toContain('item_variation_data');
    expect(variationFieldNames.filter((fieldName) => fieldName.endsWith('_data'))).toEqual(['item_variation_data']);
  });

  it('records Square timestamps as date-times and calendar dates as dates', () => {
    expect(nonNullArmOf(topLevelProperties('payments').created_at)?.format).toBe('date-time');
    expect(nonNullArmOf(topLevelProperties('payments').delayed_until)?.format).toBe('date-time');
    expect(nonNullArmOf(topLevelProperties('payouts').arrival_date)?.format).toBe('date');
    expect(nonNullArmOf(topLevelProperties('invoices').sale_or_service_date)?.format).toBe('date');
    expect(nonNullArmOf(topLevelProperties('payout_entries').effective_at)?.format).toBe('date-time');
    for (const subscriptionDateFieldName of ['start_date', 'canceled_date', 'charged_through_date', 'completed_date']) {
      expect(nonNullArmOf(topLevelProperties('subscriptions')[subscriptionDateFieldName])?.format).toBe('date');
    }
  });

  // Square allows a year-less `0000-MM-DD` birthday, which no date column can hold.
  it('leaves customer birthdays as plain strings', () => {
    expect(nonNullArmOf(topLevelProperties('customers').birthday)?.format).toBeUndefined();
  });

  it('formats timestamps nested below the top level too', () => {
    const tenderSchema = nonNullArmOf(topLevelProperties('orders').tenders) as SchemaNode & { items?: SchemaNode };
    expect(nonNullArmOf(tenderSchema.items?.properties?.created_at)?.format).toBe('date-time');
  });

  it('links payments to their location, order, customer, and team member as single-valued keys', () => {
    const properties = topLevelProperties('payments');
    expect(properties.location_id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({
      linkedTableId: 'locations',
      linkedTableRemoteId: ['locations'],
      isSingleValued: true,
    });
    expect(properties.order_id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toMatchObject({ linkedTableId: 'orders' });
    expect(properties.customer_id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toMatchObject({ linkedTableId: 'customers' });
    expect(properties.team_member_id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toMatchObject({ linkedTableId: 'team_members' });
  });

  it('links refunds to their payment', () => {
    expect(topLevelProperties('refunds').payment_id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toMatchObject({
      linkedTableId: 'payments',
    });
  });

  it('links payout entries to their payout, and gift card activities to their gift card and location', () => {
    expect(topLevelProperties('payout_entries').payout_id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({
      linkedTableId: 'payouts',
      linkedTableRemoteId: ['payouts'],
      isSingleValued: true,
    });
    const giftCardActivityProperties = topLevelProperties('gift_card_activities');
    expect(giftCardActivityProperties.gift_card_id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toMatchObject({
      linkedTableId: 'gift_cards',
    });
    expect(giftCardActivityProperties.location_id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toMatchObject({
      linkedTableId: 'locations',
    });
  });

  it('links subscriptions to their customer and location', () => {
    const subscriptionProperties = topLevelProperties('subscriptions');
    expect(subscriptionProperties.customer_id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toMatchObject({
      linkedTableId: 'customers',
    });
    expect(subscriptionProperties.location_id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toMatchObject({
      linkedTableId: 'locations',
    });
  });

  // The export layer's schema flattener keeps an annotated object whole, which would hide a money
  // object's `amount` from it. Nested nodes must stay annotation-free.
  it('never annotates nested objects', () => {
    const amountMoney = nonNullArmOf(topLevelProperties('payments').amount_money);
    expect(amountMoney?.[X_SCRATCH_READONLY]).toBeUndefined();
    expect(Object.keys(amountMoney?.properties ?? {}).sort()).toEqual(['amount', 'currency']);
  });

  it('does not mutate the shared generated schemas between builds', () => {
    buildSquareRecordSchema('catalog_items');
    expect(Object.keys(topLevelProperties('catalog_taxes'))).toContain('tax_data');
  });
});

describe('buildSquareJsonTableSpec', () => {
  it('uses the configured title and slug paths', () => {
    const spec = buildSquareJsonTableSpec(tableId('catalog_items'), 'catalog_items', 'production');
    expect(spec.idPath).toBe('id');
    expect(spec.titlePath).toBe('item_data.name');
    expect(spec.slugPath).toBe('item_data.name');
    expect(spec.name).toBe(SQUARE_ENTITY_CONFIG_BY_ENTITY_TYPE.catalog_items.displayName);
  });

  it('deep-links to the dashboard of the token’s environment', () => {
    expect(buildSquareJsonTableSpec(tableId('payments'), 'payments', 'production').remoteWebUrl).toBe(
      'https://app.squareup.com/dashboard/sales/transactions',
    );
    expect(buildSquareJsonTableSpec(tableId('payments'), 'payments', 'sandbox').remoteWebUrl).toBe(
      'https://app.squareupsandbox.com/dashboard/sales/transactions',
    );
  });

  it('omits the deep link for tables without a known dashboard page', () => {
    expect(buildSquareJsonTableSpec(tableId('refunds'), 'refunds', 'production').remoteWebUrl).toBeUndefined();
  });
});
