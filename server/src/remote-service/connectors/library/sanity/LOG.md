# Sanity connector — activity log

Append-only journal of operations actually performed. STATE.md says _what's covered_; this says _what was done, in order_. Tags: `[Service UI]` `[Service API]` `[Scratch CLI]` `[Manual Edits]` `[Research]`.

## 2026-07-31 — step 1: skeleton + auth (backfilled times, best effort)

Product/API research (pre-build):
[19:30:00] [Research] Researched Sanity via web: Content Lake model, GROQ vs GraphQL (GraphQL is opt-in + no mutations — skip), robot-token auth (no OAuth app model, no marketplace review), technical limits (25 mutation req/s, 4 MB mutation body, 10M docs/dataset), schema deployment (`sanity schema deploy` → `_.schemas.<workspace>` / `sanity.workspace.schema` system documents, experimental)

Auth probing with the provided token:
[19:47:00] [Service API] Verified token + discovered project — `curl -H "Authorization: Bearer sk…" https://api.sanity.io/v2021-06-07/projects` → 200, project `hkcx2dra` "Ryder playground"
[19:49:00] [Service API] Listed datasets (`production`, aclMode public) and ran first GROQ query — `POST …/data/query/production` `array::unique(*[]._type)` → `[]` (empty project), 200
[19:52:00] [Service API] Attempted to seed authors/categories/posts via `POST …/data/mutate/production` → **403 `Insufficient permissions; permission "create" required`** — the token is Viewer/read-only; seeding blocked until an Editor token exists

