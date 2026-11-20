/**
 * What a Shopify Live Export offers for the Customers and Orders tables: the default view → plan field selection
 * chain, walked the way the export walks it. A hidden view column is dropped from field selection, so these tests
 * check the paths the user is actually offered, not just the view's flags (DEV-12935).
 */

// Break the circular import chain: connector.ts → display-names.ts → registry → every connector → connector.ts.
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import { selectPlanFieldsFromTableView } from 'src/schema-builder/schema-builder-field-selection';
import { getSchemaAtFieldPath } from 'src/utils/field-path';
import { BaseJsonTableSpec } from '../../../types';
import { EntityType } from '../graphql/registry';
import { ShopifyConnector } from '../shopify-connector';

const connector = new ShopifyConnector({ shopDomain: 'my-store', accessToken: 'shpat_test' });

async function tableSpecFor(entityType: EntityType): Promise<BaseJsonTableSpec> {
  return connector.fetchJsonTableSpec({ wsId: entityType, remoteId: [entityType] });
}

/** Every path the plan would propose as a destination field, i.e. what the user is offered. */
async function exportedPathsFor(entityType: EntityType): Promise<string[]> {
  const tableSpec = await tableSpecFor(entityType);
  const view = connector.buildDefaultView(tableSpec);
  if (!view) throw new Error(`No default view for ${entityType}`);
  return selectPlanFieldsFromTableView({
    schema: tableSpec.schema,
    view,
    titlePath: tableSpec.titlePath,
    idPath: tableSpec.idPath,
  }).schemaFields.map((field) => field.path);
}

/**
 * Field names that are links, tokens, or personal identifiers: a buyer's order status page and payment links,
 * cart and checkout tokens, IP address, tax id, and ids at outside sign-in providers. Any `…Token` field counts.
 */
const LINK_TOKEN_OR_PERSONAL_IDENTIFIER_FIELD_NAMES = [
  'statusPageUrl',
  'additionalPaymentCollectionUrl',
  'clientIp',
  'taxId',
  'multipassIdentifier',
  'identityProviderSubjects',
];

function namesALinkTokenOrPersonalIdentifier(fieldName: string): boolean {
  return LINK_TOKEN_OR_PERSONAL_IDENTIFIER_FIELD_NAMES.includes(fieldName) || /Token$/.test(fieldName);
}

/** Every property name in a JSON schema, at any depth. */
function propertyNamesAtAnyDepth(schema: unknown): string[] {
  if (Array.isArray(schema)) return schema.flatMap(propertyNamesAtAnyDepth);
  if (schema === null || typeof schema !== 'object') return [];
  const schemaObject = schema as Record<string, unknown>;
  const ownPropertyNames =
    schemaObject.properties && typeof schemaObject.properties === 'object'
      ? Object.keys(schemaObject.properties as Record<string, unknown>)
      : [];
  return [...ownPropertyNames, ...Object.values(schemaObject).flatMap(propertyNamesAtAnyDepth)];
}

describe('Shopify Live Export of Customers and Orders (DEV-12935)', () => {
  // A guard for every Customers and Orders table: no exported column, and nothing inside an exported object
  // column, is a link, token, or personal identifier, so a JSON column can't carry one in an embedded object.
  it.each<EntityType>(['customers', 'orders', 'order_line_items', 'order_shipping_lines'])(
    'exports no column from %s that can hold a link, token, or personal identifier',
    async (entityType) => {
      const tableSpec = await tableSpecFor(entityType);
      for (const exportedPath of await exportedPathsFor(entityType)) {
        const exportedFieldName = exportedPath.split('.').pop() ?? exportedPath;
        const fieldNamesTheColumnCanHold = [
          exportedFieldName,
          ...propertyNamesAtAnyDepth(getSchemaAtFieldPath(tableSpec.schema, exportedPath)),
        ];
        expect({
          exportedPath,
          sensitiveFieldNames: fieldNamesTheColumnCanHold.filter(namesALinkTokenOrPersonalIdentifier),
        }).toEqual({ exportedPath, sensitiveFieldNames: [] });
      }
    },
  );

  it("exports a customer's last order as a link to Orders, not the whole order", async () => {
    const tableSpec = await tableSpecFor('customers');
    const view = connector.buildDefaultView(tableSpec);
    const lastOrderColumn = view?.cols.find((col) => col.kind === 'col' && col.path === 'lastOrder.id');

    expect(lastOrderColumn).toMatchObject({ name: 'Last Order', foreignKey: { linkedTableId: 'orders' } });
    expect(await exportedPathsFor('customers')).toContain('lastOrder.id');
    expect(await exportedPathsFor('customers')).not.toContain('lastOrder');
  });

  it("still exports a customer's name, email, phone, and address", async () => {
    expect(await exportedPathsFor('customers')).toEqual(
      expect.arrayContaining([
        'displayName',
        'firstName',
        'lastName',
        'defaultEmailAddress.emailAddress',
        'defaultPhoneNumber.phoneNumber',
        'defaultAddress',
      ]),
    );
  });

  it("still exports an order's name, email, customer link, and addresses", async () => {
    expect(await exportedPathsFor('orders')).toEqual(
      expect.arrayContaining(['name', 'email', 'customer.id', 'billingAddress', 'shippingAddress']),
    );
  });
});
