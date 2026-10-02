# Live Export audit — GONG (source)

> Maintained by `/test-live-export`. Resumable: read this first, continue from the first unchecked gate.
> Umbrella Linear issue: **DEV-11213 — Gong in Live Export** ([MAJOR] Live Export project). All findings are sub-issues of it.

- **Last run:** 2026-10-01 — DEV-12085 re-check on the same 7 seeded calls (the Gong instance now has 3 users): GONG→SUPABASE (Users / Library Folders / Calls) and GONG→AIRTABLE + GONG→NOTION (+ Workspaces / Call Transcripts). Previous full run: 2026-08-06 morning (real-call re-run — seeding unblocked)
- **Destinations audited:** SUPABASE, AIRTABLE, NOTION (sequential, one workbook each)
- **Source connection:** Gong partner dev instance (`us02-125032`), read-only connector on branch `gong-connector-research`
- **Data (updated):** seeding unblocked 2026-08-06 (admin toggle flipped for both users). Re-run with **7 real calls + 7 transcripts** (multivoice TTS conversations from `test/call-scripts.mjs`): Users (2), Workspaces (1), Library Folders (4), Calls (7 with full AI analysis), Call Transcripts (7). Pagination (200+ records) remains untested — extend the seed set if needed.

## Table choice (Phase 1)

`Users, Workspaces, Library Folders, Calls` — maximizes what's testable pre-seed: text/boolean/date/number/url kinds, three FK shapes (self-FK on folders, cross-table folder→user, self-FK on users), and the empty-table (404-quirk) path via Calls. Transcripts/Scorecards excluded until data exists (their plan shape is identical in kind).

## Gates

- [x] **Preflight** — all three destinations, up front (server :3010 this worktree, `_spinner.env` token, `gong.env` with `userProvidedParams`-named keys, supabase pooler + airtable + notion creds). Evidence: `/tmp/preflight-{SUPABASE,AIRTABLE,NOTION}.json`.
- [x] **Plan quality** (destination-independent, judged on first destination) — all fields mapped with correct kinds (text/boolean/date/number/url/foreignKey); no spurious downgrades. The two `needs_target` notes (`Created By`→users, `Host`→users) are per-table-plan artifacts — the server binds them at draft save (verified on all three destinations). One real defect found + fixed: **DEV-11214** (see Findings). **Correction (2026-10-01):** one mapping had the right kind but lost data — Calls `Started` (and the hidden `Scheduled`) mapped to a date-only `date`, so Supabase/Airtable dropped the time from every call. It was missed because Calls was empty when the plan was judged, and the real-call re-run checked values, not column types. **DEV-12085**, fixed in the view — see *Calls date-type check (DEV-12085)*.
- [x] **Publish** — 7/7 changes on every destination, zero `failedOperations`.
- [x] **Destination verification via the destination's own API** — see per-destination sections.
- [x] **Create→export pass** — the 6 gen-2 calls were created via the ingestion API AFTER the first audit and appeared in the next run's export (7 calls on every destination). Source-side edit/delete don't exist on Gong's API (read-only); destination drift covered below.
- [x] **Drift check** (destination-side tamper → engine restores) — Supabase: deleted the "Competition" row out-of-band; `--rerun` restored it **with its Parent Folder FK re-resolved**. Evidence: `/tmp/drift-supabase.json`, workbook `wkb_EJ1RkV94NU`.
- [x] **Second-run no-op check** — **2026-10-01 re-runs: a true no-op on Supabase** (`rrn_yUJMSKfG5V`: 0 creates / updates / deletes across Users, Library Folders and Calls) **and on Airtable** (`rrn_uviEoAdq89`, all 5 tables) **and Notion** (`rrn_rh73sdsRbW`, all 5 tables). On 2026-08-06 it was NOT a no-op on any destination (Supabase 4 ops, Airtable 6, Notion 7 on unchanged data). This is the **generic republish churn, DEV-10556** — reproduced across all three destinations and consistent with every other audited source. Not filed per policy.

## Per-destination results

### SUPABASE — workbook `wkb_EJ1RkV94NU` (post-fix run; first run `wkb_w6ZTG3kWYz` caught DEV-11214)

