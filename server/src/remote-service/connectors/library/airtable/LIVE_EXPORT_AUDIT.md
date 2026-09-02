# Live Export audit — AIRTABLE (source)

- Umbrella Linear issue: ⚠ not yet filed (`Live Export QA: AIRTABLE source`, project [MAJOR] Live Export) — the local
  `linear` CLI token is read-only; bodies are queued under Findings below.
- Credentials: `local/audit-creds/airtable.env` (`apiKey=…`, plus `AIRTABLE_SEED_BASE_ID=<base the key can see>`).
  Burner base: "Blog Posts - Rob" `appIOZD3KYGS2VpDE` (2026-09-01 round); `appGoopxI4Px4dyuv` (2026-08-05 round).
- OAuth-only? no (personal access token via `userProvidedParams`).
- Seed script: `tools/live-export-audit/seeds/airtable/seed.mjs` (idempotent; creates tables if missing, wipes + re-seeds
  records) · CRUD pass: `tools/live-export-audit/seeds/airtable/crud-pass.mjs`.
- Torture tables:
  - `fable_qa_at_invoices` ×213 — singleLineText / multilineText (2001 + 4001 chars) / richText (heading, bold, italic,
    link, list, code) / currency (−1234.5) / number precision 0 (0, 2^53−1) / number precision 8 / percent / checkbox /
    date (2026-12-31, 0100-01-01) / dateTime UTC (…04:30:15Z, 9999-12-31T23:59:59Z) / singleSelect incl. "Paid, with
    comma" / multipleSelects incl. "has, comma" + "γάμμα" / multipleRecordLinks → contacts (2 links + 1 link) and →
    `fable_qa_at_hidden` (table deliberately NOT exported) / url with quotes / phoneNumber / unicode+RTL+HTML-entity
    name / an all-empty record / 210 fillers (pagination).
  - `fable_qa_at_contacts` ×3 — text, email, checkbox (one unchecked), inverse link field to invoices.
  - `fable_qa_at_hidden` ×2 — link target that is never exported.

## Gates

| # | Gate | Status | Evidence |
|---|---|---|---|
| 1 | Preflight (server, token, creds) | ✅ | 2026-09-01 preflight wkb_Ejm0QuhT4T (plan-only); worktree server on :3010 |
| 2 | Recon: connector + View read, tables chosen | ✅ | `airtable-default-view.ts` TYPE_MAP, `airtable-json-schema.ts`; invoices + contacts chosen for type coverage + FK both directions; hidden left out on purpose |
| 3 | Torture data seeded + read back via service API | ✅ | `seed.mjs` → `{"fable_qa_at_invoices":213,"fable_qa_at_contacts":3,"fable_qa_at_hidden":2}` read-back OK |
| 4 | Plan audit: every downgraded field judged | ✅ | report `audit-airtable-postgres.json` (scratchpad); see Accepted downgrades |
| 5 | FKs identified as foreignKey; links resolve on destination | ✅ | `Contact`/`Hidden Ref`/inverse link all `foreignKey`; Postgres got real `REFERENCES … ON DELETE SET NULL` constraints; Hidden Ref correctly dropped |
| 6 | First run: publish failures = 0 or all filed | ✅ POSTGRES | rrn_J74MgTfHy9: 216 creates, `failedOperations: []` |
| 7 | Destination-side spot check (≥3 records/table) | ✅ POSTGRES | psql on `audit_dest`: torture, all-empty, long-4001, filler-001 + all 3 contacts, field-by-field (below) |
| 8 | CRUD pass: edit / create / delete mirrored | ✅ POSTGRES | rrn_o4vlTTbjGN: 1 create, 1 delete, edits verified via psql |
| 9 | Pagination: 200+ record table fully synced | ✅ POSTGRES | 213/213 invoices on Postgres after every run |
| 10 | Second run is a no-op | ❌ POSTGRES | rrn_zC3szsaMjk 212 edits; rrn_iydAgAp9in 211 edits — exactly the records with a `Due` date. Finding F1 |
| 11 | Destination drift: out-of-band delete restored | ✅ POSTGRES | deleted "Filler invoice 005" row via psql → rrn_zVvlecT0Zh re-created it (new uuid, same `airtable_record_id`), count back to 213 |
| 12 | Findings filed or queued below | ⚠ queued | Linear token is read-only — F1 queued with full body |

