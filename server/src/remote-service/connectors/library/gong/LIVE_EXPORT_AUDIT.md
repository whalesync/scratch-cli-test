# Live Export audit — GONG (source)

> Maintained by `/test-live-export`. Resumable: read this first, continue from the first unchecked gate.
> Umbrella Linear issue: **DEV-11213 — Gong in Live Export** ([MAJOR] Live Export project). All findings are sub-issues of it.

- **Last run:** 2026-08-06 morning (real-call re-run — seeding unblocked)
- **Destinations audited:** SUPABASE, AIRTABLE, NOTION (sequential, one workbook each)
- **Source connection:** Gong partner dev instance (`us02-125032`), read-only connector on branch `gong-connector-research`
- **Data (updated):** seeding unblocked 2026-08-06 (admin toggle flipped for both users). Re-run with **7 real calls + 7 transcripts** (multivoice TTS conversations from `test/call-scripts.mjs`): Users (2), Workspaces (1), Library Folders (4), Calls (7 with full AI analysis), Call Transcripts (7). Pagination (200+ records) remains untested — extend the seed set if needed.

## Table choice (Phase 1)

`Users, Workspaces, Library Folders, Calls` — maximizes what's testable pre-seed: text/boolean/date/number/url kinds, three FK shapes (self-FK on folders, cross-table folder→user, self-FK on users), and the empty-table (404-quirk) path via Calls. Transcripts/Scorecards excluded until data exists (their plan shape is identical in kind).

## Gates

- [x] **Preflight** — all three destinations, up front (server :3010 this worktree, `_spinner.env` token, `gong.env` with `userProvidedParams`-named keys, supabase pooler + airtable + notion creds). Evidence: `/tmp/preflight-{SUPABASE,AIRTABLE,NOTION}.json`.
- [x] **Plan quality** (destination-independent, judged on first destination) — all fields mapped with correct kinds (text/boolean/date/number/url/foreignKey); no spurious downgrades. The two `needs_target` notes (`Created By`→users, `Host`→users) are per-table-plan artifacts — the server binds them at draft save (verified on all three destinations). One real defect found + fixed: **DEV-11214** (see Findings).
- [x] **Publish** — 7/7 changes on every destination, zero `failedOperations`.
- [x] **Destination verification via the destination's own API** — see per-destination sections.
- [x] **Create→export pass** — the 6 gen-2 calls were created via the ingestion API AFTER the first audit and appeared in the next run's export (7 calls on every destination). Source-side edit/delete don't exist on Gong's API (read-only); destination drift covered below.
- [x] **Drift check** (destination-side tamper → engine restores) — Supabase: deleted the "Competition" row out-of-band; `--rerun` restored it **with its Parent Folder FK re-resolved**. Evidence: `/tmp/drift-supabase.json`, workbook `wkb_EJ1RkV94NU`.
- [x] **Second-run no-op check** — NOT a no-op on any destination (Supabase 4 ops, Airtable 6, Notion 7 on unchanged data). This is the **generic republish churn, DEV-10556** — reproduced across all three destinations and consistent with every other audited source. Not filed per policy.

## Per-destination results

### SUPABASE — workbook `wkb_EJ1RkV94NU` (post-fix run; first run `wkb_w6ZTG3kWYz` caught DEV-11214)

- Tables created: `Users 3`, `Workspaces 2`, `Library Folders 2`, `Calls` (empty). 7 records published, 0 failures.
- **Real Postgres FK constraints created**: `"Parent Folder" REFERENCES "Library Folders 2"(id) ON DELETE SET NULL` (self), `"Created By" REFERENCES "Users 3"(id)`. Verified via `pg_constraint`.
- Values verified row-by-row: emails/names exact, `Active` boolean `t`, `Updated` timestamptz correct (µs → µs), `gong_record_id` carries the >2^53 Gong ids **as text** (no precision loss), self-FK values resolved (3 children → Public Folders uuid).
- Drift check: PASS (restore + FK re-resolution).

### AIRTABLE — workbook `wkb_noqLtx7sY3`, base `appGoopxI4Px4dyuv`

- Tables: `Users 2`, `Workspaces` (reused name slot), `Library Folders`, `Calls 2`. 7 records, 0 failures.
- FKs became `multipleRecordLinks` with correct targets: `Manager` (self on Users), `Parent Folder` (self) + `Created By` → Users, `Host` → Users. Airtable auto-created the reciprocal "From field:" mirrors (expected Airtable behavior).
- Values verified: names/links resolved (3 folders → Public Folders), `Updated` truncated µs→ms (destination precision, accepted), checkbox `Active` true.
- Calls table created with the full editorial column set (Title/Started/Duration/Direction/Host/Participants/Brief/Key Points/Topics/Trackers/Call Outcome/Gong Link as url) — awaiting data.