- Tables created: `Users 3`, `Workspaces 2`, `Library Folders 2`, `Calls` (empty). 7 records published, 0 failures.
- **Real Postgres FK constraints created**: `"Parent Folder" REFERENCES "Library Folders 2"(id) ON DELETE SET NULL` (self), `"Created By" REFERENCES "Users 3"(id)`. Verified via `pg_constraint`.
- Values verified row-by-row: emails/names exact, `Active` boolean `t`, Library Folders `Updated` timestamptz correct (µs → µs) — that table's schema root is clean, so its `format: 'date-time'` reached the plan (Calls was still empty on this run, so `Started` was never type-checked — it was `date`, DEV-12085), `gong_record_id` carries the >2^53 Gong ids **as text** (no precision loss), self-FK values resolved (3 children → Public Folders uuid).
- Drift check: PASS (restore + FK re-resolution).

### AIRTABLE — workbook `wkb_noqLtx7sY3`, base `appGoopxI4Px4dyuv`

- Tables: `Users 2`, `Workspaces` (reused name slot), `Library Folders`, `Calls 2`. 7 records, 0 failures.
- FKs became `multipleRecordLinks` with correct targets: `Manager` (self on Users), `Parent Folder` (self) + `Created By` → Users, `Host` → Users. Airtable auto-created the reciprocal "From field:" mirrors (expected Airtable behavior).
- Values verified: names/links resolved (3 folders → Public Folders), `Updated` truncated µs→ms (destination precision, accepted), checkbox `Active` true.
- Calls table created with the full editorial column set (Title/Started/Duration/Direction/Host/Participants/Brief/Key Points/Topics/Trackers/Call Outcome/Gong Link as url) — awaiting data.

### AIRTABLE re-run (2026-10-01, DEV-12085) — workbook `wkb_zZC75jkRSh`, base `appAzZ2rUaajVXfkb`