## Destination: GOOGLE_SHEETS (2026-08-05)

> Earlier round, seeded in base `appGoopxI4Px4dyuv`. Not re-run on 2026-09-01.

Workbook wkb_H7FZD4vFpN (dest conn coa_Oh343fds0I cloned from coa_S8WUAP6AI4; sentinel "new spreadsheet"
parent). Report /tmp/audit-airtable-gsheets.json.

- **First run: 216/216 published, `failedOperations: []`.** `Hidden Ref` FK correctly dropped
  (target table not in export); `Contact` created as single-valued FK per the sheets capability
  (`supportsManyToManyForeignKeys: false`) and narrowed to the first link — accepted (DEV-10956 family).
- **Verified via Sheets API** (torture invoice, field-by-field): every scalar typed (currency −1234.5,
  qty 0, precision 0.12345678, percent 0.875, checkbox native true), date/dateTime as serials in
  formatted columns (incl. extreme serials), richText arrives as its markdown source text (honest for a
  text destination), select value with comma intact, multiselect comma-joined (comma-in-element ambiguity
  is the documented lossy case), unicode/zero-width intact, links resolved to destination `scr_` ids,
  injected `airtable_record_id` populated.
- **Second run: only 23 ops of churn** (vs 215/246 for the Sanity/Pipedrive rounds) — useful DEV-10556
  triage datapoint: churn scales with source-side value-shape instability, not with the sheets
  destination per se. The residual 23 likely = multiselect/link/'' classes; not chased per policy.

## Destination: POSTGRES (2026-09-01)

- Workbook: wkb_1toKLoHtt9 · Sync: syn_4UI5tPuI3L · source conn coa_pRBkE3HBkt · dest conn coa_L7GzZTzVl8
  (local docker Postgres, db `audit_dest`, schema `public`) · Report: scratchpad `audit-airtable-postgres.json`
- Runs: rrn_J74MgTfHy9 (initial, 216 creates) · rrn_zC3szsaMjk (second-run check, 212 edits) ·
  rrn_o4vlTTbjGN (CRUD replay: 1 create / 211 edits / 1 delete) · rrn_iydAgAp9in (steady state after CRUD, 211
  edits) · rrn_zVvlecT0Zh (drift restore: 1 create / 210 edits)
- Branch context: DEV-11420 worktree — Airtable + Postgres/Supabase `resolveFieldValueCanonicalizer` registered;
  `ENABLE_NOTION_FIELD_VALUE_CANONICALIZERS` evaluated **true** for the acting user (usr_nVsmQ01Rjg) via PostHog
  local evaluation with the server's keys, so the Postgres canonicalizers were live for every sync below.

### Created schema (verified via `information_schema`)

| Airtable field | Plan kind | Postgres column | Verdict |
|---|---|---|---|
| Name (singleLineText) | text, primary | `text` | ✅ |
| Notes (multilineText) | text | `text` | ✅ 2001/4001 chars intact, no cap |
| Rich (richText) | longText | `text` | ✅ Airtable markdown source (`**bold** _italic_`, list, code) — honest for SQL |
| Amount (currency) | number | `double precision` | accepted (see A3) |
| Qty (number, precision 0) | number | `double precision` | ✅ 0, 2002, 2^53−1 exact |
| Precise (number, precision 8) | number | `double precision` | ✅ 0.12345678 |
| Ratio (percent) | number | `double precision` | ✅ 0.875 (raw fraction, as Airtable stores it) |
| Paid (checkbox) | boolean | `boolean` | ✅ true; unchecked → NULL (A5) |
| Due (date) | date | `date` | ✅ value; ❌ round-trip (F1) |
| Created At (dateTime) | date (includesTime) | `timestamp with time zone` | ✅ seconds kept; 9999-12-31T23:59:59Z intact |
| Status (singleSelect) | text | `text` | ✅ "Paid, with comma" intact (A2) |
| Tags (multipleSelects) | text (downgraded) | `text` | comma-joined "alpha, has, comma, γάμμα" (A1) |
| Contact (multipleRecordLinks) | foreignKey | `uuid REFERENCES fable_qa_at_contacts(id) ON DELETE SET NULL` | ✅ relation; [alice, carol] → alice (A4) |
| Hidden Ref (→ unexported table) | foreignKey, dropped | — | ✅ correctly dropped with plan note |
| Site (url) | url | `text` | ✅ `?a=1&b="q"` intact |
| Phone (phoneNumber) | text | `text` | ✅ |
| createdTime (readonly) | date | `timestamp with time zone` | ✅ |
| (injected) airtable_record_id | text, isSourceRecordId | `text` | ✅ populated, survives drift restore |
| contacts.fable_qa_at_invoices (inverse link) | foreignKey | `uuid REFERENCES fable_qa_at_invoices(id) ON DELETE SET NULL` | ✅ Bob → Long-4001, Alice/Carol → Torture |

