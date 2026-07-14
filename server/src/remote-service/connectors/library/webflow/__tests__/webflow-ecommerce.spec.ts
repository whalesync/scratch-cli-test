import { TObject } from '@sinclair/typebox';
import { X_SCRATCH_READONLY } from '@spinner/shared-types';
import { WebflowConnector } from '../webflow-connector';
import { webflowEcommerceBasePath } from '../webflow-folder-paths';
import { buildWebflowJsonTableSpec, buildWebflowOrdersJsonTableSpec } from '../webflow-json-schema';
import { WebflowSchemaParser } from '../webflow-schema-parser';
import { Collection, isWebflowEcommerceCollectionSlug, Site, WEBFLOW_ORDERS_TABLE_ID_PREFIX } from '../webflow-types';

const site = { id: 'site-1', displayName: 'My Site', shortName: 'mysite' } as Site;

function makeCollection(displayName: string, slug: string, id = 'col-1'): Collection {
  return { id, displayName, slug, fields: [] } as unknown as Collection;
}

function collectionEntityId(id = 'col-1') {
  return { wsId: `${id}ws`, remoteId: ['site-1', id] };
}

describe('isWebflowEcommerceCollectionSlug (DEV-10729)', () => {
  it('matches the singular reserved ecommerce slugs Webflow actually uses', () => {
    expect(isWebflowEcommerceCollectionSlug('product')).toBe(true);
    expect(isWebflowEcommerceCollectionSlug('sku')).toBe(true);
    expect(isWebflowEcommerceCollectionSlug('category')).toBe(true);
  });

  it('also matches the plural forms defensively (the original exclusion filter used plurals)', () => {
    expect(isWebflowEcommerceCollectionSlug('products')).toBe(true);
    expect(isWebflowEcommerceCollectionSlug('skus')).toBe(true);
    expect(isWebflowEcommerceCollectionSlug('categories')).toBe(true);
  });

  it('does not match ordinary CMS collections or undefined', () => {
    expect(isWebflowEcommerceCollectionSlug('blog-posts')).toBe(false);
    expect(isWebflowEcommerceCollectionSlug('team-members')).toBe(false);
    expect(isWebflowEcommerceCollectionSlug(undefined)).toBe(false);
  });
});

describe('webflowEcommerceBasePath (DEV-10729)', () => {
  it('always groups under /<Site>/Ecommerce/', () => {
    expect(webflowEcommerceBasePath(site)).toEqual(['My Site', 'Ecommerce']);
  });
});

describe('buildWebflowJsonTableSpec — ecommerce collections route to /<Site>/Ecommerce/', () => {
  it.each([
    ['product', 'Products'],
    ['sku', 'SKUs'],
    ['category', 'Categories'],
  ])('collection with slug "%s" lands under /<Site>/Ecommerce/ regardless of structure version', (slug, name) => {
    const v1 = buildWebflowJsonTableSpec(collectionEntityId(), site, makeCollection(name, slug), 1);
    const v2 = buildWebflowJsonTableSpec(collectionEntityId(), site, makeCollection(name, slug), 2);
    // Ecommerce is a brand-new layout with no flat-v1 legacy: it always nests.
    expect(v1.basePath).toEqual(['My Site', 'Ecommerce']);
    expect(v2.basePath).toEqual(['My Site', 'Ecommerce']);
  });

  it('an ordinary CMS collection is unaffected (stays under Collections / flat)', () => {
    const v2 = buildWebflowJsonTableSpec(collectionEntityId(), site, makeCollection('Blog Posts', 'blog-posts'), 2);
    expect(v2.basePath).toEqual(['My Site', 'Collections']);
  });
});

describe('WebflowSchemaParser.parseTablePreview — ecommerce grouping', () => {
  const parser = new WebflowSchemaParser();

  it('groups an ecommerce collection preview under <Site>/Ecommerce', () => {
    const preview = parser.parseTablePreview(site, makeCollection('Products', 'product'), 2);
    expect(preview.parentPath).toBe('My Site/Ecommerce');
  });

  it('leaves an ordinary collection preview under <Site>/Collections (v2)', () => {
    const preview = parser.parseTablePreview(site, makeCollection('Blog Posts', 'blog-posts'), 2);
    expect(preview.parentPath).toBe('My Site/Collections');
  });
});

describe('buildWebflowOrdersJsonTableSpec (DEV-10729)', () => {
  const spec = buildWebflowOrdersJsonTableSpec(
    {
      wsId: `${WEBFLOW_ORDERS_TABLE_ID_PREFIX}site-1`,
      remoteId: ['site-1', `${WEBFLOW_ORDERS_TABLE_ID_PREFIX}site-1`],
    },
    site,
  );
  const schema = spec.schema as TObject;
  const props = schema.properties as Record<string, Record<string, unknown>>;

  it('groups under /<Site>/Ecommerce/ and is named Orders, keyed by orderId', () => {
    expect(spec.basePath).toEqual(['My Site', 'Ecommerce']);
    expect(spec.name).toBe('Orders');
    expect(spec.idPath).toBe('orderId');
  });

  it('is permissive (additionalProperties) so verbatim orders validate without noise', () => {
    expect((schema as unknown as { additionalProperties?: unknown }).additionalProperties).toBe(true);
  });

  it('marks orderId read-only', () => {
    expect(props.orderId[X_SCRATCH_READONLY]).toBe(true);
  });

  it('default view exposes exactly the four writable fields as editable, the rest read-only', () => {
    // Schema-gen no longer stamps defaultView; the view is built on demand from the
    // spec by the connector (which recovers the 'orders' entity type from the id prefix).
    const cols = new WebflowConnector('test-token').buildDefaultView(spec)?.cols ?? [];
    const byPath = new Map(cols.filter((c) => c.kind === 'col').map((c) => [(c as { path: string }).path, c]));

    // Writable: comment + the three shipping-tracking fields (no readonly flag).
    for (const writable of ['comment', 'shippingProvider', 'shippingTracking', 'shippingTrackingURL']) {
      expect(byPath.has(writable)).toBe(true);
      expect((byPath.get(writable) as { readonly?: boolean }).readonly).toBeUndefined();
    }
    // A representative read-only column.
    expect((byPath.get('orderId') as { readonly?: boolean }).readonly).toBe(true);
    expect((byPath.get('status') as { readonly?: boolean }).readonly).toBe(true);
    // Nested customer path is exposed for display.
    expect(byPath.has('customerInfo.email')).toBe(true);
    // The shipping-tracking URL column is typed as a url.
    expect((byPath.get('shippingTrackingURL') as { type?: string }).type).toBe('url');
  });
});
