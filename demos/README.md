# Scratch sales-demo tooling

Presenter-run tooling to get a Scratch sales demo into a known, repeatable state.
See the plan: [`docs/plans/2026-06-16-sales-demo-tooling/2026-06-16-sales-demo-tooling.md`](../docs/plans/2026-06-16-sales-demo-tooling/2026-06-16-sales-demo-tooling.md)
and the approved story design referenced there.

**This is not product code.** It is intentionally outside the Yarn workspaces / Turborepo
build graph and is never shipped. It runs locally before a demo.

## How it runs (zero-install)

Scripts are plain TypeScript executed directly by Node 22's built-in type-stripping —
**no `tsx`, no `ts-node`, no `yarn install`, no `node_modules` here.** Network calls use
Node's native `fetch`.

```bash
# from the repo root
node demos/webflow-cms-seo/ready.ts      # upsert to link-free baseline + publish + workbook re-pull
node demos/webflow-cms-seo/seed.ts       # upsert posts to link-free baseline + publish (idempotent)
node demos/webflow-cms-seo/reset.ts      # teardown: delete ALL demo items + publish (not used by ready)

DEMO_SEED_LIMIT=2 node demos/webflow-cms-seo/seed.ts   # smoke a couple of items first
```

## Prerequisites

- **Node ≥ 22** (`engines` enforces it).
- **`server/.env.integration`** with the relevant key. The demo reuses the
  integration-test service accounts (per DEV-10438). Webflow needs `WEBFLOW_API_KEY`.

## Layout

```
demos/
  shared/
    env.ts        # parses server/.env.integration (no dotenv dep)
    webflow.ts    # Webflow Data API v2 client (native fetch) — seeds the service directly
  webflow-cms-seo/
    constants.ts  # demo collection identity (shared by seed + reset)
    fixtures.ts   # authored, link-free blog posts in topical clusters (the baseline flaw)
    seed.ts       # ensure "Blog Posts (Demo)" collection + create posts (idempotent)
    reset.ts      # delete ALL demo items (explicit teardown only; ready does NOT use this)
    ready.ts      # orchestrator: upsert baseline (via seed) + publish + workbook re-pull
    # bootstrap.ts (Scratch workbook + connection + pull) — TODO, plan T1.4
    # run-of-show.md (presenter script) — TODO, plan T1.6
```

## The Webflow CMS/SEO demo (demo #1)

- **Story:** a content/SEO lead with a blog full of posts that have **no internal links**.
  The live wow is Scratch + Claude adding contextually-correct internal links across the
  whole site at once, reviewed and published back to Webflow.
- **Baseline:** ~12 posts (starter corpus) in 3 topical clusters (Sourdough, Coffee, Knife
  Skills), each body deliberately link-free. The clusters make correct links self-evident.
- **Seed / reset target the integration-test Webflow site** ("Scratch General Test with
  E-Comm") and a dedicated `Blog Posts (Demo)` collection. **Reset is strictly scoped to
  that collection** — it never touches Recipes, Menu Items, or other collections.

## Safety notes

- Writes go to the shared **integration-test** Webflow account. The demo collection is
  clearly named and isolated; reset only ever deletes items inside it.
- `seed` / `ready` **publish the site** to the `*.webflow.io` subdomain so items are live, not
  just staged (`reset` republishes after deleting). Set `DEMO_SKIP_PUBLISH=1` to skip publishing
  (e.g. to avoid republishing the shared test site).
- **Live post pages render** at `https://scratch-general-test-site.webflow.io/demo-blog-posts/<slug>`
  (verified). This required a **one-time Designer step**: adding a collection-page template for
  `Blog Posts (Demo)` (done for the integration-test site). The API cannot create page templates, so
  a brand-new demo site would need that one-time step before its posts render publicly. Our `reset`
  only deletes items (never the collection), so the template persists across reseeds.
