# Sales Demo Tooling for Scratch (DEV-10438)

**Date**: 2026-06-16
**Status**: In Progress
**Author**: Curtis Fonger
**Linear**: [DEV-10438](https://linear.app/whalesync/issue/DEV-10438/tooling-for-sales-demos-for-scratch)
**Demo story design**: `~/.gstack/projects/whalesync-spinner/cfonger-find-scratch-demo-scenarios-design-20260616-125132.md` (office-hours, APPROVED 2026-06-16) — locked the Webflow demo's buyer, wow, hero flaw, and reveal (see "Demo #1 story" below).

## Problem

We need repeatable sales demos of Scratch, tailored to who we're selling to:

- **Marketing buyers** — CMS/SEO and e-commerce stories (Webflow, Shopify)
- **Ops buyers** — CRM bulk-update and data-cleanup stories (Attio)

Today there's no one-command way to get a workspace into a known, demo-ready state. Demo data drifts, a previous demo may have left records half-published, and there's no written run-of-show. The fear in a live demo isn't the product — it's the *setup* being in a weird state on the call.

We want three things (from the ticket):

1. **Demo walkthrough scripts** — Markdown run-of-show, one per demo.
2. **Connector bootstrap / seed scripts** — seed select services (Webflow, Shopify, Attio) with the data a demo needs.
3. **Workspace bootstrap script** — create a workbook, connect the right connector(s), link folders, and pull, so the workspace is ready to demo.

## Goals

- A presenter (Curtis, today) can run **one command per demo** to get to a known "ready-to-demo" state in a few minutes.
- A **reset** command restores the demo to baseline reliably, even if the last demo published edits to the live service.
- Each demo seeds **deliberately flawed** data so the AI-edit + review/diff + publish round-trip has something meaningful to fix.
- A written **run-of-show** tells the presenter exactly what to say, what to click, the AI prompt to type, and a fallback if the live AI is slow.

## Non-goals

- A polished UI or self-serve tool for a future sales team. v1 is **presenter-run from a terminal** (just Curtis).
- Automating the AI edit itself (see Key Decision #1 — it can't be, and shouldn't be, scripted).
- New connectors. All three target connectors already exist and are read-write for the entities we need (see "What already exists").
- Reusing the old `experimental/scratch-v3/scratch-scenarios` code (deprecated — see Key Decision #4).

## What already exists (de-risks this project)

All three connectors exist under `server/src/remote-service/connectors/library/` and support a full pull → edit → publish round-trip for the entities we'd demo:

| Connector | Auth | Writable entities we'd demo | Read-only |
| --------- | ---- | --------------------------- | --------- |
| **Webflow** (`webflow/`) | `apiKey` | **Collections** (full CRUD) | Assets; Pages are metadata-update-only |
| **Shopify** (`shopify/`) | `shopDomain` + `apiKey` (`shpat_…`) | **Products, Collections, Pages, Blogs, Articles** (full CRUD) | Customers, Orders, Files, Metaobjects |
| **Attio** (`attio/`) | `apiKey` (Access Token) | **Companies, People, Deals, custom objects, Lists, Tasks** (full CRUD) | Workspace Members |

The `scratchmd` CLI can script almost the entire flow (see Key Decision #1 for the one exception).

## Key design decisions

### #1 — The AI edit is a *live presenter moment*, not a scripted step

The `scratchmd` CLI can script everything in the demo flow **except** the AI bulk edit ("Ask Claude" / suggest-edits) — that is web-UI-only with no CLI/API surface.

This is fine, and arguably better: **the magic moment is the presenter doing the AI edit live in front of the prospect.** So the tooling's job ends at *"flawed data seeded, pulled, workspace ready"*; the AI edit + review-the-diffs + publish is the live flow, documented in the run-of-show markdown.

Scriptable vs. not (confirmed against the CLI):

| Step | Scriptable? | Command |
| ---- | ----------- | ------- |
| Create workbook | ✅ | `scratchmd workspaces create "<name>"` → workbookId |
| Local checkout | ✅ | `scratchmd workspaces init <workbookId>` |
| Create connection | ✅ | `scratchmd connections add --service WEBFLOW --param apiKey=<token> --name "…"` |
| List tables | ✅ | `scratchmd linked available <connectionId>` |
| Link folder | ✅ | `scratchmd linked add --connection-id <id> --table-id "<id>" --name "…"` |
| Pull | ✅ | `scratchmd linked pull <folderId> --mode full` (or `linked pull-all --mode full`) |
| **AI bulk edit** | ❌ **UI only** | — (live presenter step) |
| Accept | ✅ | `scratchmd files accept-all` / `accept-field --folder … --field …` |
| Publish | ✅ | `scratchmd files publish` (may require the demo user's `cliCanPublish` setting) |

**Fallback for stage reliability:** keep a pre-approved patch set per demo so that, if the live AI is slow or refuses on the call, the presenter can fall back to `scratchmd files accept-all && scratchmd files publish` to land a known-good result. Nice-to-have, not core.

### #2 — Reset is the keystone, and it talks to the *service* API directly

For live demos the make-or-break is restoring a known baseline. **Reset operates at the service-API level** (delete demo-owned records + re-seed the flawed baseline), independent of Scratch state — exactly the pattern the old v3 `reset/wordpress.sh` used (curl + service REST API). This is more robust than trying to "un-publish" through Scratch and doesn't depend on the workbook being in any particular state.

Seed and reset are the same per-service module: `reset = teardown + seed`.

### #3 — "Seed the service" and "connect Scratch to it" are two different systems

The ticket's "connector bootstrap" is secretly two jobs that live in different layers — keep them separate:

- **Seed** (per service): write flawed demo data *into* Webflow/Shopify/Attio via **their own** APIs. No Scratch involved.
- **Bootstrap** (per demo): point **Scratch** at the seeded service — create workbook, add connection, link folders, pull — via the `scratchmd` CLI.

### #4 — New tooling lives in a first-class `/demos/` dir; v3 is reference-only

`experimental/scratch-v3/scratch-scenarios/` is deprecated (the `experimental/` CLAUDE.md says to ignore it for the product, and it was being cleaned out). Its **structure** is a good reference (phase orchestration, per-service reset, REST-level asserts) but its code targets the old v3 engine and Airtable/WordPress/Supabase. We **rebuild on the current `scratchmd` CLI**, in a new top-level `/demos/` directory.

### #5 — Build ONE demo end-to-end first, then clone

Don't build three in parallel. Nail **Webflow CMS+SEO** end-to-end (seed → bootstrap → run-of-show → reset), find every sharp edge on one demo, then clone the harness for Attio and Shopify. Sequencing rationale below.

## Scope & sequencing

Three demos, two tracks (matches the ticket):

| # | Track | Demo | Connector | Why this order |
| - | ----- | ---- | --------- | -------------- |
| 1 | Marketing | CMS / SEO | **Webflow** | Strongest, most-proven Scratch story; most connector investment (DEV-9698); `WEBFLOW_API_KEY` already in `.env.integration`; Collections full CRUD. |
| 2 | Ops | CRM bulk-update / cleanup | **Attio** | `ATTIO_API_KEY` already present; read-write. **Needs a small CLI task** (Attio not in `connections add` — see T-CLI). |
| 3 | Marketing | E-commerce | **Shopify** | Read-write and already in `connections add`, **but** no key in `.env.integration` — needs a dev store + Admin token provisioned first (most setup overhead). |

**Shipping just demo #1 is already valuable.** #2 and #3 are clones of a proven harness.

## Credentials & demo-account inventory

Service-side seed/reset keys live in `server/.env.integration`. Current state:

- ✅ `WEBFLOW_API_KEY` — present
- ✅ `ATTIO_API_KEY` — present
- ❌ **Shopify** — **no key.** Need to provision a Shopify **dev store** + Admin API access token (`shpat_…`) and add `SHOPIFY_SHOP_DOMAIN` + `SHOPIFY_API_KEY`.

v1 reuses the **integration-test service accounts** (these keys) as the demo service accounts. If demo data and integration tests start clobbering each other, split out dedicated "demo" service accounts later (out of scope for v1).

## Demo data design (the actual hard part)

The flaws are the product. Each demo seeds realistic-but-broken data so the AI + review flow has an obvious win. These map to existing `scratch-www/how-to/` guides, which validates them as resonant stories.

- **Webflow CMS+SEO** — see "Demo #1 story" below for the locked design. (Hero flaw is **missing internal links**, not meta descriptions.)
- **Attio CRM cleanup** — Companies + People. ~60 companies. Flaws: duplicates (`Acme Inc` / `Acme, Inc.` / `ACME`), inconsistent industry values (`SaaS`/`Software`/`saas`), blank country & employee-count, inconsistent name casing. Live demo: "normalize industry values," "fill country from domain," "flag duplicates" → review → publish.
- **Shopify e-commerce** — Products. ~50 products. Flaws: thin one-line descriptions, missing SEO title/description, missing image alt text, inconsistent vendor casing. Live demo: "rewrite product descriptions," "generate SEO + alt text" → review → publish.

## Demo #1 story — Webflow CMS/SEO (locked via office-hours, APPROVED 2026-06-16)

The first demo is fully designed. See the design doc linked in the header for the full rationale; the build-relevant decisions:

- **Buyer:** a content/SEO lead at a content-heavy site, drowning in manual Webflow edits and stale SEO hygiene. The demo must show *their* grind in the first minute.
- **Wow:** the **bulk AI edit** — but it only stays a wow (vs. "I already have ChatGPT") if the demo makes two things unmissable: it runs on *real, messy content* (40 actual posts), and the result publishes *back into the live Webflow site*.
- **Hero flaw: missing internal links between related posts.** Chosen deliberately over meta descriptions — it's the non-commoditized capability (requires reading the whole corpus, understanding topical relationships, writing good anchor text) and the chore the buyer personally hates. Meta descriptions / alt text are deferred to optional later acts (Approach B), not v1.
- **Reveal: quality-then-scale.** Show 1–2 posts' diffs in detail (correct target post + natural anchor text) to earn trust, then reveal the aggregate ("N links added across 40 posts") for magnitude. Don't scroll through every diff.
- **Vehicle:** a Webflow **Blog Posts Collection** (internal links live in the rich-text body field). NOT Webflow Pages (metadata-only/blocked).
- **Baseline = link-free authored fixtures.** ~40 posts authored as deliberate **topical clusters**, each body containing **no internal links** — that absence *is* the flaw. The seed writes these via the Webflow API (deterministic, no AI). Reset re-writes the bodies back to the link-free fixtures — fully scriptable because it never reproduces the AI's output.
- **Live-AI fallback:** the run-of-show carries a **pre-approved patch set** (known-good internal-link edits from a prior good run). If live AI is slow/weak on the call, the presenter applies the patch and publishes — audience still sees review + publish.

### Hard pre-build gates (verify before committing to the build)

- [x] **G1 — Rich-text round-trip:** ✅ VERIFIED 2026-06-16 at the Webflow API substrate level (integration-test account, Recipes collection). Rich-text fields return HTML strings; writing `<p>…<a href="/recipe/…">…</a>…</p>` into a field round-tripped **byte-for-byte** (Webflow's sanitizer preserved the anchor). Throwaway draft item created + deleted (HTTP 204), existing data untouched. Because the connector stores raw API responses verbatim, this carries through pull→edit→publish; full through-Scratch confirmation folds into T1.2/T1.8.
  - **Finding:** the integration-test site has **no blog** (only Recipes / Menu Items / Mackerels). The seed must **create a Blog Posts collection** (`POST /v2/sites/{id}/collections`) or target a dedicated demo site. Added seed scope, not a blocker.
- [ ] **G2 — Desktop diff legibility:** confirm Scratch **Desktop** renders rich-text body diffs (inserted `<a>` anchors) clearly enough for the quality-then-scale reveal. (Requires the running Desktop app — not checkable headlessly.)

## Bootstrap & reset mechanics (RUN-TESTED against local server, 2026-06-17)

**Decisions:** one **persistent** demo workbook (reused + re-pulled, not recreated per call). Scratch **Desktop auto-shows** a CLI-triggered pull (no "refresh" beat needed). The connector (Webflow) is reset via the **raw service API** — `scratchmd` never publishes; the only *Scratch* publish is the presenter, live in Desktop. `scratchmd auth login` is long-lived (one-time).

**Webflow site publish (so items are live, not staged):** `seed`/`ready` issue a Webflow **site publish** via the raw API (`POST /sites/{id}/publish`, `publishToWebflowSubdomain:true`), and `reset` republishes after deleting; `DEMO_SKIP_PUBLISH=1` opts out. **Live rendering (resolved for the test site):** posts render at `…/demo-blog-posts/<slug>` (verified HTTP 200, body + links shown). This needed a **one-time Designer step** — a collection-page template for `Blog Posts (Demo)` — because the API can't create page templates. Done for the integration-test site; a new demo site would need it once. `reset` only deletes items (keeps the collection), so the template persists across reseeds. (Per-item publish `/collections/{id}/items/publish` 404s for this collection, so we publish the whole shared test site.)

**Key CLI gotchas (learned the hard way during the run-test):**
- **`--workspace <id>` is a GROUP-level flag**, placed between the group and the action: `connections --workspace <id> list`, `linked --workspace <id> add …`. It is NOT a per-action flag (`connections list --workspace …` errors) and NOT global-before-group. `auth` and `workspaces` are global. (`files` has no `--workspace` flag — but we don't use `files`; see reset below.)
- **Webflow `linked available` returns a COMPOSITE table id** `"<siteId>,<collectionId>"`. It must be passed as **two repeatable `--table-id` flags** (`--table-id <siteId> --table-id <collectionId>`) so the server gets `tableId` as a 2-element array. Passing the joined string as one value 500s with `Cannot read properties of undefined (reading 'startsWith')` (the connector destructures `collectionId` from element 2).
- Avoid a `/` in the workbook name — `workspaces init` turns it into a nested dir. Demo workbook is **"Webflow CMS-SEO Demo"**.

**`bootstrap.ts` — idempotent find-or-create** (every entity has `list --json` + `create`), verified end-to-end (40 records pulled):

| Step | Find (reuse) | Create |
| --- | --- | --- |
| Auth | `scratchmd auth status` | `scratchmd auth login` |
| Workbook | `workspaces list --json` (match by name) | `workspaces create "<name>" --json` → `.id` |
| Connection | `connections --workspace <wb> list --json` | `connections --workspace <wb> add --service WEBFLOW --param apiKey=<key> --name … --json` → `.id` |
| Linked folder | `linked --workspace <wb> list --json` | `linked --workspace <wb> available <conn> --json` (find `Blog Posts (Demo)`, split its composite id) → `linked --workspace <wb> add --connection-id … --table-id <siteId> --table-id <collectionId> --name … --json` → `.id` |
| Checkout | — | `workspaces init <wb> --output <dir> --force` (download target for pull) |
| Pull | — | `linked --workspace <wb> pull <folderId> --mode full` (auto-polls + downloads; no `--no-wait`) |

Server URL via `--scratch-url` / `SCRATCH_URL` / `scratchmd.config.yaml`. For local testing we use a fresh dev build (`scratch-git-2/target/debug/scratchmd`, defaults to `localhost:3010`) via `SCRATCHMD_BIN`; for prod the Homebrew binary defaults to prod.

**Reset-to-baseline sequence (the full `ready`) — RUN-TESTED, reconciles to 40 records:**
1. Raw Webflow API: `reset.ts` + `seed.ts` (service → link-free baseline; deletes+recreates items, new IDs).
2. `linked --workspace <wb> pull <folderId> --mode full` — re-pull. A **full pull reconciles deletions** (verified: 40 in, not 80), so the churned item IDs are handled cleanly.

**No `files discard-all` needed.** Earlier analysis assumed edits live in the CLI checkout, but the demo edits happen in **Scratch Desktop** (its own checkout); the CLI checkout is never edited, so a pull never refuses. Published Desktop edits are reverted by the service reset + re-pull (which Desktop syncs). Unpublished Desktop edits would be discarded in Desktop — out of scope for the CLI reset. (`cliCanPublish` is irrelevant — we never publish via CLI.)

## Repo layout

```
/demos/
  README.md                       # how to run any demo; prerequisites; env setup
  shared/                         # TS helpers shared across demos
    scratchmd.ts                  #   thin wrapper around the scratchmd binary (child_process)
    env.ts                        #   loads server/.env.integration keys
    service-clients.ts            #   axios clients for Webflow / Shopify / Attio admin APIs
  webflow-cms-seo/
    seed.ts                       # write flawed blog data into Webflow
    reset.ts                      # teardown demo-owned items + reseed baseline
    bootstrap.ts                  # scratchmd: workbook + connection + link + pull
    ready.ts                      # orchestrator: reset → seed → bootstrap  ("one command")
    run-of-show.md                # presenter script (say/click/AI-prompt/fallback)
    fixtures/                     # the flawed source content
  attio-crm-cleanup/   ...        # same shape
  shopify-ecommerce-seo/ ...      # same shape
```

**Tooling choice (DECIDED + built):** plain TypeScript run **directly by Node 22's built-in type-stripping** (`node file.ts`) — **zero-install**: no `ts-node`/`tsx`, no `axios` (native `fetch`), no `node_modules` in `/demos`. The `/demos` dir is naturally **out of the product build graph** (the root `workspaces` list is explicit and doesn't glob `demos/`). The Scratch side (bootstrap) shells out to the `scratchmd` binary.

## Target environment (DECIDED)

- **Where the demo workbook lives:** prod **`app.scratch.md`**, so it looks like the real product on a call.
- **Demo service accounts:** reuse the **integration-test service accounts** (keys already in `server/.env.integration`).
- **Live presenter flow:** **Scratch Desktop** (where the main product experience now lives) — the run-of-show targets Desktop. The bootstrap (CLI) and seed/reset (service API) are unaffected by this choice.

---

## Phase 0 — Shared harness + prerequisites

- [x] **T0.1** `/demos/` created with `README.md`, `package.json`, `tsconfig.json`, and `shared/` (`env.ts` parses `server/.env.integration`; `webflow.ts` is a native-fetch Webflow v2 client; `scratchmd.ts` wraps the CLI). ✅ 2026-06-16.
- [x] **T0.2** Target environment decided (prod) and documented in `demos/README.md`. ✅ 2026-06-16.
- [ ] **T0.3** Confirm `scratchmd auth login` flow and `cliCanPublish` setting for the demo user (needed only for the publish fallback). — pending, ties to T1.4.

## Phase 1 — Webflow CMS+SEO demo (end-to-end; the reference implementation)

- [ ] **T1.0** Pass the hard pre-build gates **G1** (rich-text round-trip) and **G2** (Desktop diff legibility) from "Demo #1 story". If either fails, stop and rethink the demo before building.
- [x] **T1.1** `fixtures.ts` — **40 link-free posts in 9 topical clusters** (Sourdough, Coffee, Knife Skills, Tea, Grilling, Pasta, Fermentation, Cocktails, Cheese), bodies that reference sibling topics so links are self-evident. Seeded live to 40 + verified (40 items, all link-free). ✅ 2026-06-16.
- [x] **T1.2** `seed.ts` — ensures `Blog Posts (Demo)` collection + fields, creates posts from fixtures. **Idempotent** (re-run skips existing slugs). Verified live against the integration-test site (12 posts, all link-free). ✅ 2026-06-16.
- [x] **T1.3** `reset.ts` — deletes all items in the demo collection; **strictly scoped to `demo-blog-posts`** (verified: Recipes/Menu/Mackerels untouched). Found+fixed an import side-effect (constants extracted to `constants.ts`, run-as-main guards added). Verified reset→re-seed loop. ✅ 2026-06-16.
- [x] **T1.4** `bootstrap.ts` — **RUN-TESTED against the local server** ✅ 2026-06-17. Idempotent find-or-create of workbook + Webflow connection + linked folder via `shared/scratchmd.ts`, then full pull → **40 records pulled**. Surfaced + fixed three CLI gotchas (group-level `--workspace`, composite `--table-id` split, workbook-name slash) — see "Bootstrap & reset mechanics". Built a fresh dev `scratchmd` (defaults to localhost) for testing.
- [x] **T1.5** `ready.ts` — full reset-to-baseline, **RUN-TESTED** ✅ 2026-06-17: raw-API reset→seed then `linked pull --mode full`; the workbook reconciled to **40 records (not 80)** despite item-ID churn. `files discard-all` dropped (not needed — CLI checkout is never edited). `DEMO_SKIP_WORKBOOK_RESET=1` does service-only.
- [x] **T1.6** `run-of-show.md` — Scratch **Desktop** presenter script ✅ 2026-06-16: pre-call reset checklist, the verbatim AI prompt, the **quality-then-scale** reveal (Sourdough hydration post as the detail beat → aggregate count), accept+publish, "prove it landed" via the Webflow CMS, a fallback ladder, and a cluster-map appendix. Also serves as the manual test script for the first live run.
- [ ] **T1.7** Pre-approved patch set for the live-AI fallback (now part of the design, not optional).
- [ ] **T1.8** Dry-run the whole demo end-to-end; fix sharp edges; lock the harness shape.

## Phase 2 — Attio CRM cleanup demo

- [ ] **T-CLI** Add `ATTIO` to the `scratchmd connections add` service map in `scratch-git-2/src/cli/commands/connections.rs` (the `match service` block, ~lines 17–85, and the doc comment at ~line 99): `"ATTIO" => apiKey` ("Access Token"). Without this the CLI rejects `--service ATTIO` before it reaches the server (the Attio *server* connector already exists).
- [ ] **T2.1** `fixtures/` — ~60 companies with the duplicate/inconsistent/blank flaws.
- [ ] **T2.2** `seed.ts` / **T2.3** `reset.ts` — via the Attio API.
- [ ] **T2.4** `bootstrap.ts` — clone of T1.4 with `--service ATTIO`, link Companies (+ People).
- [ ] **T2.5** `ready.ts` + **T2.6** `run-of-show.md`.

## Phase 3 — Shopify e-commerce demo

- [ ] **T3.0** Provision a Shopify **dev store** + Admin API token; add `SHOPIFY_SHOP_DOMAIN` + `SHOPIFY_API_KEY` to `.env.integration`.
- [ ] **T3.1** `fixtures/` — ~50 products with thin-description / missing-SEO / missing-alt flaws.
- [ ] **T3.2** `seed.ts` / **T3.3** `reset.ts` — via the Shopify Admin API.
- [ ] **T3.4** `bootstrap.ts` — `--service SHOPIFY --param shopDomain=… --param apiKey=…`, link Products.
- [ ] **T3.5** `ready.ts` + **T3.6** `run-of-show.md`.

---

## Tests / verification

This is presenter tooling, not shipped code, so "tests" = reliable dry-runs rather than a CI suite:

- **Idempotency**: run `ready.ts` twice back-to-back → identical baseline (reset must converge).
- **Post-publish reset**: do a full demo (incl. publish to the live service) → run `reset.ts` → service is back to flawed baseline.
- **Cold start**: from no workbook, `ready.ts` produces an open-able workbook with pulled flawed data.
- **CLI change (T-CLI)**: `scratchmd connections add --service ATTIO --param apiKey=…` succeeds and a pull works.
- **Build hygiene**: `/demos/` excluded from `yarn build`/`yarn lint`; root build/lint still green.

## Failure modes

| Failure | Handling |
| ------- | -------- |
| Live AI slow/refuses on the call | Run-of-show fallback: `files accept-all && files publish` of the pre-approved patch set (T1.7). |
| Previous demo left records published to the live service | `reset.ts` is service-level teardown+reseed; always returns to baseline. |
| Service API rate limits during seed | Rate-limit seed writes (the v3 scripts used ~4 req/s for Airtable); seed is one-time/occasional, so this is tolerable. |
| Shopify key missing | Phase 3 is gated on T3.0; Phases 1–2 don't depend on it. |
| `connections add` rejects Attio | Fixed by T-CLI before Phase 2 bootstrap. |
| Publish blocked by `cliCanPublish` | Only affects the optional CLI publish fallback; enable on the demo user (T0.3). The *live* publish in the UI is unaffected. |

## NOT in scope (deferred)

- Self-serve tooling / UI for a sales team — v1 is presenter-run.
- Scripting the AI edit (UI-only by design).
- Dedicated demo service accounts separate from integration-test accounts.
- A 4th connector / additional demo verticals.
- Reusing `experimental/scratch-v3` code.

## Resolved decisions (was: open questions)

1. **Target environment** — prod `app.scratch.md`. ✅ DECIDED 2026-06-16.
2. **Demo service accounts** — reuse the integration-test accounts (`server/.env.integration`). ✅ DECIDED 2026-06-16.
3. **Live presenter flow** — Scratch Desktop. ✅ DECIDED 2026-06-16.

## Open questions (demo #1 specifics)

- How many topical clusters and what themes for the seed? Tune cluster density so the aggregate link count is impressive but believable.
- Confirm the two hard pre-build gates pass (rich-text round-trip; Desktop diff legibility — see "Demo #1 story").
