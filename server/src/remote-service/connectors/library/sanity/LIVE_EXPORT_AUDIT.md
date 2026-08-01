# Live Export audit — SANITY (source)

> One doc per SOURCE service; destination-specific results live in per-destination sections.
> Gates 1–5 are destination-independent (judged once); gates 6–12 are re-proved per destination.

- Umbrella Linear issue: DEV-11160 (`Live Export QA: SANITY source`, project [MAJOR] Live Export)
- Credentials: `local/audit-creds/sanity.env` (burner account: project "Ryder playground" `hkcx2dra`, dataset `production`, Editor robot token)
- OAuth-only? no — `user_provided_params` (`apiKey`); Sanity has no third-party OAuth app model at all
- Seed script: `tools/live-export-audit/seeds/sanity/seed.mjs` (idempotent `createOrReplace`; `--delete` to clean)
- Torture tables: `fable_qa_author` ×2 (full: unicode name, slug, geopoint, nested `address` with a `zip-code` key, datetime, ref to post; one all-empty), `fable_qa_post` ×212 (torture doc: unicode/RTL/zero-width title, 2001+4001-char longText, bigInteger 2^53+1, extreme dates 0100/9999, tags arrays 0/1/4, single ref, keyed ref array, weak dangling ref, strong ref to a non-exported type, `seo` nested group with >2000-char child, Portable Text with heading/marks/link/lists/code/dangling image; one all-empty; 210 fillers for pagination), plus the deployed-Studio-schema types `author`/`category`/`post` (authored order, declared titles incl. "Featured?", SEO group)

## Gates

| #   | Gate                                                              | Status | Evidence                                                                                                                                                        |
| --- | ----------------------------------------------------------------- | :----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Preflight (server, token, creds)                                  |   ✅   | harness preflight OK for all 3 destinations 2026-08-01                                                                                                          |
| 2   | Recon: connector + View read, tables chosen                       |   ✅   | 5 tables: 2 inferred-schema torture types + 3 deployed-schema types (max type coverage incl. both schema paths)                                                 |
| 3   | Torture data seeded + read back via service API                   |   ✅   | seed.mjs read-back check (2 authors / 212 posts); GROQ verification in every spot check                                                                         |
| 4   | Plan audit: every downgraded field judged (finding or accepted)   |   ✅   | /tmp/audit-sanity-airtable-4.json, /tmp/audit-sanity-notion.json, /tmp/audit-sanity-supabase.json — see findings + accepted downgrades                          |
| 5   | FKs identified as foreignKey; links resolve on destination        |   ✅   | fixed in-audit (bare-type `linkedTableId`, ref-array codec); link targets verified on all three destinations                                                    |
| 6   | First run: publish failures = 0 or all filed                      |   ✅   | AT rrn_vQrotRomLZ 221/0 · NO rrn_fLdKag5TA7 221/0 · SB rrn_f4NKn4SLVP 221/0 (after the DEV-11161 fix; first SB attempt wkb_5ipoJrO0kj aborted at save)          |
| 7   | Destination-side spot check (≥3 records/table, via dest API)      |   ✅   | per-destination sections below (torture / all-empty / linked / legacy, field-by-field vs GROQ)                                                                  |
| 8   | CRUD pass: edit / create / delete mirrored                        |   ✅   | AT rrn_9WLUWPHi7s · NO rrn_CWDWXc1TEl · SB rrn_qUQamhjZ6D — all verified on the destination APIs                                                                |
| 9   | Pagination: 200+ record table fully synced (count matches)        |   ✅   | fable_qa_post 212/212 on all three destinations                                                                                                                 |
| 10  | Second run is a no-op                                             |   ❌   | KNOWN-GENERIC DEV-10556 — evidence recorded below, not re-filed per source                                                                                      |
| 11  | Destination drift: out-of-band delete restored (or fails loudly)  |   ✅   | AT rrn_veSqkHzp4g · NO rrn_N6FPLdJwHe · SB rrn_Wf4A4oaNbb — `fable-qa-post-filler-001` restored on all three (verified via dest APIs)                           |
| 12  | Findings filed (project + `live-export-qa` label) or queued below |   ✅   | DEV-11160 (umbrella) + DEV-11161 (released pg dest-pack bug, fixed in-branch); unreleased-connector findings fixed directly (6 fixes); known-generics evidenced |

