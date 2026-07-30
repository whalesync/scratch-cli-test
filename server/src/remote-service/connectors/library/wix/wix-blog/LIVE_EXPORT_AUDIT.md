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

## Gates

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

| Change | Wix id | What was changed |
|---|---|---|
| edit (long text) | `f2842f0a-1df7-4883-be83-54400c25eeab` (`fable_qa 03 longtext`) | body rewritten to a 4 312-char paragraph; excerpt → `CRUD-EDITED excerpt — 🥺 日本語 "quoted" line1\nline2` |
| edit (scalars) | `a733bd6a-6014-41bb-a479-8f6294c0d841` (`fable_qa 09 flags`) | excerpt, `featured: true → false`, `commentingEnabled: false → true` |
| create | `9c3e699b-f7cf-4d08-bff9-a42356a70cce` (`fable_qa 13 crud created`) | new draft post |
| delete | `329959ba-ee14-4245-88bb-5c0afe449d31` (`fable_qa 11 dangling fk`) | hard-deleted (`permanent: true`) |

| Destination | Run | Publish counts | Verified on the destination's own API |
|---|---|---|---|
| Supabase | `rrn_nGeKPTwu4P` | **1 create / 2 edits / 1 delete** — exactly the change set | 213 rows; `fable_qa 13 crud created` present; `fable_qa 11 dangling fk` gone; `richContent` length 4 486; edited excerpt intact **including the embedded newline** |
| Airtable | `rrn_Qu1GT8EZ86` | 1 create / **212** edits / 1 delete (2 real edits + 210 records of DEV-10556 churn) | 213 records; create present; delete gone; `richContent` length 4 486; edited excerpts applied |
| Notion | `rrn_Q25ij2hpDh` | counters unreliable — see below | **214** pages (should be 213); create present (**twice**); delete gone; edits applied (`richContent` length 4 486, newline preserved) |

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
on folder `dfd_RCbjeebyaa` — so Wix source deletes *are* detected (via the full scan) and edits are not
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

| Destination | Out-of-band action | Restore run | Result |
|---|---|---|---|
| Supabase | `DELETE FROM "Blog Posts" WHERE title = 'fable_qa bulk 0100'` (212 rows left) | `rrn_g09vm7JLHY` | **1 create / 0 edits / 0 deletes** → row back, new `id` `da4a1032-47e7-4c3b-b8fe-c027e44c5c3f`, total 213 ✅ |
| Airtable | `DELETE /v0/appGoopxI4Px4dyuv/tbl9ywCw4yA6KlJdo/recR1TkhZmQbUClme` | `rrn_nofjKwKoxQ` | **1 create** (+212 churn edits) → record back, total 213 ✅ |
| Notion | `PATCH /v1/pages/3aca9426-7a71-8119-9b88-f1a9b2903c82 {archived: true}` | `rrn_4IWvhW0JPl` | **1 create / 212 edits / 0 deletes**, `failedCount: 0` → page back ✅ |

Worth noting: because the source record still exists, "restore" here means **re-create with a new
destination id**, not un-archive. That is the correct non-destructive outcome, but it does mean a
destination-side delete silently loses any destination-only state on that row.

## Findings

