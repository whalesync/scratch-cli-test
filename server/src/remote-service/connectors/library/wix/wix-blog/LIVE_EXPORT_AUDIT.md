# Live Export audit — WIX_BLOG (source)

Run by `/test-live-export WIX_BLOG notion,supabase,airtable` against the **local** spinner server
(`http://localhost:3010`, mumbai's dev server). Re-prove with `/review-live-export WIX_BLOG notion,supabase,airtable`.

- Umbrella Linear issue: **[DEV-10932](https://linear.app/whalesync/issue/DEV-10932) — Live Export: Launch Wix Blog** (all findings filed as children)
- Credentials: `local/audit-creds/wix_blog.env` documents the OAuth-only situation — there is no API key.
  Burner Wix site: `testing@whalesync.com` (site owner / blog member `39807ab3-…`). The app `instanceId`
  is a token-minting input, so it is deliberately not recorded in either doc — read it from the
  connection's decrypted `oauthWorkspaceId`.
- **OAuth-only? YES.** Wix Blog's `supportedAuthMethods` is `['oauth']` and its OAuth strategy is
  client-credentials, so the harness cannot mint a connection. The one human-connected connection
  lives in local workbook `wkb_kbxXKqnzF7` / `coa_OFBt3xqMf0` ("Sample oauth creds"). Because
  connections are workbook-scoped and the harness needs one workbook per destination, that row is
  **cloned per destination** by
  [`tools/live-export-audit/seeds/wix_blog/provision-workbook.sh`](/tools/live-export-audit/seeds/wix_blog/provision-workbook.sh)
  — its `encryptedCredentials` blob is self-contained (Wix `instanceId` + app access token), so a
  row copy is sufficient and each clone reports `health: ok`.
- Seed scripts: [`tools/live-export-audit/seeds/wix_blog/`](/tools/live-export-audit/seeds/wix_blog/)
  (`wix-api.mjs` mints its own Wix app token, `seed.mjs` seeds the torture set, `crud-pass.mjs` runs Phase 4).
- Raw harness reports are archived (gitignored) in `.context/wix-blog-live-export-audit/` as well as the
  `/tmp/audit-wix_blog-*.json` paths cited below, since `/tmp` doesn't survive a reboot.
- **Torture table: `Blog Posts` (`wix-blog`) — the only table this connector exposes.** Wix Blog is a
  single-entity connector, so type coverage had to come from the draft-post field surface rather than
  from several tables. 213 draft posts: 12 hand-built torture records (all-empty, unicode/RTL/ZWSP/
  emoji/quotes/entities/newlines, >2000 and >4200 char bodies, title at the 200-char cap and excerpt at
  the 500-char cap, every Ricos node kind, arrays at 0/1/5 elements with commas and quotes inside
  elements, 3 categories + 3 tags + 3 related posts, an out-of-export `pricingPlanIds` GUID, SEO tags,
  a Wix media image) + 200 `fable_qa bulk NNNN` records to force the connector's 100-per-page offset
  pagination through 3 pages.
- **Value classes Wix Blog simply has no writable field for** (so they are out of scope here, not gaps):
  numbers (`minutesToRead`/`wordCount` are read-only), dates (`firstPublishedDate` is read-only,
  `scheduledPublishDate` is not in our schema), and true single/multi-select enums.

> **Read [Round 3 — pre-launch validation](#round-3--pre-launch-validation-2026-07-30) first.** The
> gates table below and the Round 1 findings that follow it are kept for history; Round 3 re-ran the
> whole audit against the Round 2 connector and supersedes them.

## Gates (Round 1, superseded — see [Round 3](#round-3--pre-launch-validation-2026-07-30))

| # | Gate | Status | Evidence |
|---|---|---|---|
| 1 | Preflight (server, token, creds) | ✅ | `preflight OK` in all three run logs; cloned connections `coa_qaWixNot3`/`coa_qaWixSup1`/`coa_qaWixAir1` each returned `{"health":"ok"}` |
| 2 | Recon: connector + View read, tables chosen | ✅ | `wix-blog-connector.ts`, `wix-blog-json-schema.ts`, `wix-blog-schema-parser.ts`, `rich-content/*`. **There is no `wix-blog-default-view.ts` and `WixBlogConnector` does not override `buildDefaultView`** — root cause of most findings below. Only one table exists, so it was selected. |
| 3 | Torture data seeded + read back via service API | ✅ | `seed.mjs` → 213 draft posts; every record re-read through `GET /blog/v3/draft-posts/{id}` |
| 4 | Plan audit: every downgraded field judged | ✅ | `/tmp/audit-wix_blog-{notion,supabase,airtable}.json` — 15 non-`mapped` notes, identical on all three destinations. See [Findings](#findings) and [Accepted downgrades](#accepted-downgrades). Round 2 brought this to **0**. |
| 5 | FKs identified as foreignKey; links resolve on destination | ❌ → ✅ | Round 1: **all 5 FKs unresolvable → dropped on all three destinations** (DEV-11115, DEV-11116). Round 2: `droppedForeignKeys: 0`, all 4 bound to sibling tables, real Airtable record links — see [Round 2](#round-2--fixes-implemented-and-re-verified) |
| 6 | First run: publish failures = 0 | ✅ | Notion `rrn_UD8W1EA094`, Supabase `rrn_QTgXD9pD1j`, Airtable `rrn_sN794wzm7N` — 213 creates executed, `failedCount: 0`, `failedOperations: []` on each |
| 7 | Destination-side spot check (≥3 records/table, dest service API) | ✅ | Notion `GET /v1/databases/7729dd66…` + query (213 pages), Supabase `psql` on `public."Blog Posts"` (213 rows), Airtable `GET /v0/meta/bases/appGoopxI4Px4dyuv/tables` + records (213). Field-by-field on the all-empty, unicode, long-text, rich-text and flags records. |
| 8 | CRUD pass: edit / create / delete mirrored | ⚠ | All 4 change classes mirrored on all three destinations, but **Notion created the new record twice** (existing DEV-11016, reproduced from a second source). See [CRUD pass](#crud-pass-phase-4) |
| 9 | Pagination: 200+ record table fully synced | ✅ | 213 seeded → 213 pulled → 213 published → 213 read back on **each** destination. Caveat filed as DEV-11123 (unstable page ordering). |
| 10 | Second run is a no-op | ❌ | Notion **and** Airtable republished all 213 records unchanged; Supabase was a clean no-op. 2+ destinations ⇒ upstream, not a dest-pack bug ⇒ evidence added to the generic **DEV-10556**, not filed per-source. |
| 11 | Destination drift: out-of-band delete restored | ✅ | see [Destination drift](#destination-drift-gate-11) |
| 12 | Findings filed under DEV-10932 with `live-export-qa` | ✅ | DEV-11114 … DEV-11124 |

## What the plan produces (destination-independent — judged once)

32 create-plan fields from a 26-key record, of which **15 carry a non-`mapped` note** and **5 are
dropped entirely**. Identical on Notion, Supabase and Airtable, which is what proves these are
upstream of the destination packs.

```
mapped        title(PRIMARY) excerpt featured commentingEnabled minutesToRead wordCount
              firstPublishedDate lastPublishedDate slug seoSlug url status language
              translationId media.displayed media.custom wix_blog_record_id(SRCID ← _id)
downgraded    hashtags  richContent  richContent.nodes  richContent.metadata  heroImage
              media  media.wixMedia  seoData  seoData.tags  seoData.settings
needs_target  memberId→wix_members  categoryIds→wix_blog_categories  tagIds→wix_blog_tags
              relatedPostIds→wix_blog  pricingPlanIds→wix_pricing_plans      (all 5 dropped)
```

## Destination: NOTION

- Workbook `wkb_KLUmASQPlQ` · connections `coa_qaWixNot3` (source) / `coa_sJaD5tFEVG` (dest) · Sync `syn_ZeNKfi2GpB`
- Destination: database `7729dd66-aa72-4624-8511-11b6a6b85abf` ("Blog Posts") under QA page `3a6a9426-7a71-81a3-ac37-d46a30d61191`
- Runs: `rrn_UD8W1EA094` (initial, 213 creates / 0 failures), `rrn_fjz6sj2iak` (second-run check, **213 edits**), `rrn_j5tEW2VJ1I` (third run), CRUD rerun below
- Report: `/tmp/audit-wix_blog-notion.json`
- 27 properties created: 1 `title`, 4 `checkbox`, 2 `number`, 20 `rich_text`. **No `date`, `url`, `select`,
  `multi_select` or `relation` property was created.**
- Long values are chunked across multiple `rich_text` spans rather than truncated — the 6 647-char
  `richContent` and 6 617-char `nodes` values survived intact.
- Second run republished **all 213** records (every non-empty property re-sent).
- **Observation (not filed): Notion's edit path is drastically slower than its create path.** Run 1
  created 213 pages in ~95 s (`22:56:30` → `22:58:05`). The CRUD rerun `rrn_Q25ij2hpDh` took **well over
  15 minutes** to work through 186 edits — roughly 20× slower per record. Worth a look alongside
  DEV-10955 (Notion 2000-char split on the edit path); it makes the DEV-10556 churn far more expensive
  than the raw operation count suggests, since every steady-state run pays the edit-path cost for all
  213 records.

> Note on a discarded first attempt: `wkb_EIPRcz3KPb` / `rrn_yivaubnAlN` was abandoned because the
> harness auto-picked a stray Notion parent (it only reads `DEST_PARENT_ID` when it creates the
> destination connection itself, so `--dest-parent` must be passed with `--dest-connection`). It
> finished server-side; its 213 pages under `fable_qa_acct_child` are QA debris, not audit evidence.

## Destination: SUPABASE

- Workbook `wkb_bPZ8yk0W1T` · connections `coa_qaWixSup1` / `coa_SJKfFJz7Nv` · Sync `syn_04eyyQOhLQ`
- Destination: `public."Blog Posts"` in project `yqoxftqvixxcglgklbsw`
- Runs: `rrn_QTgXD9pD1j` (initial, 213 creates / 0 failures), `rrn_ckrM5Yvg16` (second-run check, **clean no-op**), CRUD rerun below
- Report: `/tmp/audit-wix_blog-supabase.json`
- 28 columns: `id uuid pk`, 4 `boolean`, 2 `integer`, 21 `text`. **`firstPublishedDate` and
  `lastPublishedDate` are `text`, not `timestamptz`** — the concrete proof for DEV-11103.
- Scalar arrays are comma-joined (`seoData.tags` → two JSON objects joined with `", "`), not
  first-element-collapsed.
- **Second run is a clean no-op** — the differential that proves the Notion/Airtable churn is not
  in those destination packs.

## Destination: AIRTABLE

- Workbook `wkb_uz7VSbtGqO` · connections `coa_qaWixAir1` / `coa_KhtY5XeAiO` · Sync `syn_ZOqsEpTZqZ`
- Destination: table `tbl9ywCw4yA6KlJdo` ("Blog Posts") in base `appGoopxI4Px4dyuv` ("Cetacean Invoicing")
- Runs: `rrn_sN794wzm7N` (initial, 213 creates / 0 failures), `rrn_lpqA4q8hk8` (second-run check, **213 edits**), CRUD rerun below
- Report: `/tmp/audit-wix_blog-airtable.json`
- 27 fields: 1 `singleLineText` title, 4 `checkbox`, 2 `number`, 20 `singleLineText`. **The 6 647-char
  `richContent` body was created as `singleLineText`, not `multilineText`/`richText`** — extra evidence
  for DEV-11114 (the plan declares `kind: 'text'` because no view declares it as rich text). It also
  costs fidelity on ordinary text: the CRUD-edited excerpt's embedded newline was flattened to a space
  (`line1\nline2` → `line1 line2`), which Supabase (`text`) and Notion (`rich_text`) both preserved.

## CRUD pass (Phase 4)

One round of source-side changes through Wix's own API via
[`crud-pass.mjs`](/tools/live-export-audit/seeds/wix_blog/crud-pass.mjs), then one `--rerun` per
destination workbook. Site total stayed at 213 (1 created, 1 deleted).

| Change           | Wix id                                                              | What was changed                                                                                            |
| ---------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| edit (long text) | `f2842f0a-1df7-4883-be83-54400c25eeab` (`fable_qa 03 longtext`)     | body rewritten to a 4 312-char paragraph; excerpt → `CRUD-EDITED excerpt — 🥺 日本語 "quoted" line1\nline2` |
| edit (scalars)   | `a733bd6a-6014-41bb-a479-8f6294c0d841` (`fable_qa 09 flags`)        | excerpt, `featured: true → false`, `commentingEnabled: false → true`                                        |
| create           | `9c3e699b-f7cf-4d08-bff9-a42356a70cce` (`fable_qa 13 crud created`) | new draft post                                                                                              |
| delete           | `329959ba-ee14-4245-88bb-5c0afe449d31` (`fable_qa 11 dangling fk`)  | hard-deleted (`permanent: true`)                                                                            |

| Destination | Run              | Publish counts                                                                      | Verified on the destination's own API                                                                                                                              |
| ----------- | ---------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Supabase    | `rrn_nGeKPTwu4P` | **1 create / 2 edits / 1 delete** — exactly the change set                          | 213 rows; `fable_qa 13 crud created` present; `fable_qa 11 dangling fk` gone; `richContent` length 4 486; edited excerpt intact **including the embedded newline** |
| Airtable    | `rrn_Qu1GT8EZ86` | 1 create / **212** edits / 1 delete (2 real edits + 210 records of DEV-10556 churn) | 213 records; create present; delete gone; `richContent` length 4 486; edited excerpts applied                                                                      |
| Notion      | `rrn_Q25ij2hpDh` | counters unreliable — see below                                                     | **214** pages (should be 213); create present (**twice**); delete gone; edits applied (`richContent` length 4 486, newline preserved)                              |

**Notion duplicated the created record.** The single source-side create
(`9c3e699b-f7cf-4d08-bff9-a42356a70cce`) produced **two** Notion pages,
`3aca9426-7a71-818e-bfb9-f3df3fa6026e` and `3aca9426-7a71-810d-a2e1-d2448d68e3b8`, both created at
`22:29:00Z` and both carrying the same `wix_blog_record_id` match key, even though the sync step
planned exactly one create. The run's own counters are mutually inconsistent —
`createsPlanned: 1, createsExecuted: 0`, `editsPlanned: 186` vs `editsExecuted: 209`,
`resultSummary: "Published 188 changes"` — so the duplicate is invisible from the run UI.

This is **already filed as [DEV-11016](https://linear.app/whalesync/issue/DEV-11016)**
(`[SHOPIFY→NOTION][core]` publish-plan retry re-executes already-successful creates); Wix Blog is a
second source service reproducing it, and the evidence is commented there rather than re-filed. The
likely trigger is duration: this run's edit phase took >15 min, versus seconds for the same change
set on Airtable and Supabase, which each produced exactly one create and no duplicate.

**And it does not self-heal.** Later runs completed with `failedCount: 0` and the database is still at
**214** non-archived pages (213 is correct), both duplicates live (`archived: false`, `in_trash: false`)
and both still carrying the same match key — even though the sync is configured with
`unmatchedDestinationPolicy: { withMatchKey: 'delete', withoutMatchKey: 'ignore' }`, which should have
reconciled the extra row away. `SyncRemoteIdMapping` holds exactly **one** row for the source record,
pointing at the second page, so the first is an unmapped-but-match-keyed orphan frozen at its creation
time while its twin keeps receiving the churn edits. Commented on DEV-11016 with the mechanism.

> Verification caveat for whoever re-proves this: Notion's `POST /v1/databases/{id}/query` is
> **eventually consistent** right after a large write. Immediately after a run it briefly reported 212
> pages and no duplicate; a minute later it reported 214 with the duplicate. Always re-query before
> concluding a run was clean.

**Source-side change detection is correct.** Even with no incremental pull and no tombstone endpoint,
the full-scan pull classified the round exactly right — `createdCount: 1, deletedCount: 1, updatedCount: 2`
on folder `dfd_RCbjeebyaa` — so Wix source deletes _are_ detected (via the full scan) and edits are not
over-reported.

Two things this pass established that are **not** bugs and should not be re-filed:

- **Wix itself drops `hashtags` on update.** `crud-pass.mjs` set `hashtags: ['crud-edited-tag']` on
  `fable_qa 09 flags`; re-reading the post through `GET /blog/v3/draft-posts/{id}` returns
  `hashtags: []`. Wix derives hashtags from `#tags` inside the content on update. The pipeline
  correctly mirrored the empty array to all three destinations.
- **Airtable flattens the newline** in the edited excerpt (`line1\nline2` → `line1 line2`) because the
  field was created as `singleLineText`. Supabase (`text`) and Notion (`rich_text`) both preserve it.
  A destination limitation of the created column type, related to DEV-11114's point about
  `richContent` also landing in `singleLineText`.

## Destination drift (Gate 11)

Deleted/archived `fable_qa bulk 0100` out-of-band on each destination through that service's own API,
then re-ran the routine. **The engine restored the record on all three** — no silent divergence, and
no loud failure needed.

| Destination | Out-of-band action                                                            | Restore run      | Result                                                                                                       |
| ----------- | ----------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------ |
| Supabase    | `DELETE FROM "Blog Posts" WHERE title = 'fable_qa bulk 0100'` (212 rows left) | `rrn_g09vm7JLHY` | **1 create / 0 edits / 0 deletes** → row back, new `id` `da4a1032-47e7-4c3b-b8fe-c027e44c5c3f`, total 213 ✅ |
| Airtable    | `DELETE /v0/appGoopxI4Px4dyuv/tbl9ywCw4yA6KlJdo/recR1TkhZmQbUClme`            | `rrn_nofjKwKoxQ` | **1 create** (+212 churn edits) → record back, total 213 ✅                                                  |
| Notion      | `PATCH /v1/pages/3aca9426-7a71-8119-9b88-f1a9b2903c82 {archived: true}`       | `rrn_4IWvhW0JPl` | **1 create / 212 edits / 0 deletes**, `failedCount: 0` → page back ✅                                        |

Worth noting: because the source record still exists, "restore" here means **re-create with a new
destination id**, not un-archive. That is the correct non-destructive outcome, but it does mean a
destination-side delete silently loses any destination-only state on that row.

## Findings

All filed as children of DEV-10932, project `[MAJOR] Live Export`, label `live-export-qa`.
**Most are now fixed — see [Round 2](#round-2--fixes-implemented-and-re-verified).**

| Issue                                                     | Layer       | Summary                                                                                                                                                                                                                                          | Priority |
| --------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| [DEV-11114](https://linear.app/whalesync/issue/DEV-11114) | view        | `richContent` (the post body) exports as raw Ricos JSON on every destination; the tested Ricos→HTML/Markdown converters are instantiated and never called                                                                                        | Urgent   |
| [DEV-11115](https://linear.app/whalesync/issue/DEV-11115) | transport   | 4 of 5 FK targets name tables the connector never exposes → categories, tags, author and pricing plans are silently dropped from every export                                                                                                    | High     |
| [DEV-11116](https://linear.app/whalesync/issue/DEV-11116) | transport   | the `relatedPostIds` self-FK never resolves: `linkedTableId: 'wix_blog'` can't match the folder's `remoteId` token `wix-blog`, and `unresolvedLinkedTableRemoteId` is plumbed but never consulted                                                | High     |
| [DEV-11117](https://linear.app/whalesync/issue/DEV-11117) | transport   | 6 schema fields the DraftPost API never returns (`wordCount`, `lastPublishedDate`, `slug`, `url`, `heroImage`, `translationId`) → permanently empty columns, and hero-image asset extraction can never fire                                      | Medium   |
| [DEV-11118](https://linear.app/whalesync/issue/DEV-11118) | transport   | real DraftPost fields absent from the schema (`editedDate`, `_createdDate`, `slugs`, `hasUnpublishedChanges`, `contentId`, `changeOrigin`, `mostRecentContributorId`, `previewTextParagraph`, `translations`) land on disk but can't be exported | Medium   |
| [DEV-11119](https://linear.app/whalesync/issue/DEV-11119) | view        | `firstPublishedDate`/`lastPublishedDate` export as text, not date columns, despite `format: 'date-time'`                                                                                                                                         | Medium   |
| [DEV-11120](https://linear.app/whalesync/issue/DEV-11120) | view        | `hashtags` downgrades to a `", "`-joined string — ambiguous for elements that contain commas                                                                                                                                                     | Medium   |
| [DEV-11121](https://linear.app/whalesync/issue/DEV-11121) | view        | 32 plan columns: nested objects duplicated as parent **and** children, with meaningless leaf names (`nodes`, `metadata`, `tags`, `settings`, `wixMedia`, `displayed`, `custom`)                                                                  | Medium   |
| [DEV-11122](https://linear.app/whalesync/issue/DEV-11122) | view        | the featured image exports as an unusable `wix:image://v1/…` URI instead of an `https://static.wixstatic.com/media/…` URL                                                                                                                        | Medium   |
| [DEV-11123](https://linear.app/whalesync/issue/DEV-11123) | transport   | offset pagination passes no `sort`, so Wix's default `EDITING_DATE_DESC` can skip or duplicate records when posts change during a multi-page pull                                                                                                | Medium   |
| [DEV-11124](https://linear.app/whalesync/issue/DEV-11124) | transformer | `html-to-ricos` emits `link.target: '_blank'`; Wix's API rejects it (`enum must be in [SELF, BLANK, PARENT, TOP]`)                                                                                                                               | Low      |
| [DEV-10556](https://linear.app/whalesync/issue/DEV-10556) | core        | (existing) second run republishes all 213 records on Notion + Airtable, clean no-op on Supabase — evidence commented, **not** filed per-source                                                                                                   | —        |

Five of these (DEV-11114, 11119, 11120, 11121, 11122) are the same root cause — **Wix Blog has no
default view** — and all land in one new `wix-blog-default-view.ts`.

### Accepted downgrades

Not bugs — plain text is the honest representation, and no plausible inner value exists to pluck.

| Field                                         | Type                     | Why accepted                                                                                                                                                                                                                                     |
| --------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `seoData`, `seoData.tags`, `seoData.settings` | object / array / unknown | Wix's SEO tag array is an arbitrary head-tag AST (`{type, children, props}`); there is no single scalar worth plucking and no destination type that fits. Text is honest. Its _duplication_ across three columns is the real defect (DEV-11106). |
| `media`, `media.wixMedia`                     | object / unknown         | The container itself is genuinely opaque; the actionable part is the image URI inside it, filed as DEV-11108.                                                                                                                                    |
| `richContent.metadata`                        | unknown                  | Wix-internal document metadata (`version`, `createdTimestamp`, an all-zero `id`). Nothing a user wants; should simply be hidden.                                                                                                                 |
| `status`                                      | string                   | A closed enum (`DRAFT`/`UNPUBLISHED`/`PUBLISHED`/`SCHEDULED`) that _could_ be a select, but `TablePropertyType` has no select member, so text is the best currently-expressible mapping.                                                         |
| `language`                                    | string                   | BCP-47 tag; text is correct. (Wix silently ignored a `language: 'fr'` write on a single-language site — a Wix behaviour, not ours.)                                                                                                              |

## Out-of-scope observations (Wix as a _destination_ / general connector, not Live Export source)

Found while seeding through Wix's own API; recorded here and in `STATE.md` rather than filed under
this Live Export umbrella, because Live Export never writes back into Wix.

- **`createDraftPost` requires `memberId`** ("Missing post owner information"), but the schema marks
  `memberId` `x-scratch-readonly`. Creating a Wix post from Scratch therefore cannot work today.
- **`deleteRecords` passes `permanent: true`**, bypassing Wix's trash bin, so `restoreFromTrashBin`
  can never be used — at odds with "default to non-destructive, reversible actions".
- **`getBatchSize()` returns 1** and the code comments claim Wix has no bulk endpoints, but
  `bulkCreateDraftPosts` / `bulkUpdateDraftPosts` / `bulkDeleteDraftPosts` all exist in the pinned SDK.
- **`pullRecordFilesByIds` throws** `not implemented`, so single-record refresh is unavailable.
- **No live integration spec** (`server/test/integration/wix-connector.spec.ts` does not exist) and Wix
  is not in the post-deploy CI job.

## Round 2 — fixes implemented and re-verified

Same day, same torture site. Two changes: **Categories/Tags/Members exposed as real tables**, and the
**default view the connector never had**. Rich content is passed through exactly as Wix provides it
(raw Ricos) — no HTML/Markdown conversion, deferring to the planned system-wide rich-text feature.

|                                               | Round 1 (audit)                           | Round 2                                               |
| --------------------------------------------- | ----------------------------------------- | ----------------------------------------------------- |
| Tables exposed                                | 1                                         | **4**                                                 |
| Plan columns on Blog Posts                    | 32                                        | **19**                                                |
| Non-`mapped` plan notes                       | **15**                                    | **0**                                                 |
| Dropped foreign keys                          | **5**                                     | **0**                                                 |
| Categories / Tags / Author on the destination | absent                                    | real Airtable `multipleRecordLinks`                   |
| Related posts (self-relation)                 | absent                                    | self-referential links                                |
| Cover image                                   | `wix:image://v1/9a4116_…`                 | `https://static.wixstatic.com/media/9a4116_…` (`url`) |
| Timestamps                                    | `singleLineText`, mostly empty            | `dateTime` with real values                           |
| Post body                                     | `singleLineText`, stored twice per record | `multilineText`, once                                 |
| Publish failures                              | 0                                         | 0 (221 records)                                       |
| Connector unit tests                          | 86                                        | **130**                                               |

**Verified on a server running this branch, not the shared dev stack.** The dev server on `:3010` is
another worktree's code, so the fixes were exercised on an isolated parallel session
(`/start-parallel-session` → `http://localhost:3011`, own Redis on `:6380`, own BullMQ worker):

- Workbook `wkb_2ZC0zysfOd` · connections `coa_qaWixV2Air` / `coa_6QTwvQ4TDr` · sync `syn_MZUGlVU74M`
- Run `rrn_ARBXLcVf3H` → `Published 221 changes`, `failedCount: 0`, sync `Blog Posts 213 / Categories 3 / Tags 4 / Members 1`
- Report `/tmp/audit-v2-airtable.json`, combined plan `/tmp/plan-v2.json`
- Airtable tables: posts `tblgycvicSNF49mqW`, categories `tbl69zmK9eqbgVAbu`, tags `tblmKSiFGXjsUjyw6`, members `tblDhwub375MIjQ5o` in `appGoopxI4Px4dyuv`

Read back through Airtable's own API: `Categories`/`Tags`/`Author`/`Related posts` are all
`multipleRecordLinks` pointing at the right tables; `fable_qa 08 arrays many` carries 3 category + 3
tag + 1 author link; `fable_qa 12 related posts` carries 3 self-links; `fable_qa 05 richtext` has
`Cover image = https://static.wixstatic.com/media/9a4116_2161bd3b120046b7bc653b638305c2cc~mv2.jpg`.

> One harness artifact to expect on re-review: `audit.mjs` generates a plan **per folder**, so the
> Blog Posts plan alone still reports `needs_target` for Author/Categories/Tags — those tables aren't
> in a single-table plan. The combined 4-source plan has **0** non-`mapped` notes, `droppedForeignKeys`
> is 0, and the real save produced actual links. Judge the combined plan, not the per-folder one.

### What Round 2 did NOT fix

- **Gate 10 (second run is a no-op)** still fails — 216 of 221 records republished. That's DEV-10556,
  a core engine issue no connector change can address.
- **DEV-11114's conversion half** — the body is a clean single `multilineText` column but still raw
  Ricos JSON. Deliberate; waiting on the system-wide rich-text feature.
- **DEV-11123** is mitigated (`EDITING_DATE_ASC` turns a skipped record into a harmless re-read), not
  solved. Real fix is cursor paging via `queryDraftPosts`, folded into DEV-11126.

> **Superseded by Round 4** — all three of the connector-owned items above are now fixed. Only
> DEV-10556 (core) remains.

### New follow-ups

| Issue                                                     | Summary                                                                                                                      |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| [DEV-11126](https://linear.app/whalesync/issue/DEV-11126) | Implement incremental pull — `editedDate` is now declared + annotated, and the same endpoint switch fixes DEV-11123 properly |
| [DEV-11127](https://linear.app/whalesync/issue/DEV-11127) | Make Categories/Tags writable (all three reference tables are read-only for now)                                             |
| [DEV-11128](https://linear.app/whalesync/issue/DEV-11128) | Creating a post is impossible — Wix requires `memberId` on create, our schema marks it readonly                              |
| [DEV-11129](https://linear.app/whalesync/issue/DEV-11129) | `getBatchSize()` is 1 and the comments wrongly claim Wix has no bulk endpoints                                               |

## Round 3 — pre-launch validation (2026-07-30)

A full re-run of `/test-live-export WIX_BLOG notion,supabase,airtable` against the Round 2 connector,
to decide which of the DEV-10932 children are still real. **This is the authoritative section.**

- Code under test: branch `wix-blog-live-export-audit`, commit `08a173a7e` — **not yet merged to
  master.** Everything below is true of that branch and of nothing on `master`. Merging it is the
  single biggest launch blocker at the time; see
  [Launch blockers](#launch-blockers-as-of-round-3--13-cleared-since). It has since merged as
  `9ca75f1b0`, so this section now describes shipped code.
- Server: the already-running local dev server on `:3010` (`nest start --watch` out of the
  `wix-blog-live-export-audit` worktree), not a parallel session.
- Source connection: the human-connected Wix OAuth row has been re-created since Round 2 — it is now
  `wkb_kbxXKqnzF7` / **`coa_q5d6HiSWVW`** (was `coa_OFBt3xqMf0`), same site `instanceId`
  `d9be332a-…`. Pass it to the provisioner as `WIX_SOURCE_CONNECTION=coa_q5d6HiSWVW`.
- Seeds: `seed.mjs` re-run idempotently → **214 draft posts** (the 12 torture records incl. the
  restored `fable_qa 11 dangling fk`, `fable_qa 13 crud created` left over from Round 1's CRUD pass,
  the `T200 …` boundary record, and 200 `fable_qa bulk NNNN`), 3 categories, 4 tags, 1 member.
- Fresh workbooks, one per destination:

| Destination | Workbook | Source conn / dest conn | Sync | First run |
|---|---|---|---|---|
| Supabase | `wkb_aJmTjkffWE` | `coa_plSUPWix1` / `coa_SYy6MKUdyr` | `syn_LIdYoBsHGI` | `rrn_b2aqBRllyJ` |
| Airtable | `wkb_gdw1uyWTNY` | `coa_plAIRWix1` / `coa_fVFk0wa2pk` | `syn_ogdntxgyRN` | `rrn_28DOHlMgJV` |
| Notion | `wkb_8G7koqHS1F` | `coa_plNOTWix1` / `coa_MRJSvn56qf` | `syn_CnrmzAGMpH` | `rrn_8gEPQu26TJ` |

- Destination tables created: Supabase `public."Blog Posts 2" / "Categories 4" / "Tags 3" / "Members"`;
  Airtable `tblkgxPicLzNrITEd / tblz9e0Jz05pfBjdM / tblM6DFjTzHO9sKm4 / tblBkE2GFDp6Xtrc4` in
  `appGoopxI4Px4dyuv`; Notion dbs `33b9d420-… / 78191d5e-… / 5038371c-… / 500ade13-…`.
- Reports: `.context/wix-prelaunch/reports/` (gitignored) — `audit-wix_blog-{supabase,airtable}.json`
  (first run + no-op check), `noop3-notion.json` (Notion's no-op check, re-run cleanly after the
  wedge), `crud-{supabase2,airtable,notion}.json` (the CRUD + drift round).
- **The server wedged mid-audit** (DEV-11041) during Notion's first no-op check, freezing run
  `rrn_r4WdNRfGfT` at `status: running`. Notes for anyone re-running: the `RoutineRunReaperService`
  cron *does* recover it, but only once the step's job has been terminal for longer than its 5-minute
  "just finished, give the driver a chance" guard — here that took ~2.5 h because the wedged sync job
  itself didn't finish until the server came back. While it is stuck, `POST routines/trigger` returns
  **409 `already has an active run`**, so you cannot simply retry. Wait it out rather than restarting.
  Do **not** trust the reaper-resumed run's numbers: `rrn_r4WdNRfGfT` reported `sync: no changes`
  followed by `publish: 222 updates`, because its sync had already staged those changes in an earlier
  execution. The clean isolated re-run (`noop3-notion.json`) is the one to cite.

### Gates

| # | Gate | Status | Evidence |
|---|---|---|---|
| 1 | Preflight (server, token, creds) | ✅ | `preflight OK` on all three; cloned connections `coa_plSUPWix1`/`coa_plAIRWix1`/`coa_plNOTWix1` each `{"health":"ok"}`, as did all three destination connections |
| 2 | Recon: connector + View read, tables chosen | ✅ | `wix-blog-{connector,json-schema,default-view,tables,media,schema-parser}.ts`. All **4** tables selected (`wix-blog`, `wix-blog-categories`, `wix-blog-tags`, `wix-members`) |
| 3 | Torture data seeded + read back via service API | ✅ | `seed.mjs` → 214 posts / 3 categories / 4 tags / 1 member, all re-read through Wix's own API |
| 4 | Plan audit: every downgraded field judged | ✅ | **0 downgrade notes** across all 4 tables on Supabase and Airtable. The only non-`mapped` notes are `needs_target` lines for sibling-table FKs, which are the known per-folder-plan harness artifact, plus one real `downgraded` on Supabase: `Related posts → only the first linked record will sync` (correct for a single-valued Postgres FK; DEV-10956/DEV-11047) |
| 5 | FKs identified as foreignKey; links resolve on destination | ✅ | `droppedForeignKeys: []` everywhere. Airtable: `Author`/`Categories`/`Tags`/`Related posts` are `multipleRecordLinks`, `fable_qa 08 arrays many` holds **3** category + **3** tag links, `fable_qa 12 related posts` holds **3** self-links. Notion: 4 `relation` properties, same multiplicities. Supabase: 4 real FK constraints, first-element only |
| 6 | First run: publish failures = 0 | ✅ | All three: `Published 222 changes`, `createsExecuted: 222`, `failedCount: 0`, `failedOperations: []` |
| 7 | Destination-side spot check (≥3 records/table, dest service API) | ✅ | 214/3/4/1 read back on each destination's own API. Field-by-field on the all-empty, unicode/RTL/ZWSP/emoji, 6 647-char body, cover-image, arrays-many, related-posts and flags records — see [What was verified](#what-was-verified-round-3) |
| 8 | CRUD pass: edit / create / delete mirrored | ✅ | All six change classes mirrored on all three destinations — see [CRUD pass](#crud-pass-round-3). **Notion did NOT duplicate the create this round** (214 pages, zero duplicate titles), so Round 1's DEV-11016 reproduction is duration-dependent and flaky, not deterministic |
| 9 | Pagination: 200+ record table fully synced | ✅ | 214 seeded → 214 pulled → 214 published → 214 read back on each destination, across 3 pages of 100. Soundness caveat still open as DEV-11123 |
| 10 | Second run is a no-op | ❌ | Supabase **clean no-op** (0 operations). Airtable **217 edits**, Notion **222 edits** on unchanged data. Two *different* mechanisms — see [the churn differential](#the-churn-differential-gate-10) |
| 11 | Destination drift: out-of-band delete restored | ✅ | Deleted/archived `fable_qa bulk 0100` out-of-band on each destination, then re-ran: restored on all three as a fresh record — see [CRUD pass](#crud-pass-round-3) |
| 12 | Findings filed under DEV-10932 with `live-export-qa` | ✅ | See [Issue disposition](#issue-disposition-round-3) |

### What was verified (Round 3)

Read back through each destination's **own** API, not through our pull:

| Torture case | Result |
|---|---|
| all-empty (`fable_qa 01 minimal`) | Publishes cleanly everywhere. Note the body is **never** empty: Wix returns a 307-char boilerplate Ricos document for a post with no content, so `Content` is a JSON blob on every row (DEV-11114) |
| unicode / RTL / ZWSP / emoji / quotes / HTML entities / tab | Intact in `Title` and `Excerpt` on all three (`fable_qa 02 unicode`, 144-char excerpt, 482-char body) |
| >2 000 and >4 000 char body | `fable_qa 03 longtext` — 6 647 chars intact on Supabase `text`, Airtable `multilineText`, Notion `rich_text` (chunked across spans). No truncation anywhere |
| boundary values | `T200 …` title at Wix's 200-char cap, 500-char excerpt, 100-char `seoSlug` — all intact |
| arrays 0 / 1 / 5 elements, with commas + quotes inside elements | `Hashtags` comma-joined; ambiguous by construction, closed as DEV-11047's problem, not Wix's |
| foreign keys, in-export and dangling | 3 categories + 3 tags + 1 author + 3 related posts resolve to real links (Airtable/Notion) and real FK rows (Supabase). `pricingPlanIds` is deliberately a plain id array, so the dangling GUID on `fable_qa 11` drops nothing |
| rich text (every Ricos node kind) | Survives as raw Ricos JSON — see DEV-11114 |
| Wix media image | `wix:image://v1/9a4116_…` → `https://static.wixstatic.com/media/9a4116_…` on all three (`url` column on Airtable/Notion) |
| 200+ records | 214/214 on each destination |
| reference tables | Categories 3/3, Tags 4/4, Members 1/1 with correct unicode labels and populated dates |

### CRUD pass (Round 3)

Gates 8 and 11 in one round: six source-side change classes through Wix's own API
([`crud-pass.mjs`](/tools/live-export-audit/seeds/wix_blog/crud-pass.mjs)) **plus** an out-of-band
destination delete, then one `--rerun` per workbook. Site total stayed at 214 (1 created, 1 deleted).

| Change | Target | What changed |
|---|---|---|
| edit (long text) | `f2842f0a-…` `fable_qa 03 longtext` | body → 4 312-char paragraph; excerpt → `CRUD-EDITED excerpt — 🥺 日本語 "quoted" line1\nline2` |
| edit (scalars) | `a733bd6a-…` `fable_qa 09 flags` | excerpt, `featured`, `commentingEnabled`, `hashtags` |
| create | `2380447b-…` `fable_qa 14 crud created` | new draft post |
| delete | `a1477996-…` `fable_qa 11 dangling fk` | hard-deleted (`permanent: true`) |
| **edit on a reference table** | category `36578837-…` `fable_qa cat alpha` | description → unicode string. **New in Round 3** — Categories/Tags/Members only became exported tables in Round 2, so no round had ever proved a reference-table change mirrors |
| **publish a post** | `a733bd6a-…` `fable_qa 09 flags` | `UNPUBLISHED` → `PUBLISHED`. **New in Round 3** — every seeded post had been a pure draft, leaving two things unproven: that a PUBLISHED post is pulled at all (the connector only calls `listDraftPosts`), and that `firstPublishedDate` is ever non-empty |
| destination drift | `fable_qa bulk 0100` | deleted out-of-band on each destination before the rerun |

| Destination | Run | Publish counts | Verified on that service's own API |
|---|---|---|---|
| Supabase | `rrn_wvlQ7oNI8z` (failed, scratch-git 500) → `rrn_YSw3RV2DgL` retry | **2 creates / 3 edits / 1 delete**, `failedCount: 0` — *exactly* the change set, zero churn | 214 rows; create present; delete gone; drift row restored; body 4 486 chars; **excerpt newline preserved**; `Status = PUBLISHED`, `First published = 2026-07-30 04:06:59+00`; category description mirrored |
| Airtable | `rrn_6vMxIa6OJT` | 2 creates / 216 edits / 1 delete (2 real edits + category + 213 churn) | 214 records; create `recnxgjPVnD7VNjh5`; delete gone; drift restored as `recElrlrvDF45MXTP`; body 4 486; `Status = PUBLISHED`, `First published = 2026-07-30T04:06:59.000Z`; category mirrored. **Excerpt newline flattened** to a space (`singleLineText`) |
| Notion | `rrn_mBhu4l7J6A` | 2 creates / 220 edits / 1 delete, `failedCount: 0` | **214 pages, zero duplicate titles**; create present exactly once; delete gone; drift restored; body 4 486; **newline preserved**; `Status = PUBLISHED`, `First published` populated; category mirrored |

Three things this pass established:

- **Published posts are exported.** `listDraftPosts` keeps returning a post after it is published
  (status flips to `PUBLISHED`), so the connector's draft-only endpoint choice does not hide live
  content. `firstPublishedDate` populates at the same moment, so the `First published` column is not
  dead — it is simply empty for drafts, which is Wix's own semantics.
- **Reference-table edits mirror.** A category description change reached all three destinations with
  unicode intact.
- **Notion's duplicate-create (DEV-11016) did not reproduce.** Round 1's duplicating run took >15 min;
  this one took ~7. Evidence commented on DEV-11016 that the repro is duration-dependent.

Two incidental findings, both commented rather than re-filed:

- **Wix's Categories read and write shapes disagree.** `GET` returns `displayPosition: -1` for a
  menu-hidden category; `Update Category` rejects it with `got -1, expected 0 or more`, so a
  read-modify-write of an untouched category 400s. That is a landmine for DEV-11127 (making Categories
  writable), since our view exposes it as an editable `Menu position` column. Commented there.
- **A transient scratch-git `HTTP 500` on one folder's destination pull aborted the entire Supabase
  run** (sync and publish skipped, nothing published); an identical retry succeeded. Same shape as
  DEV-11075, which is Canceled — commented there with the recurrence.

### The churn differential (gate 10)

The three destinations churn for **different reasons**, which is only visible because the reference
tables are in the export:

| Destination | Blog Posts (214) | Categories (3) | Tags (4) | Members (1) | Total |
|---|---|---|---|---|---|
| Supabase | 0 | 0 | 0 | 0 | **0 — clean no-op** |
| Airtable | 214 | 3 | **0** | **0** | 217 |
| Notion | 214 | 3 | **4** | **1** | **222 — everything** |

Tags and Members are the tell. Airtable leaves them alone; Notion re-publishes them too.

- **Notion churns every row of every table** — not value-dependent, so it is DEV-10556's original
  echoed-envelope mechanism.
- **Airtable churns exactly the rows holding at least one empty value.** Tags and Members have every
  field populated; every Blog Post and every Category has at least one empty field. Root cause: the
  Airtable API omits empty fields from `record.fields` entirely, so an omitted field never equals the
  empty string we mean to write. Filed as **DEV-11131** with a 4-for-4 table-level correlation.
- **Supabase stores what we send and returns it verbatim**, so nothing churns.

Cost asymmetry worth knowing: the same workload is a ~13 s no-op on Supabase, a ~20 s 217-edit run on
Airtable, and a **~7 min** 222-edit run on Notion — and that Notion edit pass is what wedged the local
server mid-audit (DEV-11041).

### Issue disposition (Round 3)

| Issue | Round 3 verdict |
|---|---|
| [DEV-11115](https://linear.app/whalesync/issue/DEV-11115) 4 of 5 FKs dangling | **Done** — 4 tables exposed, `droppedForeignKeys: []`, real links on all three |
| [DEV-11116](https://linear.app/whalesync/issue/DEV-11116) `relatedPostIds` self-FK | **Done** — self-relation resolves, 3 links preserved |
| [DEV-11117](https://linear.app/whalesync/issue/DEV-11117) 6 phantom schema fields | **Done** — removed from the schema; asset extraction re-pointed at `media.wixMedia.image` |
| [DEV-11118](https://linear.app/whalesync/issue/DEV-11118) real fields absent from the schema | **Done** — `editedDate` (+ last-modified annotation), `_createdDate`, `slugs`, `hasUnpublishedChanges`, `previewTextParagraph`, `mostRecentContributorId` declared; `contentId`/`editingSessionId`/`changeOrigin`/`translations` deliberately left undeclared |
| [DEV-11119](https://linear.app/whalesync/issue/DEV-11119) dates as text | **Done** — `timestamptz` / `dateTime` / `date` with real values |
| [DEV-11121](https://linear.app/whalesync/issue/DEV-11121) 32-column plan | **Done** — 19 columns, no duplicated containers, no bare leaf names |
| [DEV-11122](https://linear.app/whalesync/issue/DEV-11122) `wix:image://` URI | **Done** — resolved https URL on all three |
| [DEV-11124](https://linear.app/whalesync/issue/DEV-11124) `html-to-ricos` `_blank` | **Done** — enum mapping added both directions; unit-tested, not live-exercised (Live Export never writes to Wix) |
| [DEV-11120](https://linear.app/whalesync/issue/DEV-11120) `hashtags` comma-join | **Canceled** — the warning is gone but the ambiguity is unfixable at the view layer (`TablePropertyType` has no multi-value member). Evidence moved to [DEV-11047](https://linear.app/whalesync/issue/DEV-11047) |
| [DEV-11114](https://linear.app/whalesync/issue/DEV-11114) body exports as raw Ricos | **STILL OPEN (Urgent)** — column shape fixed (one `multilineText`/`richtext` column, no duplicate), value unchanged. Retitled to the remaining scope. → **fixed in [Round 4](#round-4--launch-laundry-list)** |
| [DEV-11123](https://linear.app/whalesync/issue/DEV-11123) unstable pagination | **STILL OPEN** — a `sort` was added but the mitigation doesn't hold; see below. Retitled, blocked on DEV-11126. → **fixed in [Round 4](#round-4--launch-laundry-list)** with real cursor paging |
| [DEV-11126](https://linear.app/whalesync/issue/DEV-11126) incremental pull | open, unchanged (now unblocked by `editedDate`) |
| [DEV-11127](https://linear.app/whalesync/issue/DEV-11127) Categories/Tags writable | open, unchanged |
| [DEV-11128](https://linear.app/whalesync/issue/DEV-11128) create needs `memberId` | open, unchanged (`memberId` is still `x-scratch-readonly`). → **fixed in [Round 4](#round-4--launch-laundry-list)** (`x-scratch-write-once`) |
| [DEV-11129](https://linear.app/whalesync/issue/DEV-11129) `getBatchSize()` is 1 | open, unchanged. → **fixed in [Round 4](#round-4--launch-laundry-list)** (per-operation batch sizes) |
| **[DEV-11130](https://linear.app/whalesync/issue/DEV-11130)** *(new)* | Members table exports the site's whole member directory, with login email + CRM contact name visible by default. → **cancelled** (we mirror, we don't filter), but re-checking it surfaced the real bug — Members offered unconditionally — filed and fixed as DEV-11143 in [Round 4](#round-4--launch-laundry-list) |
| **[DEV-11131](https://linear.app/whalesync/issue/DEV-11131)** *(new)* | `[→AIRTABLE][dest-pack]` steady-state churn root cause: Airtable omits empty fields on read-back |
| [DEV-11041](https://linear.app/whalesync/issue/DEV-11041) | evidence added — the server wedge that blocked gates 8 and 11 |
| [DEV-10556](https://linear.app/whalesync/issue/DEV-10556) | still the umbrella for churn; the Airtable half is now root-caused in DEV-11131 |

#### Why DEV-11123's mitigation doesn't hold

Round 2 switched `fetchPage` to `sort: 'EDITING_DATE_ASC'` on the argument that an edited post moves
past the cursor, so the worst case is a harmless re-read. That accounts for where the edited record
goes but not for the hole it leaves behind. With the cursor at `offset=100`, editing a post at index
5 shifts old index 101 into new index 100 — so **old index 100 is never fetched.** Each direction
loses a record under a different, equally ordinary condition:

| Sort | Edit to an already-read record | Edit to a not-yet-read record |
|---|---|---|
| `EDITING_DATE_DESC` (Round 1) | safe | skipped + one duplicate |
| `EDITING_DATE_ASC` (now) | **skipped** | safe |

Offset paging over a mutable ordering can't be made safe; the fix is cursor paging via
`queryDraftPosts`, folded into DEV-11126. The code comment claiming ASC is safe should be corrected.

> **Resolved in [Round 4](#round-4--launch-laundry-list):** Blog Posts now page by cursor through
> `queryDraftPosts` sorted `ascending('_id')`, so the ordering is immutable and a mid-scan edit can no
> longer shift rows past the cursor in either direction.

### Launch blockers (as of Round 3 — 1–3 cleared since)

1. ~~**The connector fixes are on an unmerged branch.**~~ Merged — the Round 2 work landed on `master`
   as `9ca75f1b0`, so every ✅ in this section now describes shipped code.
2. ~~**[DEV-11114](https://linear.app/whalesync/issue/DEV-11114)** — post bodies export as raw Ricos JSON.~~ Fixed in Round 4 and
   re-verified live (see [Verified live](#verified-live-post-merge-2026-07-30)).
3. ~~**[DEV-11130](https://linear.app/whalesync/issue/DEV-11130)** — member login emails on by default.~~ Cancelled; the real bug it
   surfaced (DEV-11143) is fixed in Round 4.
4. **Gate 10 (second run is a no-op) still fails** — Airtable 217, Notion 222, Supabase clean.
   [DEV-11131](https://linear.app/whalesync/issue/DEV-11131) makes the Airtable half concretely fixable; the Notion half stays with DEV-10556.

Everything else on the launch checklist now passes: gates 1–9, 11 and 12 are green on all three
destinations, including the CRUD, reference-table, publish-state and destination-drift cases that no
earlier round had exercised.

## Round 4 — launch laundry list

Cleared the remaining connector-owned launch blockers under DEV-10932. **Code + unit coverage only —
not re-run against live services**, so the gate table above still reflects Round 2's live evidence.

| Issue     | What changed                                                                                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DEV-11114 | New `ricos_to_html` transformer wired as the `Content` column's `codec.toCore`. The body leaves as HTML (`<h1>…</h1><p>…<strong>bold</strong>…`) instead of a 6 647-char Ricos JSON blob. The record on disk is unchanged — still verbatim Ricos. |
| DEV-11128 | `memberId` is `x-scratch-write-once` rather than `x-scratch-readonly`, so a post can be created from Scratch at all. The Author column carries the same flag, and its FK gives a real member picker instead of a pasted GUID.                     |
| DEV-11129 | `getBatchSize` is per-operation: update **20**, delete **100**, through the SDK's bulk endpoints with per-item `itemMetadata` checked. **Creates stay at 1** — bulk create is non-atomic and the publish retry would duplicate posts (DEV-11016). |
| DEV-11123 | **Actually fixed, not mitigated:** Blog Posts page by cursor via `queryDraftPosts`, `ascending('_id')`. This is the switch Round 2 deferred into DEV-11126; the incremental-pull half of that issue remains.                                      |
| DEV-11130 | Stays **cancelled** — we mirror, we don't filter. But re-checking it found a different real bug, now fixed: `listTables` offered Members unconditionally though the Wix Members Area is a separate App Market app a blog need not have installed (filed as DEV-11143). |

**Coverage:** connector unit tests 130 → 146, plus a new `ricos_to_html` transformer spec and a
`wix-blog-posts` fixture in the view-codec goldens (`src/sync/__fixtures__/view-codec/`) — the
guardrail that proves the body renders to HTML through the real default view on real record shapes.

**Still open, unchanged:** gate 10 / DEV-10556 (core republish churn), DEV-11126 (incremental pull),
DEV-11127 (Categories/Tags writable), `pullRecordFilesByIds`, and the live integration spec.

### Verified live (post-merge, 2026-07-30)

The "live re-verification" this round was waiting on. A fresh single-destination export on `master`
(`b30ea6903`) against the same burner site — workbook `wkb_X4zUEACjwk`, Supabase
`public."Blog Posts 3" / "Categories 5" / "Tags 4" / "Members 2"`:

- `Published 222 changes`, 0 failures, 214 posts, `droppedForeignKeys: []`, FK joins resolve to the
  right rows, dates / cover image / publish state all correct — no regression from Round 3.
- **Second run is a clean no-op** on Supabase, as before.
- **DEV-11114 confirmed on real data.** `fable_qa 05 richtext` lands as 728 chars of HTML covering
  every Ricos node kind the seeder emits, with escaping intact in both an `href` and a code block:

  ```html
  <h1>Heading level 1</h1><h2>…</h2><p>plain <strong>bold</strong> <em>italic</em> <u>underline</u> <del>struck</del></p>
  <p>a link to <a href="https://example.com/a?b=c&amp;d=e" target="_blank">example.com</a></p>
  <ul><li>bullet one</li>…</ul><ol>…</ol><pre>const x = {"a": 1};… `&lt;b&gt;${x}&lt;/b&gt;`</pre>
  <blockquote><p>A quoted claim.</p></blockquote><hr><img src="https://static.wixstatic.com/media/9a4116_…" alt="QA alt text">
  ```

  The all-empty post went from **307 characters of Ricos boilerplate to `<br>`** — 4 chars.
- **Prime Directive holds.** The sampled record on disk is still the verbatim Ricos document; the HTML
  exists only on the export path.
- **DEV-11123 confirmed.** The cursor-paged pull returned 214/214 across 3 pages.

Not exercised, and still without live coverage: the new bulk **update (20)** and **delete (100)**
write paths, `memberId` write-once (DEV-11128), and the Members 403/404/428 probe (DEV-11143). All
three are Wix-as-destination or environment-dependent, so no Live Export run can reach them — they
have unit coverage only. Airtable and Notion were not re-exported post-merge; Supabase was chosen
because its clean no-op makes every count unambiguous.

## Human remainder (not automatable — do before launch)

- [ ] **OAuth connect flow in the real UI.** This audit reused a cloned connection row; nobody
      re-walked Wix's external-install flow end-to-end this run. DEV-10938 ("Wix 'Couldn't finish
      connecting'") is still open — clear it first.
- [ ] **Full dusky wizard pass** (`localhost:3030/exports`): confirm the 15 downgrade/needs-target
      notes render as the field-picker warnings above, confirm the 5 dangling FKs are droppable in
      the UI (the server rejects a save that keeps them with 422 `SYNC_DRAFT_FK_TARGET_MISSING`), and
      run the export from the UI.
- [x] **Decide the categories/tags/members question** (DEV-11115) — decided: expose them as real
      tables. Done and verified in Round 2.
- [x] **Rich text** — decided: pass through whatever the service natively provides; revisit when the
      system-wide rich-text feature lands.
- [ ] **Review the default view's editorial choices** — now built rather than proposed, so this is a
      review rather than a decision: which columns are hidden by default (`_id`, `slugs`,
      `previewTextParagraph`, `hasUnpublishedChanges`, `mostRecentContributorId`, `pricingPlanIds`,
      `media.displayed`, `media.custom`, `seoData`), the column names, and the choice to keep
      `contentId`/`editingSessionId`/`changeOrigin`/`translations` undeclared entirely.
- [ ] **Confirm read-only is the right default for the three reference tables** (DEV-11127) — Wix
      supports creating categories and tags; we lock them down because those write paths are untested.
- [ ] Add `WIX_BLOG` to the `LIVE_EXPORT_SOURCE_SERVICES` LaunchDarkly flag once the above land.

## Log

- 2026-07-29 — `/test-live-export WIX_BLOG notion,supabase,airtable` (Claude, local server) — first run
  of this audit. Seeded 213 draft posts, exported to all three destinations (213/213 published with
  zero failures on each), verified on each destination's own API, ran the CRUD + drift passes, and
  filed **DEV-11114–DEV-11124** under DEV-10932. Added evidence to two existing issues rather than
  re-filing: DEV-10556 (second-run churn — Notion + Airtable churn, Supabase clean) and DEV-11016
  (Notion duplicate create, reproduced from a second source service).
  **Gates 5 (foreign keys) and 10 (second-run no-op) fail; gate 8 passes with the DEV-11016 caveat;
  everything else passes.**
  Leftover QA debris to clean up when convenient: the abandoned Notion workbook `wkb_EPmFn9a9d3`/
  `wkb_EIPRcz3KPb` run left 213 pages in a database under the Notion page `fable_qa_acct_child`, and
  the duplicate page `3aca9426-7a71-810d-a2e1-d2448d68e3b8` is still in the audit database.
- 2026-07-29 — Round 2 (Claude) — implemented the two headline fixes (reference tables + default view)
  plus the schema, pagination and asset-extraction corrections; re-verified on an isolated
  branch-local server. See [Round 2](#round-2--fixes-implemented-and-re-verified). Connector unit
  tests 86 → 130. Gates 5 and 8 now pass; **gate 10 still fails** (DEV-10556). Filed DEV-11126–11129.
  Round 2's Airtable tables (`tblgycvicSNF49mqW` and the three reference tables in
  `appGoopxI4Px4dyuv`) are also QA debris worth deleting once reviewed.
- 2026-07-30 — Round 3, pre-launch validation (Claude) — full re-run of all three destinations against
  the Round 2 connector, to decide which DEV-10932 children were still real. **Gates 1–9, 11 and 12
  pass; only gate 10 fails.** Proved CRUD, reference-table edits, publish state and destination drift
  against the four-table shape for the first time. Closed DEV-11115–11119, DEV-11121, DEV-11122,
  DEV-11124; cancelled DEV-11120 into DEV-11047; filed DEV-11130 and DEV-11131. See
  [Round 3](#round-3--pre-launch-validation-2026-07-30).
- 2026-07-30 — Round 4, "launch laundry list" (Claude) — cleared the remaining connector-owned
  blockers under DEV-10932: DEV-11114 (Ricos→HTML on export), DEV-11128 (`memberId` write-once),
  DEV-11129 (per-operation batch sizes + bulk update/delete), DEV-11123 (real cursor paging via
  `queryDraftPosts`), and a Members-table capability probe found while re-checking the cancelled
  DEV-11130. See [Round 4](#round-4--launch-laundry-list). Connector unit tests 130 → 146; added a
  `ricos_to_html` transformer spec and a `wix-blog-posts` view-codec golden fixture.
  **Not re-run against live services** — this round is code + unit coverage. A live re-verification
  (especially the create path, which nobody has exercised since `memberId` became writable, and the
  bulk update/delete paths) is the remaining gate before flipping the LaunchDarkly flag.
- 2026-07-30 — post-merge live verification (Claude) — re-ran a single-destination export on `master`
  after Round 4 landed; confirmed the Ricos→HTML body and the cursor-paged pull on real data, with no
  regression to the Round 3 results. See [Verified live](#verified-live-post-merge-2026-07-30).