Spot checks (psql, `row_to_json`): torture row — unicode/RTL/HTML-entity name, quotes in url, −1234.5, 0,
0.12345678, 0.875, true, 2026-12-31, 2026-08-05T04:30:15+00:00, select with comma, all verbatim. All-empty
row — every non-injected column NULL. Long-4001 row — 4001 chars, Qty 9007199254740991, Due 0100-01-01,
Created At 9999-12-31T23:59:59+00:00, Tags "beta", Contact → Bob. CRUD: Filler 002 Qty 1→2002, Status
Sent→Draft, Notes set; Torture Notes → 2001-char edited text, Amount → −99.5, Tags → "beta"; "CRUD created
invoice 202609012234" present with numbers/boolean/select/phone; "Filler invoice 210" gone; count 213.

### Second-run churn — isolated to the `date` column

- Run 2 churned 212 of 213 invoices and 0 of 3 contacts. The one invoice that did not churn is the all-empty
  record (no `Due`). Contacts (text, email, boolean, FK, timestamptz) are clean.
- After the CRUD pass the steady-state run churned 211 = 213 − all-empty − the CRUD-created invoice, which
  has `double precision` numbers, boolean, select, comma-joined multiselect and phone but **no `Due`**. So the
  NUMERIC (15-sig-digit) and TIMESTAMP (ms-instant) canonicalizers, plus structural text/boolean compares,
  all converge; only the `date` column does not.
- Root cause (on disk, workbook file `public/fable_qa_at_invoices/4e5440bd-….json`): source `"Due":
  "2026-05-01"`, destination pull stores `"Due": "2026-05-01T07:00:00.000Z"` (and `2026-12-31T08:00:00.000Z`
  for the December value — PDT vs PST). `node-postgres` parses the `date` OID 1082 into a JS `Date` at **local
  midnight** and the connector stores its ISO rendering, so the value depends on the server's timezone
  (`America/Vancouver` here). `isoInstantTruncatedTo('millisecond')` then compares 00:00Z vs 07:00Z → not
  equal → rewrite, every run. On a UTC server the rendering is `…T00:00:00.000Z` and the canonicalizer would
  converge, which is why this never shows up in prod-shaped runs and why the GOOGLE_SHEETS round saw only
  23 ops of churn.

### Findings

| Issue | Layer | Summary | Status |
|---|---|---|---|
| F1 ⚠ not yet filed | transport (Postgres/Supabase pull, `pg-common`) | `date` columns pull as server-local midnight → TZ-dependent value on disk; every dated record re-publishes each run | queued |

**F1 — proposed Linear body**

Title: `[AIRTABLE→POSTGRES][transport] Postgres date columns pull as server-local midnight (T07:00Z on a PDT server) — TZ-shifted value on disk and every dated record re-publishes on every run`