### NOTION — workbook `wkb_6GNSzqrVyd`

- Databases: `Users`, `Workspaces`, `Library Folders`, `Calls` under the QA parent page. 7 records, 0 failures.
- `Parent Folder` relation created + resolved on all 4 folder records.
- Values verified; `Updated` seconds truncated (`17:36:01` → `17:36:00`) — known Notion date-precision limitation, accepted.

### Real-call re-run (2026-08-06 morning) — runs `wkb_dMwknjZfZ5` (Supabase), `wkb_jm6nZkxjvD` (Airtable), `wkb_deuP0mpTvy` (Notion)

- 21/21 records published on each destination, zero `failedOperations`.
- **Flattened analysis columns verified on destination APIs**: Participants/Topics/Trackers/Key Points comma-joined text, Brief prose, Transcript space-joined dialogue (after switching `arrayHandling` from `concat` → `join_comma`/`join_space` — separator gap caught on the first Supabase re-run and fixed in the view).
- **Calls `Host` FK verified on all three**: Supabase uuid FK constraint, Airtable `multipleRecordLinks`, Notion relation (1 link per row).
- Emoji/CJK/ümlaut title round-tripped intact to all destinations.
- **NEW finding → DEV-11215** (`[core]`, filed): transcripts' `callId` is both idPath and FK; the plan generator consumes it as the `gong_record_id` source-record-id column and silently drops the relation — no FK column on any destination. Linkage survives via `gong_record_id`; generic gap for any child-table-keyed-by-parent-id source.

## Findings

| Issue | Layer | Status |
| --- | --- | --- |
| **DEV-11215** — FK-annotated idPath field never becomes a relation column (transcripts→calls, all destinations) | `[core]` plan generator | Filed (Medium), not fixed — shared-code rule; linkage survives via `gong_record_id` |
| **DEV-11214** — FK `linkedTableId` used sanitized wsId; workspace-scoped self-FK dropped from every plan (differential: identical on all 3 destinations → upstream). Same class as DEV-11052 (Attio). | `[view]`/`[transport]` | **FIXED same night** (bare remoteId-segment tokens + `linkedTableRemoteId`), re-verified on all 3 destinations, filed Done |
| Second run not a no-op (4/6/7 ops on unchanged data, all destinations) | `[core]` generic | **DEV-10556** — known generic; evidence noted, not re-filed |

## Accepted downgrades / non-findings

- `Call Outcome: "Can't unpack this Gong object field, syncing as plain text"` — the value is a Gong object (`{id, category, name}` per docs); plain text is honest **until real data exists** to judge a `.name` pluck. Revisit post-seed (STATE.md TODO).
- Hidden columns (Workspace FK, ids, `customData`, media URLs, Interaction group) are excluded from export plans — by design; the editorial view hides plumbing.
- `needs_target` plan notes for cross-table FKs — per-table plan artifact; server binds at save (verified). Not a defect.
- Notion seconds truncation, Airtable ms truncation — destination limitations.

## Explicitly-human remainder

1. ~~Flip the Gong admin toggle~~ DONE (2026-08-06) — calls/transcripts re-run complete. Remaining data gap: pagination (200+ calls) and scorecards-with-data (admin-UI creation).
2. One full wizard pass in local dusky (`localhost:3030/exports`): Gong credential fields (Access Key / Secret / Base URL placeholders), field-picker warnings match plan notes, run from the UI.
3. Judgment sign-off on the Calls view editorial choices once real analysis data is visible in the grid.

## Gate summary

| Destination | Plan | Publish | Dest-verified | Drift | 2nd-run no-op |
| --- | --- | --- | --- | --- | --- |
| SUPABASE | ✅ (post-DEV-11214) | ✅ 21/21 | ✅ incl. real FK constraints + flattened analysis text | ✅ | ❌ DEV-10556 |
| AIRTABLE | ✅ | ✅ 21/21 | ✅ links + flattened text | — (not run) | ❌ DEV-10556 |
| NOTION | ✅ | ✅ 21/21 | ✅ relations + flattened text + emoji title | — (not run) | ❌ DEV-10556 |

**Not launch-ready yet** — pending the seeded-data re-run (calls/transcripts are the product's core tables) and `/review-live-export GONG SUPABASE,AIRTABLE,NOTION` returning PASS.
