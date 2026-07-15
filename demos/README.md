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

node demos/attio-crm-cleanup/ready.ts    # rebuild flawed CRM baseline (teardown+recreate) + workbook re-pull
node demos/attio-crm-cleanup/seed.ts     # teardown + recreate the flawed baseline (idempotent)
node demos/attio-crm-cleanup/reset.ts    # teardown: delete ALL demo records (not used by ready)
```

## Prerequisites

- **Node ≥ 22** (`engines` enforces it).
- **`server/.env.integration`** with the relevant key. The demo reuses the
  integration-test service accounts (per DEV-10438). Webflow needs `WEBFLOW_API_KEY`;
  Attio needs `ATTIO_API_KEY`.
- The Attio demo's `bootstrap`/`ready` also need **`scratchmd` with ATTIO support** (DEV-10438
  T-CLI) on PATH and `scratchmd auth login` done once.

## Layout

```
demos/
  shared/
    env.ts        # parses server/.env.integration (no dotenv dep)
    webflow.ts    # Webflow Data API v2 client (native fetch) — seeds the service directly
    attio.ts      # Attio v2 API client (native fetch) — seeds the service directly
    scratchmd.ts  # thin wrapper around the scratchmd CLI (bootstrap: workbook/connection/pull)
  webflow-cms-seo/
    constants.ts  # demo collection identity (shared by seed + reset)
    fixtures.ts   # authored, link-free blog posts in topical clusters (the baseline flaw)
    seed.ts       # ensure "Blog Posts (Demo)" collection + create posts (idempotent)
    reset.ts      # delete ALL demo items (explicit teardown only; ready does NOT use this)
    ready.ts      # orchestrator: upsert baseline (via seed) + publish + workbook re-pull
    bootstrap.ts  # scratchmd: workbook + connection + linked folder + pull
    run-of-show.md # presenter script
  attio-crm-cleanup/
    constants.ts  # demo identity: object slugs + workbook/connection/folder names
    fixtures.ts   # authored flawed CRM: 10 duplicate clusters + standalones (blank industry/location)
    seed.ts       # teardown (by fixture name) + recreate companies/people/deals with FK wiring
    reset.ts      # teardown ALL demo records (explicit teardown only; ready uses seed's teardown)
    bootstrap.ts  # scratchmd: workbook + Attio connection + Companies/People/Deals folders + pull
    ready.ts      # orchestrator: rebuild baseline (via seed) + workbook re-pull
    run-of-show.md # presenter script
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

## The Attio CRM cleanup demo (demo #2)

- **Story:** a RevOps lead whose CRM is full of **blank fields** and **duplicate companies** —
  and who dreads merging dupes because each one drags along contacts and deals. The live wow is
  Scratch + Claude (1) enriching the blanks (industry/location) and (2) **merging the duplicate
  companies including every attached contact and deal** — reviewed, then published back to Attio.
- **Baseline:** **10 duplicate clusters** (`Kyoto Robotics` / `KYOTO ROBOTICS` / `Kyoto Robotics
  Inc.`) + 15 standalone companies, 17 people, 10 deals. The survivor of each cluster holds the
  domain; the drifted-name losers hold the strays (headcount/funding/founded date) and the
  attached People + Deals — so the merge has FKs to rescue. Industry (`categories`) and location
  are seeded **blank** for the enrich beat.
- **Seed / reset target the integration-test Attio workspace** and are **strictly scoped by
  fixture name** — teardown only deletes records whose name is in the fixtures, never a blanket
  "delete all companies", so it can't touch real data or the Attio integration-test suite's records.
- **Reset = full teardown + recreate** (re-wiring FKs by fixture key → fresh record id each run),
  because the demo structurally mutates the graph (deletes losers, repoints FKs). Attio has no
  slug-uniqueness trap, so delete+recreate is clean.
- See [`attio-crm-cleanup/run-of-show.md`](attio-crm-cleanup/run-of-show.md) for the presenter
  script, the verbatim enrich + merge prompts, and known caveats (Attio's sparse domain→country
  auto-fill → lead enrich with **industry**; shared-workspace noise → consider a dedicated demo token).

## Safety notes

- Writes go to the shared **integration-test** Webflow account. The demo collection is
  clearly named and isolated; reset only ever deletes items inside it.
- The Attio demo writes to the shared **integration-test** Attio workspace; seed/reset are scoped
  by fixture name (never a blanket delete). No publish happens from the tooling — the only Scratch
  publish is the presenter, live in Desktop.
- `seed` / `ready` **publish the site** to the `*.webflow.io` subdomain so items are live, not
  just staged (`reset` republishes after deleting). Set `DEMO_SKIP_PUBLISH=1` to skip publishing
  (e.g. to avoid republishing the shared test site).
- **Live post pages render** at `https://scratch-general-test-site.webflow.io/demo-blog-posts/<slug>`
  (verified). This required a **one-time Designer step**: adding a collection-page template for
  `Blog Posts (Demo)` (done for the integration-test site). The API cannot create page templates, so
  a brand-new demo site would need that one-time step before its posts render publicly. Our `reset`
  only deletes items (never the collection), so the template persists across reseeds.