All filed as children of DEV-10932, project `[MAJOR] Live Export`, label `live-export-qa`.
**Most are now fixed — see [Round 2](#round-2--fixes-implemented-and-re-verified).**

| Issue | Layer | Summary | Priority |
|---|---|---|---|
| [DEV-11114](https://linear.app/whalesync/issue/DEV-11114) | view | `richContent` (the post body) exports as raw Ricos JSON on every destination; the tested Ricos→HTML/Markdown converters are instantiated and never called | Urgent |
| [DEV-11115](https://linear.app/whalesync/issue/DEV-11115) | transport | 4 of 5 FK targets name tables the connector never exposes → categories, tags, author and pricing plans are silently dropped from every export | High |
| [DEV-11116](https://linear.app/whalesync/issue/DEV-11116) | transport | the `relatedPostIds` self-FK never resolves: `linkedTableId: 'wix_blog'` can't match the folder's `remoteId` token `wix-blog`, and `unresolvedLinkedTableRemoteId` is plumbed but never consulted | High |
| [DEV-11117](https://linear.app/whalesync/issue/DEV-11117) | transport | 6 schema fields the DraftPost API never returns (`wordCount`, `lastPublishedDate`, `slug`, `url`, `heroImage`, `translationId`) → permanently empty columns, and hero-image asset extraction can never fire | Medium |
| [DEV-11118](https://linear.app/whalesync/issue/DEV-11118) | transport | real DraftPost fields absent from the schema (`editedDate`, `_createdDate`, `slugs`, `hasUnpublishedChanges`, `contentId`, `changeOrigin`, `mostRecentContributorId`, `previewTextParagraph`, `translations`) land on disk but can't be exported | Medium |
| [DEV-11119](https://linear.app/whalesync/issue/DEV-11119) | view | `firstPublishedDate`/`lastPublishedDate` export as text, not date columns, despite `format: 'date-time'` | Medium |
| [DEV-11120](https://linear.app/whalesync/issue/DEV-11120) | view | `hashtags` downgrades to a `", "`-joined string — ambiguous for elements that contain commas | Medium |
| [DEV-11121](https://linear.app/whalesync/issue/DEV-11121) | view | 32 plan columns: nested objects duplicated as parent **and** children, with meaningless leaf names (`nodes`, `metadata`, `tags`, `settings`, `wixMedia`, `displayed`, `custom`) | Medium |
| [DEV-11122](https://linear.app/whalesync/issue/DEV-11122) | view | the featured image exports as an unusable `wix:image://v1/…` URI instead of an `https://static.wixstatic.com/media/…` URL | Medium |
| [DEV-11123](https://linear.app/whalesync/issue/DEV-11123) | transport | offset pagination passes no `sort`, so Wix's default `EDITING_DATE_DESC` can skip or duplicate records when posts change during a multi-page pull | Medium |
| [DEV-11124](https://linear.app/whalesync/issue/DEV-11124) | transformer | `html-to-ricos` emits `link.target: '_blank'`; Wix's API rejects it (`enum must be in [SELF, BLANK, PARENT, TOP]`) | Low |
| [DEV-10556](https://linear.app/whalesync/issue/DEV-10556) | core | (existing) second run republishes all 213 records on Notion + Airtable, clean no-op on Supabase — evidence commented, **not** filed per-source | — |

Five of these (DEV-11114, 11119, 11120, 11121, 11122) are the same root cause — **Wix Blog has no
default view** — and all land in one new `wix-blog-default-view.ts`.

### Accepted downgrades

Not bugs — plain text is the honest representation, and no plausible inner value exists to pluck.

| Field | Type | Why accepted |
|---|---|---|
| `seoData`, `seoData.tags`, `seoData.settings` | object / array / unknown | Wix's SEO tag array is an arbitrary head-tag AST (`{type, children, props}`); there is no single scalar worth plucking and no destination type that fits. Text is honest. Its *duplication* across three columns is the real defect (DEV-11106). |
| `media`, `media.wixMedia` | object / unknown | The container itself is genuinely opaque; the actionable part is the image URI inside it, filed as DEV-11108. |
| `richContent.metadata` | unknown | Wix-internal document metadata (`version`, `createdTimestamp`, an all-zero `id`). Nothing a user wants; should simply be hidden. |
| `status` | string | A closed enum (`DRAFT`/`UNPUBLISHED`/`PUBLISHED`/`SCHEDULED`) that *could* be a select, but `TablePropertyType` has no select member, so text is the best currently-expressible mapping. |
| `language` | string | BCP-47 tag; text is correct. (Wix silently ignored a `language: 'fr'` write on a single-language site — a Wix behaviour, not ours.) |

## Out-of-scope observations (Wix as a *destination* / general connector, not Live Export source)

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

| | Round 1 (audit) | Round 2 |
|---|---|---|
| Tables exposed | 1 | **4** |
| Plan columns on Blog Posts | 32 | **19** |
| Non-`mapped` plan notes | **15** | **0** |
| Dropped foreign keys | **5** | **0** |
| Categories / Tags / Author on the destination | absent | real Airtable `multipleRecordLinks` |
| Related posts (self-relation) | absent | self-referential links |
| Cover image | `wix:image://v1/9a4116_…` | `https://static.wixstatic.com/media/9a4116_…` (`url`) |
| Timestamps | `singleLineText`, mostly empty | `dateTime` with real values |
| Post body | `singleLineText`, stored twice per record | `multilineText`, once |
| Publish failures | 0 | 0 (221 records) |
| Connector unit tests | 86 | **130** |

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

### New follow-ups

| Issue | Summary |
|---|---|
| [DEV-11126](https://linear.app/whalesync/issue/DEV-11126) | Implement incremental pull — `editedDate` is now declared + annotated, and the same endpoint switch fixes DEV-11123 properly |
| [DEV-11127](https://linear.app/whalesync/issue/DEV-11127) | Make Categories/Tags writable (all three reference tables are read-only for now) |
| [DEV-11128](https://linear.app/whalesync/issue/DEV-11128) | Creating a post is impossible — Wix requires `memberId` on create, our schema marks it readonly |
| [DEV-11129](https://linear.app/whalesync/issue/DEV-11129) | `getBatchSize()` is 1 and the comments wrongly claim Wix has no bulk endpoints |

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