## Destination-independent findings (plan/pull side)

### Connector bugs found and FIXED during this audit (unreleased SANITY connector — no Linear issues; they never shipped)

| #   | Layer       | Defect                                                                                                                                                                                                                                                                                                                                                                   | Fix                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | [transport] | Schema-inference sample size 100 let 210 filler docs (all edited after the torture doc) push the wide torture doc out of the most-recently-edited sampling window — its fields vanished from schema, plan, and export                                                                                                                                                    | `SANITY_SCHEMA_INFERENCE_SAMPLE_SIZE = 500` (`sanity-json-schema.ts`); deployed Studio schema remains the real fix beyond any sample                                                                                                                                                                                                                                                                                        |
| 2   | [view]      | FK `linkedTableId` was the underscore wsId (`production_author`), which matches NO consumer token (schema-builder token map, dusky/harness segment filter) — every FK silently dropped from Live Export plans. The dotted `dataset.type` form also fails (segment equality; dotted names have their own draft-save bug DEV-11071)                                        | bare type name (`author`) as `linkedTableId` — the pg-public convention; exact disambiguation stays in `linkedTableRemoteId` (`sanity-json-schema.ts` `annotateReferenceFields`)                                                                                                                                                                                                                                            |
| 3   | [view]      | Array-of-refs columns fed raw `{_type:'reference',_ref,_key}` envelopes to the sync FK phase → "Expected string or number for FK array element", whole export aborts                                                                                                                                                                                                     | Affinity-style codec: `codec.toCore` jsonpath `$[*]._ref` `arrayHandling: 'array'` + `join_comma` displayTransformer (`sanity-default-view.ts`)                                                                                                                                                                                                                                                                             |
| 4   | [transport] | Portable Text detection required EVERY array member `_type === 'block'` — idiomatic bodies mixing blocks with `code`/`image` members were not annotated, so `body` exported as raw JSON blocks joined with ", " (verified in Airtable run-4 data). Deployed-schema types dodged it only when their sampled bodies were pure blocks                                       | detection broadened: every member a typed object + ≥1 `block` member anywhere in the sample (empty arrays neutral); reference arrays still excluded (`sanity-json-schema.ts`). Verified live: Notion + Supabase `body` mappings carry the jsonpath flatten and both destinations show "Heading two Bold italic …"                                                                                                           |
| 5   | [view]      | Datetime columns carried only `type: 'date'` — no time-bearing signal (the inferred schema deliberately omits JSON-Schema `format`), so Airtable created **date-only** columns: `publishedAt` "2026-06-15T12:34:56.789Z" → "2026-06-15", time silently lost for the life of the export (Notion unaffected — its date prop keeps time). Precedents: DEV-11086/11091/11026 | `logicalType: 'datetime'` on sample-annotated datetime columns (Stripe epoch-column precedent) + new `date` annotation for bare calendar-date values so genuine date-only fields become date (not text) columns (`sanity-default-view.ts`, `sanity-json-schema.ts`). Verified live on Supabase: `"Published At" timestamptz` holding `2026-06-15 12:34:56.789+00`, `"Date Only" date`. Airtable/Notion runs predate the fix |

### Released-code finding — FILED + fixed in-branch

