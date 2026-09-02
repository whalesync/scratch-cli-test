# Live Export audit — POSTGRES (source)

- Umbrella Linear issue: ⚠ not yet filed (`Live Export QA: POSTGRES source`, project [MAJOR] Live Export) — the local
  `linear` CLI token is read-only; bodies are queued under Findings below.
- Credentials: `local/audit-creds/postgres.env` (`connectionString=…` → local docker Postgres, db `audit_dest`, schema
  `public`; the same database doubles as the destination for the Airtable-source audit, different table names).
- OAuth-only? no.
- Seed script: `tools/live-export-audit/seeds/postgres/seed.mjs` (drops + recreates, deterministic ids) · CRUD pass:
  `tools/live-export-audit/seeds/postgres/crud-pass.mjs`.
- Torture tables:
  - `fable_qa_pg_invoices` ×213 — text / varchar(20) / char(5) (bpchar padding) / integer / bigint (2^53+1 and
    int8 min) / numeric(18,6) / double precision (0.1+0.2, −0.0) / real (1e30) / boolean / date (2026-12-31,
    0100-01-01) / timestamp without tz (μs precision, 9999-12-31 23:59:59) / timestamptz (+05:30 offset,
    0001-01-01Z) / text[] (0, 1, 4 elements incl. "has, comma" and `"quoted"`) / integer[] / boolean[] / jsonb (object,
    empty array) / FK → contacts / FK → `fable_qa_pg_hidden` (never exported) / '' empty strings / an all-null row /
    markdown-with-code-block + 2001-char and 4001-char text / 210 fillers (pagination) / `updated_at`.
  - `fable_qa_pg_contacts` ×3 — text, varchar, boolean (true/false/null), `favorite_invoice_id` FK back to invoices.
  - `fable_qa_pg_hidden` ×2 — link target that is never exported.

## Gates

| # | Gate | Status | Evidence |
|---|---|---|---|
| 1 | Preflight (server, token, creds) | ✅ | 2026-09-01 preflight wkb_qL1K2Mv6yI (plan-only); worktree server on :3010 |
| 2 | Recon: connector + View read, tables chosen | ✅ | `pg-type-mapping.ts`, `pg-default-view.ts`, `pg-incremental.ts`, `airtable-create-schema.ts`; invoices + contacts (FK both directions), hidden left out on purpose |
| 3 | Torture data seeded + read back via service API | ✅ | `seed.mjs` → `{"fable_qa_pg_invoices":213,"fable_qa_pg_contacts":3,"fable_qa_pg_hidden":2}` |
| 4 | Plan audit: every downgraded field judged | ✅ | report `audit-postgres-airtable.json` (scratchpad); see Accepted downgrades + F3 |
| 5 | FKs identified as foreignKey; links resolve on destination | ✅ | `contact_id`, `hidden_id`, `favorite_invoice_id` all `foreignKey`; Airtable `multipleRecordLinks` created and populated; `hidden_id` correctly dropped |
| 6 | First run: publish failures = 0 or all filed | ✅ AIRTABLE | rrn_h7D9EcxFug: 216 creates, `failedOperations: []` |
| 7 | Destination-side spot check (≥3 records/table) | ✅ AIRTABLE | Airtable REST: torture, all-empty, long-4001, filler-001 + all 3 contacts (below) |
| 8 | CRUD pass: edit / create / delete mirrored | ✅ AIRTABLE | rrn_Nv8exXMy4B: 1 create / 2 edits / 1 delete, verified via Airtable REST |
| 9 | Pagination: 200+ record table fully synced | ✅ AIRTABLE | 213/213 invoices on Airtable (paged count) |
| 10 | Second run is a no-op | ✅ AIRTABLE | rrn_DIWZLS1Uyy "No changes"; rrn_oCaJrbLyCu (after CRUD) "No changes" — with the DEV-11420 Airtable canonicalizers on |
| 11 | Destination drift: out-of-band delete restored | ✅ AIRTABLE | deleted "Filler invoice 005" via Airtable REST → rrn_PrkFndWPZn published exactly 1 create, record back with same `postgres_record_id` |
| 12 | Findings filed or queued below | ⚠ queued | Linear token is read-only — F1/F2 queued with full bodies, F3 queued as evidence on DEV-10795 |

Pull-side note: incremental pull needs a user-declared `modifiedAtField` (`pg-incremental.ts`); the harness runs full
pulls, so the `updated_at` column was only exercised as a plain timestamptz value.