Scaffold (code):
[19:55:00] [Research] Read CONNECTOR_GUIDE.md (full), audienceful connector as template, generic-api schema-inference helpers (reused for Sanity's sampled-document inference), coverage-template.md
[20:05:00] [Manual Edits] Scaffolded the connector: `sanity-types.ts`, `sanity-api-client.ts` (management + per-project data clients, GROQ query, mutations, retry/rate-limit), `sanity-json-schema.ts` (inference + system-field annotations), `sanity-connector.ts` (full abstract surface + registration, `visible: false`); registered in `service-constants.ts` + `library/index.ts`; added `sanityProjectId` to `DecryptedCredentials`
[20:08:00] [Scratch CLI] Verified: `yarn build` ✅ · `yarn lint` (sanity files clean) ✅ · `yarn typecheck` ✅ · unit spec `sanity-json-schema.spec.ts` 6/6 ✅
[20:12:00] [Manual Edits] Downloaded Simple Icons Sanity mark, recolored to brand `#F03E2F`, checked in as `sanity-logo.svg`. GCS upload **blocked**: read-only SA lacks `storage.objects.create` on `spv1eu-production-static` — human one-liner in STATE.md TODOs
[20:15:00] [Service API] Live integration spec `server/test/integration/sanity-connector.spec.ts` run against the real API with the audit-creds token — 5/5 passing (testConnection valid+invalid, table discovery, schema inference, pull) — auth confirmed working end-to-end through the connector code

Logo redo (per Ryder — verbatim official asset, no recolor):
[20:21:00] [Manual Edits] Replaced the recolored Simple Icons mark with Sanity's official monogram, transcribed verbatim from sanity-io/ui `packages/logos/src/sanityMonogram.tsx` (default scheme: `#FF5500` tile, `#0D0E12` glyph) → `sanity-logo.svg`; xmllint-validated. GCS upload still pending (human)

Logo upload verification + Editor token + seeding:
[20:28:00] [Service API] Ryder's upload landed at the wrong key (`connector-icons/sanity-logo.svg`) — caught via `gcloud storage ls` + CDN 404; asked for `gcloud storage mv … sanity.svg`
[20:33:00] [Service API] Verified logo live after the mv — `curl -I https://static.scratch.md/connector-icons/sanity.svg` → 200 `image/svg+xml`, CDN bytes identical to checked-in asset
[20:34:00] [Service API] Verified the new token in `audit-creds/sanity.env` is Editor — createOrReplace+delete probe transaction on `POST …/data/mutate/production` → 200
[20:35:00] [Service API] Seeded 7 torture documents (2 authors, 2 categories, 3 posts — references, Portable Text w/ marks+link, slug, geopoint, nested objects, arrays, unicode/emoji, sparse minimal doc) via one mutation transaction → 7× `create`
[20:36:00] [Service API] Re-ran the live integration spec against seeded data — 5/5 passing; table discovery found `author`/`category`/`post`, schemas inferred, all documents pulled verbatim

## 2026-07-31 — CLI harness: connect, pull, validate (Milestones 2–3)

Server consolidation (per Ryder — one server at a time, he starts it for manual testing):
[20:30:00] [Manual Edits] Killed the zombie "mumbai" dev server holding :3010 (agent-started weeks ago, outlived its session) + removed stale `spinner-redis-1`; Ryder then started scratch-git (:3100) and this worktree's server (:3010) himself and manually verified connect + pull in-app

CLI auth flow + harness:
[20:52:00] [Scratch CLI] Created workspace — `scratchmd workspaces create sanity-test` → `wkb_YMQkzvH7dZ`
[20:53:00] [Scratch CLI] Created the connection (the real product auth path) — `connections add --service SANITY --param apiKey=sk…` → `coa_uANeTAV73x`, **Health: OK**
[20:53:30] [Scratch CLI] `linked available` exposed a REAL BUG: `system.group` + `system.retention` listed as tables (internal-type filter only excluded `sanity.*`)
[20:54:00] [Scratch CLI] Learned the `linked add` syntax the hard way: repeatable `--table-id` = one remoteId segment per flag (comma-joined string → 500). Linked author/category/post
[20:55:00] [Scratch CLI] `workspaces init wkb_YMQkzvH7dZ -o /tmp/sanity-test-ws` + `linked pull <dfd> --mode full` ×3 → 7 records at `sanity/production/{type}/{slug}.json`, byte-verbatim vs the API (geopoint, nested objects, Portable Text, unicode intact)
[20:55:30] [Scratch CLI] Schema gate — `validation dry-run … enforce_schema` → `[]` on author/category/post probes incl. the sparse `minimal-post` (the only-require-`_id`/`_type` decision held)
[20:56:00] [Manual Edits] Fixed the internal-type filter (`SANITY_INTERNAL_TYPE_NAME_PREFIXES = ['sanity.', 'system.']`) in sanity-connector.ts; Ryder's watch server hot-reloaded; re-ran `linked available` → only the 3 user types listed

Edit→Push attempt (Milestone 5) — blocked on a dev-env issue, root-caused + fixed:
[21:00:00] [Manual Edits] Enabled CLI publishing — `UPDATE "User" SET settings.cliCanPublish=true` for ryder@whalesync.com (scratchpaper DB)
[21:01:00] [Manual Edits] Edited `sanity/production/author/ada-lovelace.json` — `role: "Editor" → "Editor-in-Chief"`; `files accept` OK; **`files upload` → 500** (`upload-patch init (check) failed`)
[21:05:00] [Research] Root-caused via Conductor terminal: server threw `SigningError: Cannot sign data without client_email` in `signPutUrlForPatchUpload` — the server process runs on plain user ADC, which can't V4-sign. NOT a connector bug (env gate, documented in `.env.example`). Confirmed the read-only SA key can sign but 403s on PUT; confirmed user-ADC impersonation of `cloudrun-service-account@spv1eu-test` signs successfully
[21:08:00] [Manual Edits] Added `GCS_LOCAL_SIGNING_SA=cloudrun-service-account@spv1eu-test.iam.gserviceaccount.com` to sydney `server/.env` — needs a server restart to take effect; publish retry pending

## 2026-07-31 — portable_text_to_html sync transformer (Live Export enabler)

[21:20:00] [Research] Mapped the transformer wiring: shared-types `sync-mapping.ts` (type + label + config union), server `sync-mapping.schema.ts` (zod), `transformers/index.ts` barrel, implementation mirroring `notion-to-html.transformer.ts`
[21:30:00] [Manual Edits] Built `portable-text-to-html.transformer.ts` (styles, decorator marks, link markDefs, nested lists via level-stack, escaping, custom blocks skipped) + registered `portable_text_to_html` in all three shared-types registries + zod schema. Schema builder: sample-based Portable Text detection → `x-scratch-connector-data-type: portableText` + `x-scratch-suggested-transformer`
[21:33:00] [Scratch CLI] Verified: `yarn build` ✅ · new specs 16/16 ✅ (8 transformer + 8 schema incl. annotation test) · full `src/sync` suite 951/951 ✅ · eslint/prettier/tsc clean

## 2026-07-31 — default view + Portable Text grid preview

[21:45:00] [Research] Confirmed the display-engine gap: `join_space`/`concat` enforce one-match-per-top-level-element (right for Notion spans, wrong for PT blocks→spans where elements contribute 0..n matches) — `$[*].children[*].text` would fail closed to raw JSON
[21:55:00] [Manual Edits] Added generic `join_matches_space` array-handling mode: shared-types `JSONPathArrayHandling` + `apply-jsonpath` reducer + `apply-display` branch (array input, all-string matches, no per-element count rule — documented for nested structures), desktop `resolve-pack` delimiter, server zod enum + jsonpath transformer select option
[22:00:00] [Manual Edits] Built `sanity-default-view.ts` + wired `buildDefaultView` override: title first, slug second (subfield `current` selected), user fields in schema order, system fields last+hidden; PT columns → `type: string`, `logicalType: richtext`, readonly, jsonpath preview; references collapse to `_ref` subfield; sample-detected `datetime` annotation (format is deliberately NOT in the inferred TypeBox schema — validation would enforce it) → date columns
[22:05:00] [Scratch CLI] Verified: server 962/962 (incl. 4 new view specs) ✅ · desktop 496/496 ✅ · root `yarn typecheck` ✅ (after fixing a TObject cast in the integration spec) · prettier/eslint clean · live integration spec re-run 5/5 ✅

Ryder's in-app review + banner groups for nested objects:
[22:15:00] [Service UI] Ryder eyeballed the view in the desktop app: good, except FK columns (known TODO), rich-text preview (accepted), and `seo` rendering as one raw-object column
[22:25:00] [Manual Edits] Banner-group expansion in `sanity-default-view.ts`: plain user objects (object schema, no `_type`/`_ref` marker — the discriminator vs slug/reference/geopoint) expand into dotted-path child columns under a group named after the field (`seo` → "Seo": Meta Title / Meta Description; `address` → "Address"). 12/12 unit tests, lint/tsc clean
[22:28:00] [Scratch CLI] Re-pulled all 3 tables (his watch server hot-reloaded the builder) and confirmed the regenerated `post` `views/default.json`: Seo group with both children, PT displayTransformer on body, date-typed columns, system fields hidden. NOTE: group children come out in schema (alphabetical) order — Meta Description before Meta Title; the customer's Studio field order needs the deployed-schema enrichment (TODO)

## 2026-07-31 — full write CRUD + foreign keys (Milestones 5 + 6)

Isolation + the surprise finding:
[22:50:00] [Research] `sanity-test` workspace.log revealed Ryder's desktop app had the SAME workspace open (his sorts/pulls in the log) — the CLI hang + vanished edit were two drivers sharing one clone. Created isolated workbook `sanity-crud` (`wkb_zMSyPgyeKF` / `coa_KfrZlcxoZZ`) for write tests
[22:52:00] [Service API] Discovered the original edit→push had ALREADY landed live (Ada `role: Editor-in-Chief`, `_updatedAt 04:48Z`): Ryder's app re-anchored my stranded accepted patch and he published it — also proving the `GCS_LOCAL_SIGNING_SA` fix loaded via watch restart

CRUD ladder (all in sanity-crud, all service-API-verified):
[22:56:00] [Manual Edits] Edit→Push: ada-lovelace `role → "Countess of Computing"`, `active → false` → accept/upload/publish → verified live, untouched fields intact (sparse patch)
[22:58:00] [Manual Edits] New→Push: created `grace-hopper.json` (no `_id`) → publish → created in Sanity, server `_id` `PnRpwD…` flowed back into the local file
[23:00:00] [Manual Edits] Delete→Push: removed grace-hopper.json → publish → `count(*) == 0` in Sanity (idempotent delete path)

Foreign keys:
[23:05:00] [Manual Edits] Implemented FK annotation: sample scan (`collectReferenceFieldSampleRefIds`) + one GROQ `*[_id in $ids]{_id,_type}` target-type resolution in `fetchJsonTableSpec`; `x-scratch-foreign-key` on the `_ref` LEAF (single + array-member); view copies `foreignKey` onto reference cols. 15/15 unit tests, lint/tsc clean
[23:08:00] [Scratch CLI] Re-pulled post → live schema.json carries both FKs (`author`→production_author single, `categories[]`→production_category multi)
[23:10:00] [Manual Edits] FK WRITE (canonical move parent→parent): hello-sanity `author._ref` ada→alan → accept/upload/publish → verified via GROQ join `author->name` == "Alan Turing"

"Groups not visible in app" investigation — NOT a UI regression:
[22:40:00] [Research] Traced the desktop view pipeline: banner-group rendering (glide `group` + `groupHeaderHeight`) landed 2026-05-08 and is in every current build. Root cause: Ryder's own workbook (`wkb_12UFQTbkTx`) was pulled during manual testing BEFORE the connector had `buildDefaultView`, so its folders had no `views/default.json` → the app used its _Generated_ fallback view (which auto-expands nested objects into dotted columns but has no groups) — matching everything he saw
[22:45:00] [Scratch CLI] Re-pulled his workbook's 3 real tables; verified in the bare repo (`coa_CzIektNyqS.git` `main:.scratch/production/post/views/default.json`): Seo banner group + body preview present, committed 21:58. His workbook also still carries `system.group`/`system.retention` folders linked before the filter fix — flagged for him to remove

## 2026-07-31 — deployed-schema enrichment (authored order, titles, declared FK targets)

Probing how to fetch `_.schemas.*` system documents:
[22:15:00] [Service API] Probed 4 fetch mechanisms against hkcx2dra/production: `*[_type == "sanity.workspace.schema"]` → EMPTY (wrong type name!); `*[_id in path("_.**")]` → returns system docs (groups, retention) fine at the default perspective; `GET /data/doc/{dataset}/{id}` → works, missing ids come back under `omitted` with reason `existence`
[22:25:00] [Service API] Deployed a REAL Studio schema headlessly: throwaway Studio in `/tmp/sanity-studio` (npm install sanity react react-dom styled-components; `sanity.cli.ts` + `sanity.config.ts` with author/category/post in deliberate non-alphabetical authored order + human titles), then `SANITY_AUTH_TOKEN=<Editor robot token> npx sanity schema deploy` → "Deployed 1/1 schemas" on the FIRST try — the Editor role CAN deploy schemas, no Developer token needed
[22:30:00] [Service API] Inspected the live deployed doc: `_id: _.schemas.default`, **`_type: "system.schema"`** (docs say `sanity.workspace.schema` — wrong live), `workspace: {name, title}`, `version: 2025-05-01`, and `schema` = a JSON **string** serializing the type array (`{name, type, title?, fields[]}` per type; fields carry `to:` targets, `of:` array members, nested `fields`, plus `validation`/editor options to ignore). Confirmed `*[_id in path("_.schemas.**")]` returns it at `perspective=published` via the connector's exact POST query path. QUIRK: Sanity omits any title equal to its default humanization (declared "Meta Title" on `metaTitle` is absent)
[22:35:00] [Manual Edits] Built the enrichment: new `sanity-deployed-schema.ts` (pure parser → per-type authored field order, titles, single-target reference targets incl. array-member refs — multi-target `to:[a,b]` stays out —, nested-object sub-field order/titles; default workspace wins, malformed payloads skipped); `sanity-api-client.ts` `fetchDeployedWorkspaceSchemaDocuments` (id-path GROQ via the ordinary query pipeline); `fetchJsonTableSpec` fetches once per spec build (failure → WSLogger.warn + inference-only), deployed FK targets replace the sampling lookup for covered fields (sampling remains the fallback), enrichment reorders schema properties to authored order (legacy inferred-only + system fields keep their place after) and stamps declared titles on the non-enforced `title` keyword; nested objects get the same treatment so banner-group children follow authored order; `sanity-default-view.ts` prefers `title` over humanization for column/group/child names
[22:42:00] [Scratch CLI] Gates: sanity jest 31/31 ✅ (new sanity-deployed-schema.spec 7 tests + 5 enrichment schema tests + 4 enrichment view tests, incl. authored-beats-alphabetical, seo children metaTitle→metaDescription, FK-from-`to:`-without-sampling, legacy-fields-survive, no-deployed-schema = exact baseline) · eslint ✅ · prettier ✅ · `tsc --noEmit -p tsconfig.build.json` ✅
[22:56:00] [Scratch CLI] LIVE verification (connector level): live integration spec 5/5 ✅ with the deployed schema now present, plus a temporary integration probe that ran the real `fetchJsonTableSpec`+`buildSanityDefaultView` against live `post` → property order `title, slug, publishedAt, wordCount, rating, featured, tags, author, categories, seo, body` (authored, not alphabetical), titles `Post title`/`Published at`/`Word count`/`Featured?`/`SEO settings`, seo banner-group children `metaTitle → metaDescription` (probe deleted after passing). `sanity schema list` confirms exactly one deployed schema (`_.schemas.default`)
[23:00:00] [Research] CLI re-pull of `wkb_zMSyPgyeKF` BLOCKED: the sydney watch server wedged — child pid on :3010 accepted TCP but answered nothing (event loop idle, 1.6s CPU since ~22:37), and nest watch stopped recompiling entirely (dist mtimes frozen despite three content changes; Redis/Postgres/scratch-git all healthy, no pg locks). Not allowed to restart servers — killed my hung `scratchmd pull` processes and left the re-pull as the one pending verification step (exact command recorded in STATE.md)

## 2026-07-31 — integration spec: CRUD round-trip coverage (Milestone 10 progress)

Probing the write-error surface before coding:
[22:45:00] [Service API] Confirmed live seeded content intact (author-ada, post-hello, 6 types incl. system.\*) via direct GROQ; verified the deleted-schema/system docs still excluded from listTables
[22:48:00] [Service API] Probed what genuinely errors on create: `_id` containing spaces → 400 `mutationError`/`validationError` ("Invalid document ID … invalid element") — picked as the create error-handling case (a real server-side rejection, not a forced one). Nothing persisted (count 0)

Spec expansion (`server/test/integration/sanity-connector.spec.ts`, 5 → 11 tests):
[22:55:00] [Manual Edits] Added `SanityConnector — CRUD round-trips` describe (hermetic `scratch-it-<Date.now()>` prefixed `_id`s on the EXISTING author/post types — no `_type`-list pollution; afterAll bulk-delete via the direct mutation API in reverse creation order so the referencing post dies with its authors; missing-id deletes are no-ops → idempotent teardown). Every write verified INDEPENDENTLY via direct axios GROQ queries against `data/query/production` (helpers hardcode v2025-02-19 — deliberately not imported from the connector client). 6 new tests: (1) create carrying every writable field shape (string, int+float numbers, boolean, ISO datetime, slug object, email/url, nested object, string array, geopoint) → returned doc has server `_id` + GROQ read-back verbatim per-field; (2) sparse `changedFields` patch (top-level `name` + nested leaf `address.city`) → changed paths new, `address.street` and all siblings intact; (3) post with single ref, `_key`ed array-of-refs (`contributors`), Portable Text body (block/span/marks/markDefs link) → verbatim read-back + GROQ join `author->name`/`contributors[]->name` resolves server-side; (4) deleteRecords → GROQ count 0, re-delete resolves (idempotent); (5) updateRecords with no `_id` rejects (client-side SanityError); (6) createRecords with the illegal-`_id` doc rejects + GROQ count 0
[23:05:00] [Scratch CLI] Gates all green: live suite 11/11 ✅ (20.7s, first run — zero flakes); post-run GROQ `count(*[_id match "scratch-it*"])` → 0 (teardown verified); `npx eslint --fix` clean ✅ · `npx prettier --check` ✅ · `npx tsc --noEmit` (full server tsconfig incl. test/) ✅
[23:08:00] [Manual Edits] Docs: `SANITY_API_KEY` placeholder + comment block added to `server/.env.integration.example`; STATE.md Integration-tests section (publish CRUD ✅, self-provisioning hermetic state model) + Milestone 10 row updated (CI masked var remains the pending human step). No connector bugs found — the whole write surface behaved as documented

## 2026-08-01 — overnight run: incremental pull, review round 1

Incremental pull (backfilled — implemented before the deployed-schema work but the doc entry was missed; the adversarial review caught the omission):
[22:32:00] [Manual Edits] Implemented incremental pull: `sanity-incremental.ts` (dateTime-vs-dateTime GROQ clause, 60s skew), `fetchDocumentsPageOrderedById` modifiedSince param, `incrementalPullSupport → SUPPORTED`, `metadata.incrementalPull: true`
[22:34:00] [Scratch CLI] Live-verified: bootstrap `pull --mode incremental` (full), direct API patch of author-alan (`role: Codebreaker`), second incremental pull picked it up; `DataFolder.lastIncrementalPullAt` stamped
[22:36:00] [Manual Edits] Array-of-refs FK write: hello-sanity categories [tech] → [history, tech] via CLI publish; GROQ join `categories[]->title` = ["History","Technology"]
[23:55:00] [Manual Edits] Dev server wedged >1h (nest watch stopped recompiling); killed + restarted from sydney in background per overnight authorization

Adversarial review round 1 (clean subagent, /connector-build-review SANITY):
[23:18:13] [Research] Verdict FAIL — zero code findings (every ✅ re-proven live incl. full CRUD, FK write both directions, incremental ×2, deployed-schema enrichment re-pull); three DOC findings: incremental sections/TODO/IP-cell said "not implemented" for a shipped+verified feature; stale TODO contradictions; prettier on STATE/LOG. All fixed in this pass; review round 2 queued

Review round 2 → the one real code bug, fixed:
[23:28:47] [Manual Edits] Review round 2 verdict FAIL: 1 MAJOR CODE bug (confirmed live by the reviewer) — sparse-diff wholesale `set` on unsafe-keyed nested objects (e.g. `address."zip-code"`) replaced the whole subtree with the SPARSE diff, deleting untouched siblings. Fixed: `flattenChangedFieldsToSanityAttributePaths` now takes the full record content and wholesale-sets the FULL current subtree; `updateRecords` passes `files[i]`. +2 unit tests (reviewer's exact zip-code scenario + safe-key recursion unchanged). Also fixed the round's MINOR doc drift (categories FK write ✅, array-refs Edit→Push ✅, stale seeding sentence, milestone 4/7 blocker notes, deployed-schema re-pull note)

Review round 3 — PASS:
[23:46:38] [Research] Fresh clean reviewer round 3: **VERDICT PASS**, zero code findings. Independently re-proved: 11/11 integration, byte-verbatim pull, enforce_schema [] ×7, edit/new/delete push, FK single + array writes, incremental ×2, deployed-schema order/titles/FKs, hermetic teardown. Two MINOR under-claim doc-sync cells fixed in this pass (prettier's table padding had defeated the round-2 string replaces — silent no-op). Reviewer also documented a CROSS-CONNECTOR platform behavior: locally deleting a JSON key publishes as a no-op (diff-utils doesn't track key removals by design — set null/"" to clear); not a Sanity defect

## 2026-08-01 — Live Export audit (/test-live-export SANITY AIRTABLE,NOTION,SUPABASE)

[07:04:00] [Scratch CLI] AIRTABLE runs 1–4 (wkb*G5ddrryzO8 final): three connector bugs found+fixed along the way — (1) [transport] inference sample 100→500 (`SANITY_SCHEMA_INFERENCE_SAMPLE_SIZE`; 210 fillers pushed the torture doc out of the sampling window, its fields vanished from the plan), (2) [view] FK `linkedTableId` underscore wsId → bare type name (underscore/dotted forms match no consumer token; every FK silently dropped), (3) [view] array-of-refs codec `toCore` jsonpath `$[*].\_ref`array + join_comma display (raw`{\_ref}`envelopes aborted the FK phase). Final run 221 published / 0 failed
[07:10:00] [Service API] Airtable REST verification vs GROQ: counts 2/212/2/2/3, torture values verbatim (unicode title, 2001/4001/2100 texts, extreme dates, tags join), FK links + array links + reciprocal resolve, all-empty record clean,`zip-code`nested key survives. Two data findings:`body`= raw JSON (bug 4 below) and datetimes date-only (bug 5 below). bigInteger 2^53+1: Sanity itself stores …992 (float64) — digit-verified raw; destination equals source, no pipeline loss
[07:14:00] [Manual Edits] Bug 4 [transport]: Portable Text detection required every member`\_type=='block'`— mixed`code`/`image`members (idiomatic PT) defeated it,`body`exported as ", "-joined JSON. Broadened: every member a typed object + ≥1 block anywhere, empty arrays neutral, ref-arrays still excluded (+2 unit tests). NOTE: editing connector code mid-run killed the first Notion run (wkb_u8263kgB79; its orphaned rrn_taGzVlCitI still`running`= DEV-11146 evidence) — lesson: never edit server code while a harness run is in flight
[07:21:00] [Scratch CLI] NOTION run (wkb_F8WI8Gglo5): 221/0 failed; body flatten verified end-to-end; 4001-char create intact; relations resolve; extreme dates OK. Second run 221 ops (DEV-10556 — Notion churns every table)
[07:30:00] [Manual Edits] Bug 5 [view]: datetime columns had no time-bearing signal → Airtable created date-only columns (publishedAt lost 12:34:56.789). Fix:`logicalType: 'datetime'`(Stripe precedent) + new`date` annotation for bare calendar dates (`sanity-default-view.ts`, `sanity-json-schema.ts`, +2 tests)
[07:35:00] [Service API] SUPABASE first attempt (wkb_5ipoJrO0kj) aborted at draft save: deployed title "Featured?" → knex binding substitution created column `Featured$1`→ SYNC_DRAFT_FIELD_RESOLUTION_FAILED. Filed DEV-11161 ([dest-pack], pg-common — Supabase-only by differential) and fixed in-branch:`escapeKnexColumnIdentifierSpecialCharacters`on the DDL path + regression tests (94 pg-common tests green)
[07:40:00] [Scratch CLI] SUPABASE clean run (wkb_dlbuehTxuw): 221/0 failed; SQL verification —`"Featured?" boolean`verbatim,`"Published At" timestamptz`full precision`12:34:56.789+00`, `"Date Only" date`, body flattened, FK uuid joins correct, `Co Authors` first-member collapse (DEV-10956, warned). Second run 215 ops (DEV-10556)
[07:50:00] [Service API] CRUD pass ×3 (source mutations: 2 edits incl. 4002-char longText, 1 create, 1 delete): AT rrn_9WLUWPHi7s, NO rrn_CWDWXc1TEl (4002-char EDIT intact — DEV-10955 re-proven fixed), SB rrn_qUQamhjZ6D — all verified on destination APIs. Drift ×3 (out-of-band delete/archive of filler-001): AT rrn_veSqkHzp4g restored, NO rrn_N6FPLdJwHe restored (unarchived), SB rrn_AbIPaOkQDk failed loudly on a transient scratch-git 500 then rrn_Wf4A4oaNbb re-inserted
[08:00:00] [Manual Edits] Close-out: LIVE_EXPORT_AUDIT.md written (gates, per-destination evidence, accepted downgrades, human remainder); umbrella DEV-11160 created; destination cleanup (Airtable stale tables renamed zz_stale_sanity\*\* — API can't delete tables; Notion stale DBs archived; Supabase empty tables dropped); source re-seeded to canonical
