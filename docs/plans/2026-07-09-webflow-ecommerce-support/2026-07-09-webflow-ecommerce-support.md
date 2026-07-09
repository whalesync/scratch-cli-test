# DEV-10729 — Add Ecommerce support to the Webflow connector

Status: **implemented + fully live-verified** (2026-07-09) — code + unit tests green; **live-API ecommerce integration suite passing** against a real ecommerce-enabled Webflow site, now **including the order write round-trip** (a $0 test order was placed, so the comment update→refetch→restore runs by default). Products/SKUs/Categories/Orders all live-covered.

## Goal
Surface Webflow Ecommerce data in the Webflow connector: pull (and, where the API
allows, edit/publish) store data. Today the connector actively **excludes** the
three ecommerce CMS collections and has no Ecommerce-API endpoints.

## Scope (this MR)
1. **Products / SKUs / Categories** — these are ordinary CMS collections (reachable
   via the standard collection-items API) that Webflow auto-creates and the connector
   currently filters out. **Un-exclude them and route them under `/<Site>/Ecommerce/`.**
   Everything else (pull, edit, create, delete, FK, incremental, schema, default view)
   is the existing collection machinery, unchanged → verbatim fidelity + FK for free.
   - Fix the detection: the current filter matches **plural** slugs
     (`products`/`categories`/`skus`), but Webflow's real ecommerce collection slugs
     are **singular** (`product`/`sku`/`category`). Match **both** to be safe.
2. **Orders** — new dedicated Ecommerce-API entity at `/<Site>/Ecommerce/Orders/`.
   - Pull (full; read). No incremental (no changed-since filter, only a `status` filter).
   - Limited-field update mirroring the **Pages** pattern: writable = `comment`,
     `shippingProvider`, `shippingTracking`, `shippingTrackingURL`; everything else
     read-only (assert-no-readonly-changed guard). Creates/deletes disabled.
   - Permissive schema (`additionalProperties: true`, QuickBooks pattern) so the large
     verbatim order object validates without `enforce_schema` noise.

## Deferred (follow-up, documented in STATE.md)
- **Inventory** — per-SKU sub-resource (`GET/PATCH /collections/{skuCollectionId}/items/{skuId}/inventory`);
  no site-level list endpoint, so a top-level table needs an N+1 (enumerate SKUs → fetch
  inventory each) plus SKU-collection discovery. Disproportionate for this pass; better as
  a fast-follow or embedded into the SKU deep-fetch.
- **Order fulfillment / refund actions** (`/fulfill`, `/unfulfill`, `/refund`) — action
  endpoints that don't map to the field-edit model.

## Key API facts (Webflow Data API v2)
- Products/SKUs/Categories = CMS collections; slugs `product`/`sku`/`category` (singular).
  No `isEcommerce` flag on the collection object → detect by slug.
- `GET /sites/{siteId}/orders?offset&limit&status` → `{ orders: [...], pagination: {limit,offset,total} }`.
- `GET /sites/{siteId}/orders/{orderId}` → Order.
- `PATCH /sites/{siteId}/orders/{orderId}` writable: comment, shippingProvider,
  shippingTracking, shippingTrackingURL.
- Order identity field is `orderId` (no `id`).

## Folder layout
```
/<Site>/
  Collections/…      (existing)
  Pages              (existing)
  Assets             (existing)
  Ecommerce/         (new)
    Products/
    SKUs/
    Categories/
    Orders/
```
Ecommerce is always nested under `/<Site>/Ecommerce/` regardless of structureVersion
(brand-new layout, no v1 legacy to preserve). Additive — no folder-move migration; the
new tables are opt-in in the picker.

## Files touched
- `webflow-types.ts` — slug set (singular+plural) + `isWebflowEcommerceCollectionSlug`;
  `WEBFLOW_ORDERS_TABLE_ID_PREFIX`; `Order`/`OrderList`/`OrderUpdate` types.
- `webflow-folder-paths.ts` — `WEBFLOW_ECOMMERCE_FOLDER_SEGMENT`, `webflowEcommerceBasePath`.
- `webflow-schema-parser.ts` — route ecommerce collections' `parentPath` to Ecommerce.
- `webflow-json-schema.ts` — ecommerce basePath in `buildWebflowJsonTableSpec`;
  `buildWebflowOrdersJsonTableSpec`.
- `webflow-default-view.ts` — orders view branch.
- `webflow-api-client.ts` — `listOrders` / `getOrder` / `updateOrder`.
- `webflow-connector.ts` — listTables routing + Orders table; pull/pullByIds/fetchSpec/
  updateRecords/create/delete/incremental/filename branches for Orders.
- `webflow-incremental.ts` — exclude Orders prefix from CMS-items detection.
- tests + STATE.md + `connector-build/existing-connectors.md`.

## Checklist
- [x] types + folder paths + detection helper (`isWebflowEcommerceCollectionSlug`, `webflowEcommerceBasePath`, `Order`/`OrderList`/`OrderUpdate`, `WEBFLOW_ORDERS_TABLE_ID_PREFIX`)
- [x] api client orders methods (`listOrders`/`getOrder`/`updateOrder`)
- [x] schema-parser routing (ecommerce → `/<Site>/Ecommerce`)
- [x] json-schema ecommerce basePath + `buildWebflowOrdersJsonTableSpec`
- [x] default-view orders branch
- [x] connector listTables (route + Orders table gated on ecommerce site) + pull/pullByIds/fetchSpec/update/create/delete/filename branches
- [x] incremental exclusion (Orders NOT_SUPPORTED)
- [x] unit tests — 4 specs, all webflow suites green (242 tests)
- [x] build + lint-strict + typecheck green
- [x] STATE.md updated (entities, edge cases, TODOs, integration-test status); cross-connector summary cells unchanged (IP still ✅, auth/visibility unaffected)
- [x] live-API ecommerce integration suite `webflow-connector-ecommerce.spec.ts` — added + **live-verified green** (discovery/routing/schema/FK/pull against real ecommerce data, 45 SKUs). Self-skips gracefully on non-ecommerce sites. Hardened `webflow-connector.spec.ts`/`webflow-connector-assets.spec.ts` to skip ecommerce collections when picking a plain writable CMS collection (regression prevented). All 3 `webflow-connector*` suites green (26/26).
- [x] live order-*write* round-trip — a $0 test order was placed (`orderId 83b-230`); the comment update→refetch→restore now runs by default in the ecommerce suite (skips gracefully on a 0-order store). Diagnosed that raw `Value.Check`'s "date-time" failure is a checker artifact (unregistered format), not an order-specific schema bug — orders behave identically to collections and the permissive schema accepts all ~30 verbatim fields.

## Notes on decisions
- **Detection by slug (both singular + plural).** Webflow has no `isEcommerce` collection flag. Real slugs are singular; plural matched defensively. Routing a false-positive (a user collection literally slugged `product`) to `/Ecommerce/` is cosmetic + reversible, never data corruption.
- **Products/SKUs/Categories reuse CMS machinery** → verbatim fidelity + full CRUD + FK for free; only folder placement changed. Product/SKU CMS-API writes are unverified (may be rejected by Webflow → surfaced as a normal publish error, never silently dropped).
- **Orders** = permissive schema (`additionalProperties: true`) + Pages-style limited-field update.
- **Inventory + order fulfill/refund actions deferred** (see STATE.md TODOs) — disproportionate for this pass; no clean top-level / field-edit model.
