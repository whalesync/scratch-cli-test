import { Type } from '@sinclair/typebox';
import { TableViewBannerGroup, TableViewCol, X_SCRATCH_READONLY } from '@spinner/shared-types';
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
      descriptionHtml: Type.Optional(Type.Union([Type.String(), Type.Null()])),
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
    const descriptionHtmlIdx = paths.indexOf('descriptionHtml');
    const tagsIdx = paths.indexOf('tags');

    expect(titleIdx).toBe(0);
    expect(idIdx).toBeLessThan(handleIdx);
    expect(handleIdx).toBeLessThan(statusIdx);
    expect(statusIdx).toBeLessThan(vendorIdx);
    expect(vendorIdx).toBeLessThan(productTypeIdx);
    expect(productTypeIdx).toBeLessThan(descriptionIdx);
    expect(descriptionIdx).toBeLessThan(descriptionHtmlIdx);
    expect(descriptionHtmlIdx).toBeLessThan(tagsIdx);
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

  it('should expand seo into a banner group', () => {
    const group = view.cols.find((c) => c.kind === 'banner-group' && c.name === 'SEO') as TableViewBannerGroup;
    expect(group).toBeDefined();
    expect(group.cols).toHaveLength(2);
    expect(group.cols[0]).toMatchObject({ kind: 'col', path: 'seo.title', name: 'Title' });
    expect(group.cols[1]).toMatchObject({ kind: 'col', path: 'seo.description', name: 'Description' });
  });

  it('should hide fields in the HIDDEN_FIELDS set', () => {
    const legacyCol = view.cols.find((c) => c.kind === 'col' && c.path === 'legacyResourceId') as TableViewCol;
    expect(legacyCol).toBeDefined();
    expect(legacyCol.hidden).toBe(true);

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

  it('should produce exactly one banner group (SEO)', () => {
    const groups = view.cols.filter((c) => c.kind === 'banner-group');
    expect(groups.length).toBe(1);
  });

  describe('count object subfields', () => {
    it('should add count/precision subfields for {count, precision} objects', () => {
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'variantsCount') as TableViewCol;
      expect(col).toBeDefined();
      expect(col.subfields).toHaveLength(2);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(col.subfields![0]).toEqual({ relativePath: 'count', name: 'Count', type: 'number' });
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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

  describe('verbatim SEO metafield banner (articles/pages/blogs)', () => {
    function buildArticlesSchema() {
      const seoMetafieldObject = Type.Optional(
        Type.Union([Type.Object({ value: Type.Union([Type.String(), Type.Null()]) }), Type.Null()]),
      );
      return Type.Object({
        title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        id: Type.Optional(Type.Union([Type.String(), Type.Null()], { [X_SCRATCH_READONLY]: true })),
        handle: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        body: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        seoTitle: seoMetafieldObject,
        seoDescription: seoMetafieldObject,
      });
    }

    const articlesView = buildShopifyDefaultView(buildArticlesSchema(), 'articles');

    it('expands seoTitle/seoDescription into a single SEO banner group with .value dot-paths', () => {
      const group = articlesView.cols.find(
        (c) => c.kind === 'banner-group' && c.name === 'SEO',
      ) as TableViewBannerGroup;
      expect(group).toBeDefined();
      expect(group.cols).toHaveLength(2);
      expect(group.cols[0]).toMatchObject({ kind: 'col', path: 'seoTitle.value', name: 'Title' });
      expect(group.cols[1]).toMatchObject({ kind: 'col', path: 'seoDescription.value', name: 'Description' });
    });

    it('produces exactly one banner group and no raw seoTitle/seoDescription columns', () => {
      const groups = articlesView.cols.filter((c) => c.kind === 'banner-group');
      expect(groups.length).toBe(1);

      const rawSeoTitleCol = articlesView.cols.find((c) => c.kind === 'col' && c.path === 'seoTitle');
      const rawSeoDescriptionCol = articlesView.cols.find((c) => c.kind === 'col' && c.path === 'seoDescription');
      expect(rawSeoTitleCol).toBeUndefined();
      expect(rawSeoDescriptionCol).toBeUndefined();
    });

    it('marks the banner columns readonly when the schema fields are readonly', () => {
      const seoMetafieldObject = Type.Optional(
        Type.Union([Type.Object({ value: Type.Union([Type.String(), Type.Null()]) }), Type.Null()], {
          [X_SCRATCH_READONLY]: true,
        }),
      );
      const readonlySchema = Type.Object({
        title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        seoTitle: seoMetafieldObject,
        seoDescription: seoMetafieldObject,
      });
      const view = buildShopifyDefaultView(readonlySchema, 'pages');
      const group = view.cols.find((c) => c.kind === 'banner-group' && c.name === 'SEO') as TableViewBannerGroup;
      expect(group.cols[0]).toMatchObject({ path: 'seoTitle.value', readonly: true });
      expect(group.cols[1]).toMatchObject({ path: 'seoDescription.value', readonly: true });
    });
  });

  describe('foreign-key columns (DEV-11017)', () => {
    it('declares the injected parent FK (product_variants.productId) as a relation to Products', () => {
      const variantsSchema = Type.Object({
        displayName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        id: Type.String(),
        productId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      });
      const variantsView = buildShopifyDefaultView(variantsSchema, 'product_variants');
      const col = variantsView.cols.find((c) => c.kind === 'col' && c.path === 'productId') as TableViewCol;
      expect(col).toBeDefined();
      expect(col.foreignKey).toEqual({ linkedTableId: 'products' });
      expect(col.readonly).toBe(true);
    });

    it('declares product_media.productId as a relation to Products', () => {
      const mediaSchema = Type.Object({
        id: Type.String(),
        productId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      });
      const mediaView = buildShopifyDefaultView(mediaSchema, 'product_media');
      const col = mediaView.cols.find((c) => c.kind === 'col' && c.path === 'productId') as TableViewCol;
      expect(col.foreignKey).toEqual({ linkedTableId: 'products' });
    });

    it('plucks articles.blog to blog.id and links it to Blogs (no raw blog object column)', () => {
      const articlesSchema = Type.Object({
        title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        id: Type.String(),
        blog: Type.Optional(
          Type.Union([
            Type.Object({
              id: Type.Optional(Type.String()),
              handle: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            }),
            Type.Null(),
          ]),
        ),
      });
      const articlesView = buildShopifyDefaultView(articlesSchema, 'articles');
      const blogCol = articlesView.cols.find((c) => c.kind === 'col' && c.path === 'blog.id') as TableViewCol;
      expect(blogCol).toBeDefined();
      expect(blogCol.name).toBe('Blog');
      expect(blogCol.foreignKey).toEqual({ linkedTableId: 'blogs' });
      expect(blogCol.readonly).toBe(true);
      // The raw blog object column is NOT emitted (that was the JSON blob).
      const rawBlogCol = articlesView.cols.find((c) => c.kind === 'col' && c.path === 'blog');
      expect(rawBlogCol).toBeUndefined();
    });

    it('leaves top-level entities without a parent FK column', () => {
      // products has no injected parent FK, so no productId column is invented.
      const col = view.cols.find((c) => c.kind === 'col' && c.path === 'productId');
      expect(col).toBeUndefined();
    });
  });

  describe('nested reference foreign keys (DEV-11049)', () => {
    function buildVariantsSchemaWithNestedProduct() {
      return Type.Object({
        displayName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        id: Type.String(),
        // Verbatim `{ id }` back-reference pulled by the query fields.
        product: Type.Optional(
          Type.Union([Type.Object({ id: Type.Optional(Type.String()) }), Type.Null()], {
            [X_SCRATCH_READONLY]: true,
          }),
        ),
        // Injected flat parent FK — duplicates the same Products relation.
        productId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      });
    }

    it('plucks product_variants.product to product.id and links it to Products', () => {
      const variantsView = buildShopifyDefaultView(buildVariantsSchemaWithNestedProduct(), 'product_variants');
      const productCol = variantsView.cols.find((c) => c.kind === 'col' && c.path === 'product.id') as TableViewCol;
      expect(productCol).toBeDefined();
      expect(productCol.name).toBe('Product');
      expect(productCol.foreignKey).toEqual({ linkedTableId: 'products' });
      expect(productCol.readonly).toBe(true);
      // The raw `product` object column is NOT emitted (that was the JSON blob).
      const rawProductCol = variantsView.cols.find((c) => c.kind === 'col' && c.path === 'product');
      expect(rawProductCol).toBeUndefined();
    });

    it('hides the redundant injected productId column when product.id already links Products', () => {
      const variantsView = buildShopifyDefaultView(buildVariantsSchemaWithNestedProduct(), 'product_variants');
      const productIdCol = variantsView.cols.find((c) => c.kind === 'col' && c.path === 'productId') as TableViewCol;
      expect(productIdCol).toBeDefined();
      expect(productIdCol.hidden).toBe(true);
      expect(productIdCol.foreignKey).toBeUndefined();
    });

    it('links order_line_items product/variant while keeping the orderId parent FK visible', () => {
      const lineItemsSchema = Type.Object({
        name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        id: Type.String(),
        product: Type.Optional(Type.Union([Type.Object({ id: Type.Optional(Type.String()) }), Type.Null()])),
        variant: Type.Optional(Type.Union([Type.Object({ id: Type.Optional(Type.String()) }), Type.Null()])),
        orderId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      });
      const lineItemsView = buildShopifyDefaultView(lineItemsSchema, 'order_line_items');

      const productCol = lineItemsView.cols.find((c) => c.kind === 'col' && c.path === 'product.id') as TableViewCol;
      expect(productCol.foreignKey).toEqual({ linkedTableId: 'products' });

      const variantCol = lineItemsView.cols.find((c) => c.kind === 'col' && c.path === 'variant.id') as TableViewCol;
      expect(variantCol.name).toBe('Variant');
      expect(variantCol.foreignKey).toEqual({ linkedTableId: 'product_variants' });

      // orderId targets Orders — not covered by a nested FK — so it stays a visible FK column.
      const orderIdCol = lineItemsView.cols.find((c) => c.kind === 'col' && c.path === 'orderId') as TableViewCol;
      expect(orderIdCol.foreignKey).toEqual({ linkedTableId: 'orders' });
      expect(orderIdCol.hidden).toBeUndefined();
    });
  });

  describe('Relay connection objects are hidden (DEV-11049)', () => {
    it('hides a `{ edges, nodes, pageInfo }` connection field (blogs.articles)', () => {
      const blogsSchema = Type.Object({
        title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        id: Type.String(),
        articles: Type.Optional(
          Type.Union([
            Type.Object({
              edges: Type.Optional(Type.Array(Type.Unknown())),
              nodes: Type.Optional(Type.Array(Type.Unknown())),
              pageInfo: Type.Optional(Type.Unknown()),
            }),
            Type.Null(),
          ]),
        ),
      });
      const blogsView = buildShopifyDefaultView(blogsSchema, 'blogs');
      const articlesCol = blogsView.cols.find((c) => c.kind === 'col' && c.path === 'articles') as TableViewCol;
      expect(articlesCol).toBeDefined();
      expect(articlesCol.hidden).toBe(true);
    });

    it('does not hide a plain object that merely has a nodes-like property', () => {
      // `feed` is `{ location, path }` — not a connection — so it stays visible.
      const blogsSchema = Type.Object({
        title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        id: Type.String(),
        feed: Type.Optional(
          Type.Union([
            Type.Object({
              location: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              path: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            }),
            Type.Null(),
          ]),
        ),
      });
      const blogsView = buildShopifyDefaultView(blogsSchema, 'blogs');
      const feedCol = blogsView.cols.find((c) => c.kind === 'col' && c.path === 'feed') as TableViewCol;
      expect(feedCol.hidden).toBeUndefined();
    });
  });

  describe('object pluck subfields (DEV-11018 / DEV-11020)', () => {
    it('plucks articles.author to its name', () => {
      const articlesSchema = Type.Object({
        title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        id: Type.String(),
        author: Type.Optional(
          Type.Union([Type.Object({ name: Type.Optional(Type.Union([Type.String(), Type.Null()])) }), Type.Null()]),
        ),
      });
      const articlesView = buildShopifyDefaultView(articlesSchema, 'articles');
      const col = articlesView.cols.find((c) => c.kind === 'col' && c.path === 'author') as TableViewCol;
      expect(col.subfields).toEqual([{ relativePath: 'name', name: 'Name', type: 'string' }]);
      expect(col.selectedSubfield).toBe(0);
    });

    it('plucks products.category to its fullName', () => {
      const productsSchema = Type.Object({
        title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        id: Type.String(),
        category: Type.Optional(
          Type.Union([
            Type.Object({
              fullName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              id: Type.Optional(Type.String()),
              isLeaf: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
            }),
            Type.Null(),
          ]),
        ),
      });
      const productsView = buildShopifyDefaultView(productsSchema, 'products');
      const col = productsView.cols.find((c) => c.kind === 'col' && c.path === 'category') as TableViewCol;
      expect(col.subfields).toEqual([{ relativePath: 'fullName', name: 'Full Name', type: 'string' }]);
      expect(col.selectedSubfield).toBe(0);
    });

    it('plucks products.featuredImage to its url once url/altText are present', () => {
      const productsSchema = Type.Object({
        title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        id: Type.String(),
        featuredImage: Type.Optional(
          Type.Union([
            Type.Object({
              id: Type.Optional(Type.String()),
              url: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              altText: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            }),
            Type.Null(),
          ]),
        ),
      });
      const productsView = buildShopifyDefaultView(productsSchema, 'products');
      const col = productsView.cols.find((c) => c.kind === 'col' && c.path === 'featuredImage') as TableViewCol;
      expect(col.subfields).toEqual([{ relativePath: 'url', name: 'URL', type: 'url' }]);
      expect(col.selectedSubfield).toBe(0);
    });

    it('does not pluck a same-named field that is not an object exposing the path', () => {
      // A hypothetical scalar `category` must be left alone (shape guard).
      const productsSchema = Type.Object({
        title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        id: Type.String(),
        category: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      });
      const productsView = buildShopifyDefaultView(productsSchema, 'products');
      const col = productsView.cols.find((c) => c.kind === 'col' && c.path === 'category') as TableViewCol;
      expect(col.subfields).toBeUndefined();
    });
  });

  describe('money object subfields', () => {
    const shippingView = buildShopifyDefaultView(buildShippingLineSchema(), 'order_shipping_lines');

    it('should add amount/currencyCode subfields for {amount, currencyCode} objects', () => {
      const col = shippingView.cols.find((c) => c.kind === 'col' && c.path === 'discountedPrice') as TableViewCol;
      expect(col).toBeDefined();
      expect(col.subfields).toHaveLength(2);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(col.subfields![0]).toEqual({ relativePath: 'amount', name: 'Amount', type: 'number' });
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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
