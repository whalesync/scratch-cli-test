# Webflow Publication States: Published, Draft, and Archived

This document explains, in plain English, the states a Webflow CMS item can be
in, how an item moves between them, and the rules and gotchas that Webflow's API
enforces along the way. Everything here was verified against the live Webflow
Data API v2 (see [How we know this](#how-we-know-this) at the bottom).

It is written so that you can understand the model **without** opening the
connector code or the Webflow docs. If you are about to build anything that
changes an item's publication state, read this first.

---

## The short version

A Webflow CMS item is in **one of three user-facing states**:

- **Published** — live and visible on the published website.
- **Draft** — exists in the CMS but is **not** shown on the live website. A
  work-in-progress.
- **Archived** — pulled from the live website but kept in the CMS. A "retired"
  item.

Webflow does **not** store this as a single "status" field. It stores **two
independent booleans** plus a **timestamp**, and the user-facing state is
_derived_ from them:

| Raw Webflow fields | |
| --- | --- |
| `isDraft` | boolean — item is a draft |
| `isArchived` | boolean — item is archived |
| `lastPublished` | timestamp or `null` — when the item was last pushed live (`null` = never) |

Because the two booleans are independent, **they can both be true at once**, and
`lastPublished` **never goes back to `null`** once set. So you cannot read the
state off any single field — you have to apply a **precedence order**.

### Deriving the state (the one rule that matters)

```
if (isArchived)            -> Archived
else if (isDraft)          -> Draft
else if (lastPublished)    -> Published
else                       -> Draft (never-published / unpublished)
```

Check **archived first, draft second, published last.** This order is not
cosmetic — it is required, because an archived item can still have `isDraft`
true and a non-null `lastPublished`, and a drafted item keeps its old
`lastPublished`. Only the precedence resolves the ambiguity correctly.

| State | `isArchived` | `isDraft` | `lastPublished` |
| --- | --- | --- | --- |
| **Published** | false | false | set |
| **Draft** (was live, now hidden) | false | true | set (stale) |
| **Draft** (never published) | false | false | `null` |
| **Archived** | true | (either) | (either) |

---

## A second, separate dimension: staged vs. live

Independent of the three states above, every change you make to Webflow lands in
one of two places:

- **Staging (the CMS):** the working copy. Changes here are saved but do **not**
  appear on the live website until the item (or the whole site) is published.
- **Live:** the published website that visitors see.

The Webflow API exposes this as **two sets of endpoints** — a "staged" one and a
"live" one — for almost every operation:

| Operation | Staged endpoint | Live endpoint |
| --- | --- | --- |
| Create | `POST /collections/{cid}/items` | `POST /collections/{cid}/items/live` |
| Update one | `PATCH /collections/{cid}/items/{id}` | `PATCH /collections/{cid}/items/{id}/live` |
| Update many | `PATCH /collections/{cid}/items` | `PATCH /collections/{cid}/items/live` |
| Read one | `GET /collections/{cid}/items/{id}` | `GET /collections/{cid}/items/{id}/live` |
| Delete | `DELETE /collections/{cid}/items/{id}` | `DELETE /collections/{cid}/items/{id}/live` |
| Publish staged items | — | `POST /collections/{cid}/items/publish` |

- A **staged create** (`POST .../items`) makes an item that has **never been
  published**: `lastPublished` is `null`, and the live read endpoint returns
  `404` for it. It is invisible to site visitors until you publish it.
- A **live create** (`POST .../items/live`) creates **and immediately publishes**
  in one round-trip: `lastPublished` is set on the spot.
- The **publish** endpoint takes already-staged items and pushes them live.

> **How Scratch uses this today:** the connector always uses the **live**
> endpoints (`createItemLive` / `updateItemsLive`), so "publish in Scratch" means
> "publish live in Webflow" in a single call. See `webflow-connector.ts`
> (`createRecords` / `updateRecords`).

---

## How an item moves between states

Once you understand "two booleans + a timestamp" and "staged vs. live," the
transitions are straightforward — but a few of them have hard rules that will
return errors. Here is the full map.

```
                      POST /items/live
                      (isDraft:false)
        ┌───────────────────────────────────────────┐
        │                                            ▼
   (new item) ──POST /items──▶  UNPUBLISHED  ──POST /items/publish──▶  PUBLISHED
                              (never published)                      ▲   │
                               lastPublished=null                    │   │
                                     │                               │   │
                                     │  live PATCH here = 409 ✗      │   │ PATCH /live
                                     │  (must publish first)         │   │ isDraft:true
                                     ▼                               │   ▼
                                  (blocked)                         DRAFT  (was live)
                                                                     ▲   │
                                                   PATCH /live       │   │ PATCH /live
                                                   isDraft:false ────┘   │ isArchived:true
                                                                         ▼
                                                                     ARCHIVED
                                                          (cannot be published; ✗
                                                           un-archive to publish again)
```

### Transition reference

| From | To | How | Rule / gotcha |
| --- | --- | --- | --- |
| (nothing) | Published | `POST /items/live` | One call creates + publishes. |
| (nothing) | Draft, never published | `POST /items` | Staged only; `lastPublished` stays `null`. |
| (nothing) | Draft, but published | `POST /items/live` with `isDraft:true` | Creates, sets `lastPublished`, **and** marks draft. |
| Unpublished | Published | `POST /items/publish` | Works **unless** the item is archived. |
| Published | Draft | `PATCH /items/{id}/live` `isDraft:true` | Item must already be published (see 409 rule). |
| Draft | Published | `PATCH /items/{id}/live` `isDraft:false` | Re-publishes; `lastPublished` advances. |
| Published / Draft | Archived | `PATCH /items/{id}/live` `isArchived:true` | Item must already be published. |
| Archived | Published | `PATCH /items/{id}/live` `isArchived:false` | Un-archive, then it's live again. |
| any | gone | `DELETE /items/{id}/live` then `DELETE /items/{id}` | Unpublish from live, then remove from the CMS. |

---

## The hard rules (all verified against the live API)

These are the behaviors that will surprise you or break a naive implementation.

### 1. You cannot live-update an item that was never published → `409`

`PATCH /items/{id}/live` (and the **bulk** `PATCH /items/live`) on an item whose
`lastPublished` is `null` fails:

```
409 Conflict
"Live PATCH updates can't be applied to items that have never been published"
```

This is the single most important rule. An item is "never published" if it was
created via the staged `POST /items` endpoint, or if it was authored as a draft
directly in Webflow and never published. To edit such an item live, you must
**publish it first** (or edit it via the **staged** `PATCH /items/{id}` endpoint
instead of the live one).

`updateRecords` handles this (DEV-10642): it publishes the batch live, and on the
`409` retries each item individually — falling back to the **staged** batch
endpoint (`PATCH /items`, no `/live`) for the items that are themselves
never-published, so the edit lands on the draft without publishing it. See
`updateItemsLiveWithNeverPublishedFallback` in `webflow-connector.ts`.

### 2. `lastPublished` only ever moves forward — it never resets

Every live PATCH **re-publishes** the item and pushes `lastPublished` forward,
**even when you are setting `isDraft:true` or `isArchived:true`.** Marking an
item as draft or archived does **not** clear `lastPublished`.

The practical consequence: once an item has been published even once, you can
**not** tell whether it is "currently live" by looking at `lastPublished` — it
will be set forever. You must look at the `isDraft` / `isArchived` flags. This is
exactly why the [derivation rule](#deriving-the-state-the-one-rule-that-matters)
checks the flags before `lastPublished`.

### 3. `isDraft` and `isArchived` can both be true at the same time

Webflow accepts `isArchived:true, isDraft:true` with no error. There is no
mutual exclusion. The derivation precedence (Archived wins) is what resolves
this into a single user-facing state.

### 4. An archived item cannot be published

`POST /items/publish` on an archived item returns `202` but does nothing:

```json
{ "publishedItemIds": [], "errors": ["Staging item ID … is archived and cannot be published."] }
```

Note the **`202` with an `errors` array** — the publish endpoint reports
per-item failure inside the body, not via the HTTP status. Always read
`errors`, don't trust the `202`. To publish a retired item you must un-archive
it first.

### 5. Slugs are auto-managed (despite being "required")

Even though `slug` is marked `isRequired` on the collection schema:

- **Omitting the slug** is fine — Webflow generates one from `name`
  (`"No Slug Here"` → `no-slug-here-…`).
- **A duplicate slug** is fine — Webflow appends a random suffix to make it
  unique (`dup-slug-x` → `dup-slug-x-cd440`).

So there is no need to pre-validate or de-duplicate slugs before sending; the API
will not reject them.

---

## What this means for Scratch (context, not a spec)

This section is informational — it describes how the model intersects with the
connector as it exists today. It does not prescribe a design.

- **The connector publishes live.** `createRecords` uses `createItemLive` and
  `updateRecords` uses `updateItemsLive`, so a Scratch publish equals a Webflow
  live publish. Records the connector creates itself are therefore always
  published (their `lastPublished` is set), which keeps later live updates legal.
- **`isDraft` / `isArchived` already round-trip.** They are pulled verbatim onto
  disk, exposed as editable boolean columns in the schema/view (they are
  explicitly **not** read-only), and written back on publish. See
  `webflow-json-schema.ts` (the `isArchived` / `isDraft` properties) and
  `webflow-default-view.ts`.
- **The never-published 409 is handled (DEV-10642).** An item **pulled from
  Webflow** that was never published (`lastPublished: null`) hits rule #1 if a
  Scratch edit is published through `updateItemsLive` — and because the bulk live
  PATCH is atomic, one such item used to fail the whole batch. `updateRecords`
  now catches that specific `409` and retries each item on its own, falling back
  to the **staged** endpoint for the never-published ones (the edit lands; the
  item stays a draft — we never auto-publish). See
  `updateItemsLiveWithNeverPublishedFallback`.
- **A single derived "Status" is the natural UI.** Surfacing one
  Published / Draft / Archived control (computed via the precedence rule) is
  friendlier than two raw checkboxes, while the on-disk record keeps Webflow's
  verbatim `isDraft` / `isArchived` booleans for fidelity.

---

## How we know this

Every statement above was verified by making direct HTTP calls against the live
Webflow Data API v2 (no SDK) on the throwaway test site
**"Scratch General Test with E-Comm"**, collection **Menu Items**, on
2026-06-05. The exploration created and then deleted every record it touched.

Representative observed responses:

- Staged create → `202`, `lastPublished: null`, live read `404`.
- Live create → `202`, `lastPublished` set immediately, present on live.
- `POST /items/publish` of a staged item → `202`,
  `{"publishedItemIds":["…"],"errors":[]}`.
- Live PATCH `isDraft:true` on a published item → `200`; `isDraft` becomes true,
  `lastPublished` **advances** (does not clear).
- Live PATCH (single and bulk) on a never-published item → `409 Conflict`
  ("Live PATCH updates can't be applied to items that have never been
  published").
- `isArchived:true, isDraft:true` together → accepted, `200`.
- `POST /items/publish` of an archived item → `202`,
  `{"publishedItemIds":[],"errors":["Staging item ID … is archived and cannot be published."]}`.
- Duplicate slug → auto-suffixed (`…-cd440`); missing slug → auto-generated from
  name.

The exploration script used to produce these results is kept (gitignored) at
`.context/webflow-explore.mjs` in the workspace and can be re-run with
`node .context/webflow-explore.mjs run` (state walk-through) or `… probe`
(focused edge cases).