| Issue     | Layer       | Summary                                                                                                                                                                                                                                                                                                                                                           | Status                                                                                                                                                                                                                     |
| --------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DEV-11161 | [dest-pack] | `?` in a created column name is knex's binding placeholder — the pg DDL builder (shared POSTGRES/SUPABASE `pg-common/pg-create-schema.ts`) created `"Featured?"` as a column literally named `Featured$1`, then draft save aborted with SYNC_DRAFT_FIELD_RESOLUTION_FAILED. Supabase-only (Airtable/Notion clean → dest-pack by differential); source-independent | fixed in-branch: `escapeKnexColumnIdentifierSpecialCharacters` (DML's `\?` escape + DEV-11063 dot sentinel) applied on the DDL path; regression tests; verified live (SB run created `"Featured?" boolean`, 221 published) |

### Known-generic issues — evidence recorded, NOT re-filed (hard rule)

| Issue                                                                    | Evidence from this audit                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DEV-10556 (second run not a no-op / republish churn)                     | AT rrn_QACpHcu7qH: 218 ops on unchanged data — `category` (plain text only) churn-free; churn correlates with date/FK/array/slug-subfield columns. NO rrn_TbcOz0fUij: 221 ops — ALL tables churn incl. plain-text `category` (matches the DEV-11092 observation). SB rrn_Kl8wP3d79y: 215 ops — fable_qa_author + category churn-free, fable_qa_post 211/212 churn |
| DEV-11131 ([→AIRTABLE] empty-field read-back churn)                      | consistent with the AT churn pattern (sparse torture/filler records re-publish; the fully-dense category rows don't)                                                                                                                                                                                                                                              |
| DEV-11146 (orphaned routine run stays `running` forever; canceled/known) | rrn_taGzVlCitI (wkb_u8263kgB79) — orphaned by a dev-server hot reload mid-run, still `running`                                                                                                                                                                                                                                                                    |
| DEV-10955 (Notion 2000-char split on the edit path — Done)               | re-proven FIXED: CRUD edit rewrote `longText4001` to 4002 chars and the Notion page holds all 4002 (rrn_CWDWXc1TEl)                                                                                                                                                                                                                                               |
| DEV-10956 (multi→single collapse takes first element)                    | SB: `Co Authors` uuid column holds only `fable-qa-author-full` (first of two); legacy `post.Categories` likewise. Plan carries the narrowing warning — warned, not silent                                                                                                                                                                                         |
| (transient) scratch-git staging 500 aborts a pull                        | SB drift attempt rrn_AbIPaOkQDk failed loudly ("category: … /api/staging/job_d4ooLXiZOP/files: HTTP 500"), succeeded on retry — same family as canceled DEV-11075; not re-filed                                                                                                                                                                                   |

### Accepted downgrades (text is the honest representation)

| Field                                                    | Type                                       | Why accepted                                                                                                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `location` (geopoint)                                    | `{_type:'geopoint', lat, lng}` → JSON text | No destination geo type; JSON is honest. Candidate future View nicety: lat/lng subfield columns — not blocking                                                                                          |
| `tagsOne`/`tagsMany`/`tagsEmpty`/`tags` (string arrays)  | ", "-joined text                           | Same treatment as Wix hashtags (DEV-11120, canceled as accepted); comma-containing elements are ambiguous in the join but the raw file keeps the array verbatim                                         |
| `missingRef` (weak dangling reference)                   | `_ref` id as text                          | Target doc doesn't exist → target `_type` unresolvable → no FK annotation possible; raw id text is honest. Sanity quirk: weak refs are the only way a dangling ref can exist (strong refs 409 at write) |
| `orphanTypeRef` (strong ref to a type NOT in the export) | FK offered `needs_target`, dropped         | Correct engine behavior — the plan note tells the user to add the target table                                                                                                                          |
| `body` code-block/image text in the flattened preview    | omitted from `$[*].children[*].text`       | Preview semantics; the `portable_text_to_html` transformer (sync-editor mapping) is the full-fidelity story                                                                                             |
| Notion checkbox `null` → `false`                         | destination limitation                     | Notion checkboxes cannot be null                                                                                                                                                                        |
| Notion datetime seconds truncation                       | `12:34:56.789Z` → `12:34:00`               | documented Notion date-property behavior                                                                                                                                                                |
| `bigInteger` 2^53+1                                      | float64 on every hop                       | **Sanity itself** returns 9007199254740992 (JSON/float64 — digit-verified against the raw GROQ response); all destinations equal the source exactly → no pipeline loss to file                          |

### Sanity-as-DESTINATION note (recorded for the future)

Strong references enforce referential integrity at WRITE time (409 on dangling) — a future Sanity destination pack must publish FK targets before referrers, or write refs `_weak: true` first and strengthen after. Weak refs are the only dangling-capable form.

## Destination: AIRTABLE

- Workbook: wkb_G5ddrryzO8 · Sync: syn_lkoUAR4G6b · Report: /tmp/audit-sanity-airtable-4.json · Base appGoopxI4Px4dyuv
- Final tables: `fable_qa_author 4` (tblf2AkWs8tuAg8Bn), `fable_qa_post 4` (tblvqV3PfgiU87Ej9), `author 4` (tbluHn0vK0L7k6pJk), `category 4` (tbliff5LBgjmnnZbH), `post 4` (tbluKskykH0Dv3M4z)
- Runs: rrn_vQrotRomLZ (initial, 221/0 failed) · rrn_QACpHcu7qH (second-run check, 218 ops = DEV-10556) · rrn_9WLUWPHi7s (CRUD) · rrn_veSqkHzp4g (drift)
- Note: this run predates in-audit fixes #4/#5 — its `fable_qa_post.Body` cells hold raw JSON and its datetime columns are date-only Airtable `date` fields. Both fixes verified live on the later Notion/Supabase runs; a fresh Airtable run would create `dateTime` columns via `includesTime`.

### Destination-side verification (Airtable REST API vs GROQ)

- Counts: 2/212/2/2/3 = source ✅ (pagination 212/212)
- Torture post: unicode/RTL/zero-width/tab title verbatim ✅ · longText 2001+4001 full length ✅ · seo group → separate `Meta Title`/`Meta Description` (2100 chars intact) ✅ · numbers 0 / -273 / 0.875 / 0.1234567890123456 ✅ · extreme dates 0100-01-01 & 9999-12-31 survive ✅ (date-only — fix #5 landed after this run) · `Tags Many` `alpha, with comma, beta "quoted", gamma, δέλτα` ✅ · `Missing Ref` id-as-text ✅
- FKs: `Author` + `Co Authors` (array, both members) + `Favorite Post` link to the correct records (resolved back to `sanity_record_id`) ✅; Airtable auto-creates reciprocal link fields (`fable_qa_author 4`, `fable_qa_post 4 (2)`) — destination behavior, not ours
- All-empty records: only `sanity_record_id` populated (plus auto-reciprocal links) ✅
- `address` nested object → `Street`/`City`/`Zip-code` columns (the `zip-code` unsafe key survives) ✅
- Deployed-schema types: authored titles as column names (`Post title`, `Category title`, `Featured?`, `Word count`) ✅; legacy `post.Body` (pure-block sample) flattened to plain text even pre-fix ✅

### CRUD + drift

- CRUD rrn_9WLUWPHi7s (/tmp/crud-airtable.json): 1 create + 1 delete + 217 edits, 0 failed. Verified via REST: torture title has `[CRUD-EDIT]`, `Long Text4001` = 4002 chars ending `END-4002`, author Name edited, `fable-qa-post-crud-new` present (Count Zero 999), `fable-qa-post-filler-210` gone ✅
- Drift rrn_veSqkHzp4g (/tmp/drift-airtable.json): out-of-band row delete of `fable-qa-post-filler-001` (rec5TBmsaCKLtfFpu) → 1 create planned+executed; row recreated ("Filler post 1") ✅

## Destination: NOTION

- Workbook: wkb_F8WI8Gglo5 · Sync: syn_gN1sM0tGAs · Report: /tmp/audit-sanity-notion.json · Parent page 3a6a9426-7a71-81a3-ac37-d46a30d61191
- Databases (created 07:15Z): fable_qa_author c166e94b…, fable_qa_post 1e90a90c…, author 75e71577…, category 09db5393…, post 4e2e8a15…
- Runs: rrn_fLdKag5TA7 (initial, 221/0 failed) · rrn_TbcOz0fUij (second-run check, 221 ops = DEV-10556, every table) · rrn_CWDWXc1TEl (CRUD) · rrn_N6FPLdJwHe (drift)
- An earlier Notion attempt (wkb_u8263kgB79, 07:07Z) was killed mid-publish by a dev-server hot reload (self-inflicted: connector code edited during the run); its 5 stale databases were archived in cleanup and its orphaned run rrn_taGzVlCitI is the DEV-11146 evidence

### Destination-side verification (Notion API vs GROQ)

- Counts: 2/212/2/2/3 ✅ (pagination 212/212)
- **Body flattened to plain text** ("Heading two Bold italic linked plain with\nnewline bullet one number one") — in-audit fix #4 verified end-to-end ✅
- longText 4001 arrives FULL on create (2000-char rich_text split works on the create path) ✅
- Datetimes keep time-of-day (`2026-06-15T12:34:00+00:00` — seconds truncated, known Notion behavior); extreme dates 0100/9999 accepted, no DEV-10960 recurrence ✅
- Relations: `Author`/`Co Authors` (both members)/`Favorite Post`/legacy `Categories` resolve to the right pages ✅
- All-empty record: texts "", numbers/dates null, checkbox **false** (Notion can't null a checkbox) ✅
- unicode/emoji/RTL/newlines verbatim ✅

### CRUD + drift

- CRUD rrn_CWDWXc1TEl (/tmp/crud-notion.json): 1 create + 1 delete + 220 edits, 0 failed. Verified via Notion API: `[CRUD-EDIT]` title, `Long Text4001` = 4002 chars `END-4002` (**edit-path long-text split OK — DEV-10955 re-proven fixed**), author Name edited, crud-new present, filler-210 absent ✅
- Drift rrn_N6FPLdJwHe (/tmp/drift-notion.json): out-of-band page archive of filler-001 (3afa9426-7a71-81b6-94a1-e2ca75301ee4) → 1 create planned+executed; page present + `archived: false` after the run ✅

## Destination: SUPABASE

- Workbook: wkb_dlbuehTxuw · Sync: syn_bgNuKl50ut · Report: /tmp/audit-sanity-supabase.json · yqoxftqvixxcglgklbsw/public (transaction pooler)
- Runs: rrn_f4NKn4SLVP (initial, 221/0 failed) · rrn_Kl8wP3d79y (second-run check, 215 ops = DEV-10556) · rrn_qUQamhjZ6D (CRUD) · rrn_AbIPaOkQDk (drift attempt — FAILED LOUDLY on a transient scratch-git staging 500) · rrn_Wf4A4oaNbb (drift retry, restored)
- First attempt wkb_5ipoJrO0kj aborted at draft save on **DEV-11161** (`Featured?` → `Featured$1`); its 5 empty tables were dropped, the pg-common fix applied, and this fresh run went clean
- **Fix #5 verified live at DDL level**: `"Published At"/"Extreme Past"/"Extreme Future"/"Joined At"` = `timestamptz`, `"Date Only"` = `date`
- **DEV-11161 fix verified live**: legacy `post` table has a verbatim `"Featured?" boolean` column

### Destination-side verification (direct SQL over the pooler vs GROQ)

- Counts: 2/212/2/2/3 ✅ (pagination 212/212)
- Torture post: title verbatim ✅ · `Published At` = `2026-06-15 12:34:56.789+00` (full precision) ✅ · extreme dates `0100-01-01 00:00:00+00` / `9999-12-31 23:59:59+00` exact ✅ · `Date Only` = `2026-06-15` in a `date` column ✅ · longText 2001/4001 + meta 2100 full ✅ · body flattened plain text ✅ · tags joined ✅ · `Missing Ref` id text ✅ · numbers = source float64 values ✅
- FKs are scalar uuid columns: `Author` resolves via join to `fable-qa-author-full` ✅; `Co Authors` collapsed to FIRST member (DEV-10956, warned in plan) ; `Favorite Post` → torture post ✅; legacy `post` → author/category joins correct ✅
- All-empty records: all columns NULL except `sanity_record_id` ✅
- Deployed-schema `post`: authored column names verbatim (`Post title`, `Word count`, `Rating`, `Featured?`, `Tags`) ✅

### CRUD + drift

- CRUD rrn_qUQamhjZ6D (/tmp/crud-supabase.json): 1 create + 1 delete + 215 edits, 0 failed. Verified via SQL: `[CRUD-EDIT]` title, `Long Text4001` = 4002 `END-4002`, author Name edited, crud-new present, filler-210 absent, count stays 212 ✅
- Drift: out-of-band SQL `DELETE` of filler-001 → rrn_AbIPaOkQDk failed loudly on an unrelated transient scratch-git 500 (good failure surfacing), retry rrn_Wf4A4oaNbb re-INSERTED the row ("Filler post 1") ✅

## Cleanup performed

- Airtable base appGoopxI4Px4dyuv: the 15 throwaway tables from failed runs 1–3 cannot be deleted via the public API (no delete-table endpoint; the Airtable MCP account has no access to this base) — renamed to `zz_stale_sanity_*` for manual deletion. The verified run-4 set kept.
- Notion: the 5 stale databases from the aborted 07:07Z run (4d738b73, fd57f01d, b2425e7b, 0b97fc0f, 6e40ffd3) archived via API; the verified 07:15Z set kept.
- Supabase: the 5 empty tables from the aborted wkb_5ipoJrO0kj save dropped (`DROP TABLE … CASCADE`); the verified wkb_dlbuehTxuw set kept.
- Source restored: seed.mjs re-run (torture title/longText/author name/filler-210 back to canonical), `fable-qa-post-crud-new` deleted; GROQ read-back = canonical (212 posts, len 4001, original title/name).
- Stale local workbooks from failed runs (wkb_4b53gHeToI, wkb_KQpNoCMxNl, wkb_jh0FYQFoTw, wkb_iJiBuYMk6h, wkb_u8263kgB79, wkb_5ipoJrO0kj) left in place — local dev DB only.

## Human remainder (not automatable — do before launch)

- [ ] OAuth connect flow: **N/A** — Sanity has no third-party OAuth app model; robot tokens are the sanctioned integration auth (document as such in the connector metadata review)
- [ ] Full dusky wizard pass (`localhost:3030/exports`): credential placeholder text, field-picker warnings match the plan notes (esp. the `needs_target` FK note and the multi→single narrowing warning), run from the UI
- [ ] Sign-off on the in-audit View/schema changes (fixes #2–#5) and the shared pg-common DDL escape (DEV-11161)
- [ ] Fresh Airtable export post-fix to confirm `dateTime` column creation (the audited AT workbook predates fix #5; Supabase timestamptz already proves the mechanism)
- [ ] GitLab masked CI var `INTEGRATION_TEST_SANITY_API_KEY` (pre-existing pending step from the connector build)

## Log

- 2026-08-01 — Claude (test-live-export, sydney worktree) — Airtable runs 1–4 (3 connector bugs found+fixed: inference sample size, FK token form, ref-array codec); Airtable verified via REST API. Portable Text mixed-member detection bug found via Airtable data → fixed → Notion run verified the flatten end-to-end. Datetime time-loss found on Airtable → `logicalType: 'datetime'` + date-only annotation → verified on Supabase (timestamptz/date DDL). Supabase first attempt exposed DEV-11161 (`?` → `$1` in created column names; filed + fixed in pg-common with regression tests) → clean re-run. CRUD + drift passes verified on all three destinations via their own APIs. Known-generic churn evidence recorded (DEV-10556/11131/11146, DEV-10956 collapse, DEV-10955 re-proven fixed). Destination cleanup done; source state restored.