## Destination: AIRTABLE (2026-09-01)

- Workbook: wkb_0EOrtJnfeI · Sync: syn_1u12HmE0J2 · source conn coa_wy0AOwoaKR · dest conn coa_ZleOkCAUG6 ·
  Airtable base `appIOZD3KYGS2VpDE` ("Blog Posts - Rob"), created tables `fable_qa_pg_invoices` tbl8fh53Pz339i5mI and
  `fable_qa_pg_contacts` tblilmDs6jreF2jAo · Report: scratchpad `audit-postgres-airtable.json`
- Runs: rrn_h7D9EcxFug (initial, 216 creates) · rrn_DIWZLS1Uyy (second-run check, no-op) · rrn_Nv8exXMy4B (CRUD
  replay) · rrn_oCaJrbLyCu (steady state after CRUD, no-op) · rrn_PrkFndWPZn (drift restore, 1 create)
- Branch context: DEV-11420 worktree — Airtable `resolveFieldValueCanonicalizer` registered;
  `ENABLE_NOTION_FIELD_VALUE_CANONICALIZERS` evaluated **true** for the acting user (usr_nVsmQ01Rjg). The no-op second
  runs are the proof the Airtable canonicalizers work: the torture set has `''` strings, `[]` arrays, `false`
  checkboxes and `0.30000000000000004`, all of which Airtable reads back as absent / `0.3`, and none churned.

### Created schema (verified via Airtable meta API)

| Postgres column | pg type | Plan kind | Airtable field | Verdict |
|---|---|---|---|---|
| name | text | text, primary | multilineText | ✅ (multilineText for all text is the DEV-11147 decision) |
| notes | text | text | multilineText | ✅ 2001/4001 chars + markdown/code block intact |
| short_code | varchar(20) | text | multilineText | ✅ `SC-"q",c` intact; `''` → absent on Airtable, no churn |
| fixed_code | char(5) | text | multilineText | ✅ `"ab   "` padded — Postgres semantics, honest |
| qty | integer | number | number (precision 2) | ✅ 0, −7, 2002 |
| big_qty | bigint | text (NUMERIC_STRING) | multilineText | accepted A1 — `9007199254740993` and int8 min exact as text |
| amount | numeric(18,6) | text (NUMERIC_STRING) | multilineText | accepted A1 — `"-1234567.123456"`, `"1.250000"` |
| ratio | double precision | number | number | ✅ 0.30000000000000004 → Airtable 0.3, canonicalizer converges |
| approx | real | number | number | ✅ 3.14159, 1e+30 |
| paid | boolean | boolean | checkbox | ✅ true; false/null → absent, no churn |
| due | date | date (includesTime!) | **dateTime** | ❌ F1 — pulled as local midnight, so a date-only column becomes a dateTime showing 07:00/08:00 |
| created_at | timestamp (no tz) | date | dateTime | ❌ F2 — pulled as local wall time → shifted +7h; 9999-12-31 → year +010000 |
| shipped_at | timestamptz | date | dateTime (tz utc) | ✅ `+05:30` value lands as the right instant `…T23:00:15.987Z`; ms kept |
| status | text | text | multilineText | ✅ "Paid, with comma" |
| tags / scores / flags | text[] / int[] / bool[] | text (downgraded "Can't unpack") | multilineText | F3 — comma-joined `alpha, has, comma, "quoted", γάμμα`; `[]` → absent |
| meta | jsonb | text (downgraded) | multilineText | accepted A2 — JSON text, key order re-serialised |
| contact_id | uuid FK | foreignKey | multipleRecordLinks → contacts | ✅ Alice / Bob resolved to `rec…` ids |
| hidden_id | uuid FK → unexported | foreignKey, dropped | — | ✅ correctly dropped with plan note |
| site | text | text | multilineText | ✅ url with quotes intact |
| updated_at | timestamptz | date | dateTime | ✅ |
| (injected) postgres_record_id | — | text, isSourceRecordId | multilineText | ✅ populated, survives drift restore |
| contacts.favorite_invoice_id | uuid FK | foreignKey | multipleRecordLinks → invoices | ✅ Alice/Carol → Torture, Bob → Long-4001 |
| (Airtable-made) `fable_qa_pg_contacts`, `fable_qa_pg_invoices` | — | — | inverse multipleRecordLinks | Airtable auto-creates the inverse of every link field; not ours, harmless |