- Sync `syn_zrXcbU4gNG`. Tables `Users`, `Workspaces`, `Library Folders`, `Calls`, `Call Transcripts`. First run `rrn_xpvk8Vca4N`: 22/22 published, 0 `failedOperations`. Second run `rrn_uviEoAdq89`: no-op.
- Verified with Airtable's own meta + records API against Gong's `GET /v2/calls`:
  - `Started` field type **`dateTime`** (`timeZone: utc`, 24-hour). The control `Library Folders.Updated` is also `dateTime`.
  - **7/7** call start instants exact (e.g. `2026-08-05T13:00:00-07:00` → `2026-08-05T20:00:00.000Z`), and **7/7** `Host` links resolve to the call's `primaryUserId`.
  - Title / Direction / Gong Link match on all 7 calls; `Duration (s)` matches what the connector pulled (see *Accepted downgrades / non-findings* for Gong's 1-second endpoint skew).
  - 7/7 transcripts are SubRip-shaped (longest 20,275 chars, one `multilineText` cell).
- Links: `Manager` (self), `Parent Folder` (self) + `Created By` → Users, `Host` → Users. Call Transcripts has no link to Calls — that is the known DEV-11215.
- Drift: deleted the "Probe: long audio" record out-of-band, then the re-run `rrn_N2oqGvzcpN` re-created it (1 create, 0 failures) with `Started = 2026-08-05T20:00:00.000Z` and the correct `Host`.

### NOTION — workbook `wkb_6GNSzqrVyd`

- Databases: `Users`, `Workspaces`, `Library Folders`, `Calls` under the QA parent page. 7 records, 0 failures.
- `Parent Folder` relation created + resolved on all 4 folder records.
- Values verified; `Updated` seconds truncated (`17:36:01` → `17:36:00`) — known Notion date-precision limitation, accepted.

### NOTION re-run (2026-10-01, DEV-12085) — workbook `wkb_2buKZv8Fcd`, under the QA page "Live Export Testing"

- Sync `syn_w9JHD9k9M8`. Same 5 tables as the Airtable re-run. First run `rrn_oQQCn9frM0`: 22/22 published, 0 `failedOperations`. Second run `rrn_rh73sdsRbW`: no-op.
- Verified with Notion's own API (`data_sources/{id}`, query) against Gong's `GET /v2/calls`:
  - `Started` is a `date` property, and **7/7** values keep the time of day *and* Gong's offset (`2026-07-27T09:00:00.000-07:00`).
  - **7/7** `Host` relations resolve to the call's `primaryUserId`, and 7/7 titles are exact (emoji included).
  - The 7 transcripts arrived in full despite Notion's 2,000-char rich-text segment cap: longest 20,275 chars, the same as on Airtable.
  - Relations: `Manager` (self), `Parent Folder` (self) + `Created By` → Users.
- Drift (designed behaviour, DEV-11407): one Calls page was moved to the trash out-of-band.
  - A normal run `rrn_NgBiCrHlTS` reported **No changes**. The destination pull is incremental (`Pulled 5 folders — no changes (incremental)`), so it can't see a trashed page.
  - A **full sync** (`forceFullPull`, the UI's "Run a full sync") `rrn_FKK9QlqSZW` restored it as a new page (1 change; the trashed original stays in the trash), with the correct `Started` and `Host`.
- The first 2026-10-01 attempt (`wkb_faCDBhDxFr`) failed at save with `object_not_found`, because the QA parent page wasn't shared with the integration yet. It was a setup issue, and nothing was created.

### Real-call re-run (2026-08-06 morning) — runs `wkb_dMwknjZfZ5` (Supabase), `wkb_jm6nZkxjvD` (Airtable), `wkb_deuP0mpTvy` (Notion)

- 21/21 records published on each destination, zero `failedOperations`.
- **Flattened analysis columns verified on destination APIs**: Participants/Topics/Trackers/Key Points comma-joined text, Brief prose, Transcript space-joined dialogue (after switching `arrayHandling` from `concat` → `join_comma`/`join_space` — separator gap caught on the first Supabase re-run and fixed in the view).
- **Calls `Host` FK verified on all three**: Supabase uuid FK constraint, Airtable `multipleRecordLinks`, Notion relation (1 link per row).
- Emoji/CJK/ümlaut title round-tripped intact to all destinations.
- **NEW finding → DEV-11215** (`[core]`, filed): transcripts' `callId` is both idPath and FK; the plan generator consumes it as the `gong_record_id` source-record-id column and silently drops the relation — no FK column on any destination. Linkage survives via `gong_record_id`; generic gap for any child-table-keyed-by-parent-id source.

### Calls date-type check (DEV-12085, 2026-10-01)

- **Symptom (customer report, VITL):** a Gong → Supabase export created `"Started" date`. Airtable gets a `date` field without time. Gong's full ISO-8601 start time and offset were dropped on every write. Notion is unaffected because it has no schema-level time toggle.
- **Root cause:** the Calls schema ROOT carries `x-scratch-agent-instructions`, and `metaData` carries `x-scratch-readonly`. `extractSchemaFields` keeps any object with such an annotation whole, as one opaque leaf, so the Calls table yields **no** schema fields. The plan field for `metaData.started` is a bare `{ path, type: 'unknown' }`, and the view's coarse `'date'` hint became a date-only column.
- **Fix (`[view]`):** `Started` and `Scheduled` declare `logicalType: 'datetime'` (the Stripe/Intercom/Sanity precedent). Synced values are unchanged; only the created column type changes. Users / Library Folders / Scorecards dates already kept their time (clean roots — the schema format reaches the plan).
- **Verified (unit / DDL level):** `__tests__/gong-live-export.spec.ts` asserts Started → `{ kind: 'date', includesTime: true }`, an Airtable `dateTime` field and a Postgres `"started" timestamptz` column. It also checks that every date column on every Gong table, hidden ones included, exports with its time of day.
- **Existing destination tables keep their `date` column:** re-planning adopts an existing column by kind, and both are `date`. Fix those with `ALTER TABLE … ALTER COLUMN "Started" TYPE timestamptz` (or recreate the table); the next run then rewrites every call with its real start time.
- **Live re-check: PASS (2026-10-01, GONG→SUPABASE).** Workbook `wkb_ANzlLQXjlv`, sync `syn_1CfDWsBnMB`, local server built from the fix branch. The tables were created fresh in a new schema, `gong_export`. Evidence below comes from Supabase's own catalog and SQL, plus Gong's own `GET /v2/calls`:
  - `information_schema.columns`: `"Started"` = **`timestamp with time zone`**. The `Library Folders."Updated"` control is also `timestamp with time zone`.
  - **7/7** calls: Supabase `"Started"` equals Gong `started` as an instant, e.g. `2026-07-27T09:00:00-07:00` → `2026-07-27 16:00:00+00`. The time of day and offset are kept. Before the fix this was a bare `date`.
  - `Host` is a real FK constraint to `"Users".id`, and all 7 links resolve to the call's Gong `primaryUserId`.
  - First run `rrn_diGKz90yYY`: 14/14 published, 0 `failedOperations`. Second run `rrn_yUJMSKfG5V`: no-op.
  - Drift: one `Calls` row deleted out-of-band, then the re-run `rrn_pz31eyzB3s` re-created it (1 create, 0 failures) with `Started = 2026-07-27 16:00:00+00` and the correct `Host`.
- **Live re-check: PASS (2026-10-01, GONG→AIRTABLE).** Workbook `wkb_zZC75jkRSh`: `Started` was created as **`dateTime`**, and 7/7 start instants match Gong — see *AIRTABLE re-run (2026-10-01, DEV-12085)*.
- **Live re-check: PASS (2026-10-01, GONG→NOTION).** Workbook `wkb_2buKZv8Fcd`: `Started` is a `date` property, and 7/7 values keep the time of day and Gong's offset — see *NOTION re-run (2026-10-01, DEV-12085)*. Notion has no schema-level time toggle, so the column type was never the risk there.

## Findings

| Issue | Layer | Status |
| --- | --- | --- |
| **DEV-12085** — Calls `Started`/`Scheduled` exported date-only (Postgres/Airtable `date`; time + offset dropped): the annotated Calls root and `metaData` hide `format: 'date-time'` from the plan | `[view]` | **FIXED** — `logicalType: 'datetime'`; pinned by `gong-live-export.spec.ts`; **re-verified live 2026-10-01** on Supabase (`wkb_ANzlLQXjlv`: `timestamp with time zone`) and Airtable (`wkb_zZC75jkRSh`: `dateTime`), with Notion values keeping the time too (`wkb_2buKZv8Fcd`); 7/7 start times exact on all three |
| **DEV-11215** — FK-annotated idPath field never becomes a relation column (transcripts→calls, all destinations) | `[core]` plan generator | Filed (Medium), not fixed — shared-code rule; linkage survives via `gong_record_id` |
| **DEV-11214** — FK `linkedTableId` used sanitized wsId; workspace-scoped self-FK dropped from every plan (differential: identical on all 3 destinations → upstream). Same class as DEV-11052 (Attio). | `[view]`/`[transport]` | **FIXED same night** (bare remoteId-segment tokens + `linkedTableRemoteId`), re-verified on all 3 destinations, filed Done |
| Second run not a no-op (4/6/7 ops on unchanged data, all destinations) | `[core]` generic | **DEV-10556** — known generic; evidence noted, not re-filed |

## Accepted downgrades / non-findings

- `Call Outcome: "Can't unpack this Gong object field, syncing as plain text"` — the value is a Gong object (`{id, category, name}` per docs); plain text is honest **until real data exists** to judge a `.name` pluck. Revisit post-seed (STATE.md TODO).
- Hidden columns (Workspace FK, ids, `customData`, media URLs, Interaction group) are excluded from export plans — by design; the editorial view hides plumbing.
- `needs_target` plan notes for cross-table FKs — per-table plan artifact; server binds at save (verified). Not a defect.
- Notion seconds truncation, Airtable ms truncation — destination limitations.
- **Notion drift needs a full sync (by design, DEV-11407).** Live Export polls a Notion destination incrementally, so a page trashed out-of-band is invisible to normal runs ("No changes") until the user runs a full sync. That restores it (2026-10-01: `rrn_NgBiCrHlTS` no-op → `rrn_FKK9QlqSZW` restored). Supabase and Airtable restored on a normal run. Not filed: this is the intended trade-off, and DEV-10957 (Done) covers the edit-against-archived-page path.
- **Gong's own endpoints disagree on `duration` by 1 s for some calls** (2026-10-01: 2 of 7 — `/v2/calls` 299 / 358 vs `/v2/calls/extensive` 300 / 359). The connector pulls `/v2/calls/extensive` and the destinations hold that value verbatim, so this is source-API skew, not an export defect. Verify durations against `extensive`.

## Explicitly-human remainder

1. ~~Flip the Gong admin toggle~~ DONE (2026-08-06) — calls/transcripts re-run complete. Remaining data gap: pagination (200+ calls) and scorecards-with-data (admin-UI creation).
2. One full wizard pass in local dusky (`localhost:3030/exports`): Gong credential fields (Access Key / Secret / Base URL placeholders), field-picker warnings match plan notes, run from the UI.
3. Judgment sign-off on the Calls view editorial choices once real analysis data is visible in the grid.
4. ~~Re-run GONG→SUPABASE into a fresh destination table and confirm `"Started"` is `timestamp with time zone`~~ DONE (2026-10-01): Supabase `wkb_ANzlLQXjlv`, Airtable `wkb_zZC75jkRSh` — see *Calls date-type check*.
5. ~~Share the Notion QA parent page with the "Live export testing" integration~~ DONE (2026-10-01) — the GONG→NOTION re-run passed (`wkb_2buKZv8Fcd`).

## Gate summary

| Destination | Plan | Publish | Dest-verified | Drift | 2nd-run no-op |
| --- | --- | --- | --- | --- | --- |
| SUPABASE | ✅ (post-DEV-11214; Calls `Started` → `timestamptz` re-verified 2026-10-01, DEV-12085) | ✅ 21/21; 14/14 on the 2026-10-01 re-run | ✅ incl. real FK constraints + flattened analysis text + exact call start times | ✅ (2026-10-01: deleted Calls row restored) | ✅ 2026-10-01 re-run (`rrn_yUJMSKfG5V`); ❌ DEV-10556 on 2026-08-06 |
| AIRTABLE | ✅ (Calls `Started` → `dateTime`, 2026-10-01) | ✅ 21/21; 22/22 on the 2026-10-01 re-run | ✅ links + flattened text + exact call start times | ✅ (2026-10-01: deleted Calls record restored) | ✅ 2026-10-01 re-run (`rrn_uviEoAdq89`); ❌ DEV-10556 on 2026-08-06 |
| NOTION | ✅ (`Started` values keep time + offset, 2026-10-01) | ✅ 21/21; 22/22 on the 2026-10-01 re-run | ✅ relations + flattened text + emoji title + exact call start times + full 20k-char transcripts | ✅ via full sync (2026-10-01; a normal incremental run doesn't see trashed pages — by design, DEV-11407) | ✅ 2026-10-01 re-run (`rrn_rh73sdsRbW`); ❌ DEV-10556 on 2026-08-06 |

**Not launch-ready yet** — pending the seeded-data re-run (calls/transcripts are the product's core tables) and `/review-live-export GONG SUPABASE,AIRTABLE,NOTION` returning PASS.

## Review — 2026-10-01

Verdict: **FAIL** — one real `[view]` finding (an accepted downgrade that the data no longer supports), plus doc and tracking corrections. Every destination gate was re-proved with fresh evidence.

Re-proved (reviewer's own evidence; local server on this branch; ground truth read-only from Gong `GET /v2/users` (3), `/v2/workspaces` (1), `/v2/library/folders` (4), `/v2/calls` + `POST /v2/calls/extensive` + `/v2/calls/transcript` (7 each)):

- **Preflight**: harness preflight OK on all three destinations (`wkb_hthFQ8zvUR`, `wkb_FV1jra3Xir`, `wkb_6OmRCwBFuD`; `/tmp/review-preflight-{supabase,airtable,notion}.json`).
- **Author's 2026-10-01 evidence**: all ten routine runs (`rrn_diGKz90yYY` … `rrn_FKK9QlqSZW`) re-read via `GET /routine-runs/:id?includeJobs=true`. Statuses, per-table create/update/delete counts and `failedOperations` (0) match the doc exactly.
- **Author's 2026-08-06 evidence is not reproducible**:
  - All seven workbooks (`wkb_w6ZTG3kWYz`, `wkb_EJ1RkV94NU`, `wkb_noqLtx7sY3`, `wkb_6GNSzqrVyd`, `wkb_dMwknjZfZ5`, `wkb_jm6nZkxjvD`, `wkb_deuP0mpTvy`) return 404 on this server.
  - Base `appGoopxI4Px4dyuv` returns 403, the old Supabase tables are gone, and the old Notion databases aren't visible.
  - `/tmp/drift-supabase.json` and `/tmp/preflight-{SUPABASE,AIRTABLE,NOTION}.json` don't exist.
  - The gates those ids back are re-proved below.
- **SUPABASE** (`wkb_ANzlLQXjlv`):
  - Reruns `rrn_d8b0J8j7t6` and `rrn_E0VIByGDO2`: no changes, 0 failures.
  - Catalog: `"Started"` is `timestamptz`; FKs Host→Users, Parent Folder (self), Created By→Users, Manager (self). Calls match Gong 7/7 on start instant, host and `/extensive` duration.
  - Own drift probe on different records: deleted parent folder "Public Folders" (children SET NULL), deleted call `4526754409365231659`, tampered `Direction` on `347936007639479067`. Normal run `rrn_sP80xtAaQr`: 2 creates + 4 edits, 0 failures. Parent re-created, 3 children re-linked, call back with its real start and host, value restored. Then `rrn_wqC0FrF8Ct`: no-op.
  - Fresh 5-table export `wkb_wWJSVSIVub` into schema `gong_review_1001` (adds the Workspaces + Call Transcripts tables the 2026-10-01 run skipped). `rrn_Z1vgE6HNvh` 22/22, then `rrn_WG8q6HvhOn` no-op. 7/7 transcripts are SubRip with cue count = Gong sentence count (longest 20,275 chars).
  - DEV-12085 remediation re-proved: `"Started"` ALTERed to `date` (`rrn_aQI5C0k1dv`), then ALTERed back to `timestamptz`. `rrn_oZLwHqsQES` rewrote 7/7 real start times, then `rrn_NX4IYmb5P6` no-op.
- **AIRTABLE** (`wkb_zZC75jkRSh`, base `appAzZ2rUaajVXfkb`):
  - Reruns `rrn_Iw2NYE1s7b` and `rrn_xHZWLgS9PW`: no-op.
  - Meta API: `Started` is `dateTime` (utc, 24-hour). 7/7 match on start, Host, title, duration, direction and Gong Link. 7/7 transcripts are SubRip.
  - Own drift probe: deleted user ryder@ (host of 5 calls), tampered a call title, deleted a transcript. `rrn_B2QMrhJwnJ`: 2 creates + 5 edits, 0 failures. User re-created, 5 Host links re-pointed, title and transcript restored. Then `rrn_ZxszSeddqR`: no-op.
- **NOTION** (`wkb_2buKZv8Fcd`):
  - Reruns `rrn_WtuBMmUcsr` and `rrn_9V4jWsdJn1`: no-op.
  - `data_sources` API: 7/7 `Started` keep time and `-07:00`. 7/7 Host relations and titles (emoji/CJK/ümlaut) match. Transcripts are complete (20,275 chars, 11 segments).
  - Own drift probe: tampered `Direction`, trashed folder "Win/Loss" and user curtis@ (host of 2 calls).
  - Normal run `rrn_rTf1SPqpvf`: 1 edit (value restored); the trashed pages are unseen, by design (DEV-11407).
  - `forceFullPull` run `rrn_Q5Lag1FTdJ`: 2 creates + 2 edits, 0 failures. Both pages re-created, folder re-parented, 2 hosts re-pointed. Then `rrn_lNqXMPexs0`: no-op.
- **Second-run no-op** holds everywhere above. DEV-10556 is Done (2026-08-25; canonicalizers DEV-11420, 2026-09-08), so a no-op is now required.
- **Code/unit**: `isOpaqueConnectorEnvelope` does fire on the Calls root (`x-scratch-agent-instructions`) and on `metaData`, so Calls yields zero schema fields. The other Gong roots are clean. `yarn --cwd server jest src/remote-service/connectors/library/gong --runInBand`: 26/26.
- **Duration-skew note** confirmed (299/300 and 358/359).
- **Source-side CRUD probe: not performed.**
  - Gong has no edit endpoint for any exported entity.
  - The only delete path is GDPR erasure (`POST /v2/data-privacy/erase-data-for-email-address`), which is destructive and forbidden on the source.
  - Create is call ingestion + media (4–40+ min), excluded by this review's read-only use of Gong.
  - Destination-side create/edit/delete publish paths were exercised instead. Source-delete mirroring stays untested for Gong.

Findings:

1. **`[view]` Call Outcome downgrade wrongly accepted.**
   - Audit claim: "plain text is honest until real data exists to judge a `.name` pluck."
   - Observed: 3/7 Gong calls return `content.callOutcome = {id, category, name}` (MEETING_BOOKED ×2, NOT_INTERESTED ×1). The author's own 2026-10-01 reports sampled exactly these values.
   - Supabase, Airtable and Notion all hold the raw JSON blob (differential → upstream). This also falsifies the Plan gate's "no spurious downgrades".
   - Proposed fix: point the column at `content.callOutcome.name` (precedent DEV-11018 / DEV-11027). The Linear issue is drafted but not filed.
2. **DEV-11215 was Canceled 2026-08-06** ("I can live with that"), but the Findings table (and STATE.md) say "Filed (Medium), not fixed".
   - The gap is real: Call Transcripts has no link/FK to Calls on any destination.
   - Move it to accepted gaps.
3. **Stale or dead doc text**:
   - (a) The gate lines cite the gone 2026-08-06 evidence above; repoint them to fresh evidence.
   - (b) "Publish — 7/7" is stale: the 2026-10-01 runs were 14/14 (Supabase) and 22/22 (Airtable, Notion).
   - (c) DEV-10556 is presented as open churn; it is Done.
   - (d) The closing line still waits for the seeded-data re-run (done 2026-08-06).
   - (e) "Users (2)": Gong now has 3 users.
   - (f) The 2026-08-06 "Transcript space-joined dialogue" is superseded by SubRip.
   - (g) DEV-12085 "FIXED": the fix and spec are uncommitted on this branch, and Linear is still Backlog.
4. **Linear hygiene (non-blocking)**:
   - DEV-12085 has no `live-export-qa` label and is only _related to_ DEV-11213 (not a sub-issue).
   - DEV-11213 is Done although its own launch gate (this review) hasn't passed.
   - DEV-12085's schema-layer alternative (drop `readonlyOptions` on `metaData`) would not suffice: the Calls root's agent instructions also trip the guard.

Layer attribution:

- DEV-12085 `[view]`: OK. The bug reproduced on Supabase and Airtable before the fix. The shared-code fix was weighed and declined in the issue because of its blast radius.
- DEV-11215 `[core]`: OK. The FK is declared correctly and is missing on all three destinations; there's no view workaround, and no shared code was changed in passing.
- DEV-11214 `[view]`/`[transport]`: OK. The self-FK resolves everywhere, including under the parent-delete and trash probes.
- DEV-10556 / DEV-11407: correctly cited, not re-filed.

Dedup:

- No duplicates of the known-generics list.
- DEV-12085 has a different cause from DEV-10788 / 11086 / 11091.
- No existing issue covers Call Outcome.
- The date-column re-edit loop seen while testing the remediation (7 edits every run while `"Started"` is `date`; reproduced from an Airtable source too, `wkb_nNzJCvhB5Y`) is intended: per supabase/STATE.md, "A timestamp written into a `date` column genuinely loses the time of day and still diffs". Not filed.

Human remainder confirmed outstanding:

1. Live pagination (>100 calls) and Scorecards with data.
2. Dusky wizard pass (`localhost:3030/exports`).
3. Calls view sign-off, now including:
   - the Call Outcome pluck;
   - Key Points comma-join (27/28 key points contain commas; no newline join exists);
   - transcript rows identified only by a 19-digit call id.
4. VITL: ALTER `"Started"` to `timestamptz` and rerun (re-proved to converge), then reply in Slack. Until then, every run re-edits every call.
5. Merge the DEV-12085 branch and update Linear.
6. Decide whether to keep or drop the review artifacts (schema `gong_review_1001`; workbooks `wkb_wWJSVSIVub`, `wkb_nNzJCvhB5Y`).