Layer: `[transport]` on the Postgres/Supabase connectors' pull (shared `pg-common`). Fix most likely in
`server/src/remote-service/connectors/library/pg-common/knex-pg-client.ts` (register a pass-through type
parser for OID 1082 so `date` stays a `YYYY-MM-DD` string — same reasoning as the DEV-10777 note there about
NUMERIC; check the server's own Knex usage before changing the process-global parser) plus
`pg-type-mapping.ts:108-118` (`date` → `format: 'date'`, and a day-granular canonicalizer in
`pg-field-value-canonicalizer.ts` instead of the millisecond instant one). Existing workbooks with pg `date`
columns will see a one-time value change on their next pull.

Evidence: workbook wkb_1toKLoHtt9, sync syn_4UI5tPuI3L, runs rrn_zC3szsaMjk (212 edits on unchanged data) and
rrn_iydAgAp9in (211). Source file `Blog Posts - Rob/fable_qa_at_invoices/filler-invoice-001.json` has
`"Due": "2026-05-01"`; destination file `public/fable_qa_at_invoices/4e5440bd-ec5c-46e5-9fb9-3f8fc4db5a9a.json`
has `"Due": "2026-05-01T07:00:00.000Z"`; the December torture value is `2026-12-31T08:00:00.000Z` (DST
proves the local-time parse). Postgres itself holds the correct `2026-05-01`. Differential: the churn is
confined to the one column typed `date`; `timestamptz`, `double precision`, `boolean`, `text`, `uuid` FK
columns all converge with the DEV-11420 canonicalizers on. Supabase shares `pg-common`, so DEV-11099 and
DEV-11074 (both closed as duplicates of the generic churn) are likely this same bug wherever the table had a
`date` column.

Priority: Medium here (churn only — Postgres itself holds the right date), but the same bug is **High** when
Postgres is the *source*: the shifted value is exported verbatim and Airtable creates a dateTime showing 07:00/08:00
(and `0100-01-01T08:12:28.000Z` from the LMT offset). See `library/postgres/LIVE_EXPORT_AUDIT.md` F1 (same defect,
file once and cite both) and F2 there for the sibling naive-`timestamp` bug. Umbrella: `Live Export QA: AIRTABLE
source` (to create).

Observation, not filed: the harness's per-table plan notes report `Contact` / the inverse link as
`needs_target … isn't in this plan` even though the sibling table is exported in the same run; the saved
draft resolved both to real FKs, so this is the per-folder `plan-from-folder` call seeing one table at a
time, not a product defect.

### Accepted downgrades (not bugs — text is the honest representation)

| # | Field | Type | Why accepted |
|---|---|---|---|
| A1 | Tags | multipleSelects → `text`, comma-joined | Airtable View declares multipleSelects as `object` (no multi-select View type) — already raised and **canceled** as DEV-10961; comma-in-element ambiguity is the documented lossy case. Postgres could take `text[]`, but that is the DEV-10961 decision, not a new finding |
| A2 | Status | singleSelect → `text` | Postgres creates `select` as `text` with no enum anyway (`pg-create-schema.ts`); nothing lost |
| A3 | Amount / Ratio | currency / percent → `double precision` | View declares them plain `number` (DEV-10961, canceled); values exact at the tested precision |
| A4 | Contact | multi-link → single `uuid` FK, first element kept | Postgres has no many-to-many (`supportsManyToManyForeignKeys: false`); the plan warns; DEV-10956 family |
| A5 | Paid / Vip | unchecked checkbox → NULL | Airtable omits false checkboxes from the API payload; Airtable canonicalizer treats absent ≡ false ≡ null |
| A6 | Rich | richText → `text` holding Airtable markdown | Honest for a SQL destination; Airtable itself rewrites `*italic*` to `_italic_` and appends a newline |
| A7 | Qty | number → `double precision` | Airtable numbers are floats; 2^53−1 survives; beyond that Airtable itself is lossy |

## Human remainder (not automatable — do before launch)

- [ ] OAuth connect flow in real UI — n/a (PAT), but check the API-key placeholder/help text in the wizard
- [ ] Full dusky wizard pass (`localhost:3030/exports`): field-picker warnings should show the `Tags` downgrade,
      the `Hidden Ref` needs-target note and the multi→single `Contact` warning; run from the UI
- [ ] File F1 (shared with the Postgres audit's F1) and the umbrella issue in Linear with a write-scope token; decide
      whether DEV-10961 stays canceled now that Postgres can create `text[]`
- [ ] Sign-off that the `date` fix belongs in `pg-common` (pass-through OID 1082 parser) rather than a
      day-granular canonicalizer only

## Log

- 2026-08-05 — Claude (Google Sheets destination shakedown) — doc created; GOOGLE_SHEETS section.
- 2026-09-01 — Claude Fable 5.1 (`/test-live-export airtable postgres`, DEV-11420 worktree) — seeded the torture
  set into `appIOZD3KYGS2VpDE` (seed.mjs now honours `AIRTABLE_SEED_BASE_ID` from env or the creds file), added
  `crud-pass.mjs`, ran gates 1–12 against POSTGRES with the field-value canonicalizers on; isolated the
  second-run churn to the pg `date` column (F1); queued F1 for filing.