Spot checks (Airtable REST, record ids recnyZdY4wZYeanEo / recXHTHAEaOKJVl1R / recna65ymdQEbqx0F / reczFrYDN5Pc23OJB):
torture — unicode/RTL/tab name, quotes in varchar and url, bigint and numeric as exact text, 0, 3.14159, checkbox
true, timestamptz instant correct, select-ish text with comma, JSON text, link to Alice; all-empty — only Name,
`postgres_record_id` and `Updated At` present; long-4001 — 4001 chars, int8 min, `0.000001`, 1e+30, `"     "` padded
char, link to Bob, empty arrays absent; filler-001 — `Big Qty "1000"`, `Amount "1.250000"`, Qty 1, Ratio 0.125.
CRUD — Filler 002 Qty 1→2002, Status Sent→Draft, Notes set; Torture Notes → 2001-char edited text, Amount →
`"-99.500000"`, Tags → `beta`; "CRUD created invoice 202609012249" present; "Filler invoice 210" gone; 213 total.

### Findings

| Issue | Layer | Summary | Status |
|---|---|---|---|
| F1 ⚠ not yet filed | transport (`pg-common` pull) | `date` columns pull as server-local midnight → TZ-dependent value; exported to Airtable as a dateTime with a spurious time; also the steady-state churn on Postgres-as-destination (Airtable audit F1) | queued |
| F2 ⚠ not yet filed | transport (`pg-common` pull) | `timestamp` (without time zone) columns pull as server-local wall time → every value shifted by the server's UTC offset; extreme values overflow the year | queued |
| F3 ⚠ evidence for DEV-10795 (canceled) | view (`pg-default-view.ts`) | `text[]` / `int[]` / `bool[]` declared `object` → comma-joined text on Airtable although Airtable creates `multipleSelects` | queued as comment |

**F1 — proposed Linear body** (same defect as Airtable `LIVE_EXPORT_AUDIT.md` F1; file once, cite both)

Title: `[POSTGRES→AIRTABLE][transport] Postgres date columns pull as server-local midnight — exported as dateTime with a spurious 07:00/08:00 time, and year-0100 dates pick up the historical LMT offset (08:12:28)`

