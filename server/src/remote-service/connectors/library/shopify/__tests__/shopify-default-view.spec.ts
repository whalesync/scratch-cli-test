import { Type } from '@sinclair/typebox';
import { TableViewCol, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { buildShopifyDefaultView } from '../shopify-default-view';

describe('buildShopifyDefaultView', () => {
  function buildProductsSchema() {
    return Type.Object({
      title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      id: Type.Optional(Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true })),
      handle: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      status: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      vendor: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      productType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      tags: Type.Optional(Type.Array(Type.String())),
      createdAt: Type.Optional(
        Type.Union([Type.String({ format: 'date-time' }), Type.Null()], { [X_SCRATCH_READONLY]: true }),
      ),
      bodyHtml: Type.Optional(Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true })),
      totalInventory: Type.Optional(Type.Union([Type.Number(), Type.Null()], { [X_SCRATCH_READONLY]: true })),
      hasOnlyDefaultVariant: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
      legacyResourceId: Type.Optional(Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true })),
      seo: Type.Optional(
        Type.Union([
          Type.Object({
            title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ]),
      ),
      priceRange: Type.Optional(
        Type.Union([
          Type.Object({
            minVariantPrice: Type.Optional(Type.Object({ amount: Type.Optional(Type.String()) })),
          }),
          Type.Null(),
        ]),
      ),
      // Count object pattern (like Shopify's articlesCount, productsCount, etc.)
      variantsCount: Type.Optional(
        Type.Union(
          [
            Type.Object({
              count: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
              precision: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            }),
            Type.Null(),
          ],
          { [X_SCRATCH_READONLY]: true },
        ),
      ),
    });
  }

  function buildShippingLineSchema() {
    return Type.Object({
      title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      id: Type.String(),
      // Money object pattern (like Shopify's discountedPrice, originalPrice, etc.)
      discountedPrice: Type.Optional(
        Type.Union([
          Type.Object({
            amount: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            currencyCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
          Type.Null(),
        ]),
      ),
      price: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    });
  }

  const schema = buildProductsSchema();
  const view = buildShopifyDefaultView(schema, 'products');

  it('should return a view named "Default"', () => {
    expect(view.name).toBe('Default');
  });

  it('should place priority fields first in the expected order for products', () => {
    const paths = view.cols.map((c) => (c as TableViewCol).path);
    const titleIdx = paths.indexOf('title');
    const idIdx = paths.indexOf('id');
    const handleIdx = paths.indexOf('handle');
    const statusIdx = paths.indexOf('status');
    const vendorIdx = paths.indexOf('vendor');
    const productTypeIdx = paths.indexOf('productType');
    const descriptionIdx = paths.indexOf('description');
    const tagsIdx = paths.indexOf('tags');

    expect(titleIdx).toBe(0);
    expect(idIdx).toBeLessThan(handleIdx);
    expect(handleIdx).toBeLessThan(statusIdx);
    expect(statusIdx).toBeLessThan(vendorIdx);
    expect(vendorIdx).toBeLessThan(productTypeIdx);
    expect(productTypeIdx).toBeLessThan(descriptionIdx);
    expect(descriptionIdx).toBeLessThan(tagsIdx);
  });

  it('should place non-priority fields after priority fields alphabetically', () => {
    const paths = view.cols.map((c) => (c as TableViewCol).path);
    const tagsIdx = paths.indexOf('tags'); // last priority field
    const bodyHtmlIdx = paths.indexOf('bodyHtml');
    const createdAtIdx = paths.indexOf('createdAt');
    const totalInventoryIdx = paths.indexOf('totalInventory');

    expect(bodyHtmlIdx).toBeGreaterThan(tagsIdx);
    expect(createdAtIdx).toBeGreaterThan(tagsIdx);
    expect(totalInventoryIdx).toBeGreaterThan(tagsIdx);
    // Alphabetical order among non-priority
    expect(bodyHtmlIdx).toBeLessThan(createdAtIdx);
    expect(createdAtIdx).toBeLessThan(totalInventoryIdx);
  });

  it('should propagate readonly from schema', () => {
    const idCol = view.cols.find((c) => c.kind === 'col' && c.path === 'id') as TableViewCol;
    expect(idCol).toBeDefined();
    expect(idCol.readonly).toBe(true);

    const titleCol = view.cols.find((c) => c.kind === 'col' && c.path === 'title') as TableViewCol;
    expect(titleCol.readonly).toBeUndefined();
  });

  it('should map date-time format to date type', () => {
    const createdAt = view.cols.find((c) => c.kind === 'col' && c.path === 'createdAt') as TableViewCol;
    expect(createdAt).toBeDefined();
    expect(createdAt.type).toBe('date');
  });

  it('should map boolean union to checkbox type', () => {
    const col = view.cols.find((c) => c.kind === 'col' && c.path === 'hasOnlyDefaultVariant') as TableViewCol;
    expect(col).toBeDefined();
    expect(col.type).toBe('checkbox');
  });

  it('should map number union to number type', () => {
    const col = view.cols.find((c) => c.kind === 'col' && c.path === 'totalInventory') as TableViewCol;
    expect(col).toBeDefined();
    expect(col.type).toBe('number');
  });

  it('should map array to object type', () => {
    const col = view.cols.find((c) => c.kind === 'col' && c.path === 'tags') as TableViewCol;
    expect(col).toBeDefined();
    expect(col.type).toBe('object');
  });

  it('should map nested object union to object type', () => {
    const col = view.cols.find((c) => c.kind === 'col' && c.path === 'seo') as TableViewCol;
    expect(col).toBeDefined();
    expect(col.type).toBe('object');
  });

  it('should hide fields in the HIDDEN_FIELDS set', () => {
    const legacyCol = view.cols.find((c) => c.kind === 'col' && c.path === 'legacyResourceId') as TableViewCol;
    expect(legacyCol).toBeDefined();
    expect(legacyCol.hidden).toBe(true);

    const seoCol = view.cols.find((c) => c.kind === 'col' && c.path === 'seo') as TableViewCol;
    expect(seoCol.hidden).toBe(true);

    const priceRangeCol = view.cols.find((c) => c.kind === 'col' && c.path === 'priceRange') as TableViewCol;
    expect(priceRangeCol.hidden).toBe(true);
  });

  it('should not hide normal fields', () => {
    const titleCol = view.cols.find((c) => c.kind === 'col' && c.path === 'title') as TableViewCol;
    expect(titleCol.hidden).toBeUndefined();
  });

  it('should format camelCase field names as Title Case', () => {
    const col = view.cols.find((c) => c.kind === 'col' && c.path === 'productType') as TableViewCol;
    expect(col.name).toBe('Product Type');

    const bodyCol = view.cols.find((c) => c.kind === 'col' && c.path === 'bodyHtml') as TableViewCol;
    expect(bodyCol.name).toBe('Body Html');

    const idCol = view.cols.find((c) => c.kind === 'col' && c.path === 'id') as TableViewCol;
    expect(idCol.name).toBe('Id');
  });

  it('should handle an empty schema gracefully', () => {
    const empty = Type.Object({});
    const emptyView = buildShopifyDefaultView(empty, 'products');
    expect(emptyView.cols).toEqual([]);
  });

  it('should use default priority for unknown entity types', () => {
    const simpleSchema = Type.Object({
      title: Type.String(),
      id: Type.String({ [X_SCRATCH_READONLY]: true }),
      zebra: Type.String(),
      apple: Type.String(),
    });
    const unknownView = buildShopifyDefaultView(simpleSchema, 'unknown_entity');
    const paths = unknownView.cols.map((c) => (c as TableViewCol).path);
    // Default priority: title, id, handle, name, status — title and id are present
    expect(paths[0]).toBe('title');
    expect(paths[1]).toBe('id');
    // Remaining sorted alphabetically
    expect(paths[2]).toBe('apple');
    expect(paths[3]).toBe('zebra');
  });

  it('should not produce any banner groups', () => {
    const groups = view.cols.filter((c) => c.kind === 'banner-group');
    expect(groups.length).toBe(0);
  });

  describe('count object subfields', () => {
    it('should add count/precision subfields for {count, precision} objects', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'variantsCount') as TableViewCol;
      expect(col).toBeDefined();
      expect(col.subfields).toHaveLength(2);
      expect(col.subfields![0]).toEqual({ relativePath: 'count', name: 'Count', type: 'number' });
      expect(col.subfields![1]).toEqual({ relativePath: 'precision', name: 'Precision', type: 'string' });
    });

    it('should default to showing count (selectedSubfield = 0)', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'variantsCount') as TableViewCol;
      expect(col.selectedSubfield).toBe(0);
    });

    it('should set type to number for count objects', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'variantsCount') as TableViewCol;
      expect(col.type).toBe('number');
    });

    it('should propagate readonly on count objects', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'variantsCount') as TableViewCol;
      expect(col.readonly).toBe(true);
    });
  });

  describe('money object subfields', () => {
    const shippingView = buildShopifyDefaultView(buildShippingLineSchema(), 'order_shipping_lines');

    it('should add amount/currencyCode subfields for {amount, currencyCode} objects', () => {
      const col = shippingView.cols.find((c) => c.kind === 'col' && c.path === 'discountedPrice') as TableViewCol;
      expect(col).toBeDefined();
      expect(col.subfields).toHaveLength(2);
      expect(col.subfields![0]).toEqual({ relativePath: 'amount', name: 'Amount', type: 'number' });
      expect(col.subfields![1]).toEqual({ relativePath: 'currencyCode', name: 'Currency Code', type: 'string' });
    });

    it('should default to showing amount (selectedSubfield = 0)', () => {
      const col = shippingView.cols.find((c) => c.kind === 'col' && c.path === 'discountedPrice') as TableViewCol;
      expect(col.selectedSubfield).toBe(0);
    });

    it('should set type to number for money objects', () => {
      const col = shippingView.cols.find((c) => c.kind === 'col' && c.path === 'discountedPrice') as TableViewCol;
      expect(col.type).toBe('number');
    });

    it('should not add subfields for plain string price fields', () => {
      const col = shippingView.cols.find((c) => c.kind === 'col' && c.path === 'price') as TableViewCol;
      expect(col.subfields).toBeUndefined();
    });
  });
});