Layer `[transport]`, `server/src/remote-service/connectors/library/pg-common/knex-pg-client.ts` (register a
pass-through type parser for OID 1082 so `date` stays `YYYY-MM-DD`, mirroring the DEV-10777 NUMERIC reasoning —
check the server's own Knex usage before touching the process-global parser) + `pg-type-mapping.ts:108-118`
(`date` → `format: 'date'` so destinations create date-only fields) + a day-granular canonicalizer in
`pg-field-value-canonicalizer.ts`. Existing pg `date` columns change value once on the next pull.

Evidence: source row `due = 2026-12-31` → pulled file `public/fable_qa_pg_invoices/torture-quotes-bampb-tab.json`
`"due": "2026-12-31T08:00:00.000Z"` (PST) and filler `2026-05-02` → `…T07:00:00.000Z` (PDT); `due = 0100-01-01` →
`"0100-01-01T08:12:28.000Z"` (America/Vancouver LMT −8:12:28 — proves the JS local-time parse). Airtable created
`Due` as **dateTime** (plan kind `date` with `includesTime` because the schema says `format: 'date-time'`) and holds
the shifted values verbatim. Workbook wkb_0EOrtJnfeI, sync syn_1u12HmE0J2, run rrn_h7D9EcxFug. Differential: same
column family churns every run when Postgres is the destination (Airtable audit, wkb_1toKLoHtt9), so this is the
shared pg pull, not either destination pack. Supabase shares `pg-common`.

Priority: High (silent, timezone-dependent corruption of a date-only column on the happy path; masked in prod only
because the servers run in UTC — every local/self-hosted run and every second-run gate hits it).

**F2 — proposed Linear body**

Title: `[POSTGRES→AIRTABLE][transport] timestamp-without-time-zone columns pull as server-local wall time — every value shifts by the server's UTC offset (04:30:15 → 11:30:15Z on PDT) and 9999-12-31 23:59:59 becomes year +010000`

Layer `[transport]`, `pg-common/knex-pg-client.ts` (OID 1114): `node-postgres` parses a naive `timestamp` as local
time, so the ISO rendering we store is the wall-clock value re-based on the server's zone. Fix options for the
maintainer to pick: pass the driver string through verbatim (`"2026-08-05 04:30:15.123456"` — the Prime-Directive
answer, keeps microseconds too) or parse as UTC; either way the schema should stop promising a zoned instant it
does not have. Same pass-through parser idea as F1; the μs → ms truncation (`.123456` → `.123`) goes away with the
string option.

Evidence: source `created_at = 2026-08-05 04:30:15.123456` → pulled `"created_at": "2026-08-05T11:30:15.123Z"` →
Airtable `Created At` `2026-08-05T11:30:15.123Z` (7 h late); source `9999-12-31 23:59:59` → pulled
`"+010000-01-01T07:59:59.000Z"` → Airtable stores the year-10000 value. `timestamptz` in the same row is correct
(`2026-08-05T04:30:15.987+05:30` → `2026-08-04T23:00:15.987Z`), isolating the bug to the zone-less type. Workbook
wkb_0EOrtJnfeI, run rrn_h7D9EcxFug, file `public/fable_qa_pg_invoices/torture-quotes-bampb-tab.json` and
`…/long-4001-single-link-empty-arrays.json`.

Priority: High (silent data corruption on the happy path for any non-UTC server; steady-state is unaffected because
the shift is deterministic).

**F3 — evidence to add to DEV-10795** (`[Schema-builder] Object/array fields downgraded to text`, canceled; sibling
DEV-11120 hashtags comma-join, canceled): `pg-default-view.ts:93-96` maps `TEXT_ARRAY`/`NUMERIC_ARRAY`/`BOOLEAN_ARRAY`
to `object`, so the plan downgrades them to text and Airtable gets `Tags = "alpha, has, comma, \"quoted\", γάμμα"` —
ambiguous for the comma-bearing element — even though `airtable-create-schema.ts` can create `multipleSelects` and
the picker passes a `string[]` through verbatim to a multi destination. Proposed View change: declare `text[]` as a
multi-select-like type (`multiselect` / `object` with array cardinality) so a wide destination gets a real
multi-value field. Not re-filed because the generic ask was canceled; leaving the decision to maintainers.

### Accepted downgrades (not bugs — text is the honest representation)

| # | Field | Type | Why accepted |
|---|---|---|---|
| A1 | big_qty, amount | bigint / numeric → text | DEV-10777: the driver returns arbitrary-precision numerics as strings and the View keeps them as strings so `9007199254740993` survives; Airtable numbers are float64 anyway. Same call as the Supabase audit. Note it is a **silent** `mapped` (no plan warning) — see human remainder |
| A2 | meta | jsonb → JSON text | No JSON type on Airtable; key order re-serialised but value-equal; canonicalizer-safe |
| A3 | fixed_code | char(5) → `"ab   "` | bpchar padding is Postgres semantics; verbatim per the Prime Directive |
| A4 | created_at | μs → ms | JS `Date` precision; disappears if F2 is fixed with the pass-through string |
| A5 | text columns | → multilineText | DEV-11147 decision (singleLineText would drop newlines/tabs) |
| A6 | ratio | 0.30000000000000004 → 0.3 | float64 re-rendering by Airtable; 15-significant-digit canonicalizer makes it a no-op |
| A7 | inverse link fields | Airtable-created | Airtable always creates the inverse of a `multipleRecordLinks` field |

## Human remainder (not automatable — do before launch)

- [ ] Full dusky wizard pass (`localhost:3030/exports`): connection-string placeholder/help text, the array
      downgrade warnings and the `hidden_id` needs-target note in the field picker, run from the UI
- [ ] File F1 and F2 (one issue each, F1 shared with the Airtable audit) plus the umbrella issue with a write-scope
      Linear token; comment F3 on DEV-10795
- [ ] Judgment: should `numeric`/`bigint` export to a wide destination as a number field with a precision warning
      instead of silent text (A1)? and should pg `date` map to `format: 'date'` once F1's parser change lands?
- [ ] Incremental pull with a declared `modifiedAtField` (`updated_at`) was not exercised by the harness

## Log

- 2026-09-01 — Claude Fable 5.1 (`/test-live-export postgres airtable`, DEV-11420 worktree) — doc created; seeded
  `fable_qa_pg_*` (`seeds/postgres/seed.mjs`, `crud-pass.mjs`); ran gates 1–12 against AIRTABLE with the field-value
  canonicalizers on; second run and post-CRUD run are no-ops; found F1/F2 at pull (pg date + naive timestamp local-time
  parsing) and F3 (arrays → comma text); queued for filing.
