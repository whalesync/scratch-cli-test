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
| 6 | First run: publish failures = 0 or all filed | ✅ AIRTABLE | rrn_h7D9EcxFug: 216 creates, `failedOperations: []` · ✅ MYSQL rrn_PopmGHsmb7 (2026-10-29 rerun; 10-21 rrn_MfEyIJwCPd): 216 creates, `failedOperations: []` · ✅ MariaDB rrn_0RrVY7DjN2 (10-21 rrn_27vT6iO976): 216 creates, none failed |
| 7 | Destination-side spot check (≥3 records/table) | ✅ AIRTABLE | Airtable REST: torture, all-empty, long-4001, filler-001 + all 3 contacts (below) · ✅ MYSQL `verify-mysql.mjs` + SQL: torture, all-empty, long-4001, all 3 contacts (below) |
| 8 | CRUD pass: edit / create / delete mirrored | ✅ AIRTABLE | rrn_Nv8exXMy4B: 1 create / 2 edits / 1 delete, verified via Airtable REST · ✅ MYSQL rrn_lpqMRJglHU · MariaDB rrn_0ltTs6LJYH (10-21 rrn_JxG35NOy9r): 1 create / 2 edits / 1 delete, verified with SQL |
| 9 | Pagination: 200+ record table fully synced | ✅ AIRTABLE | 213/213 invoices on Airtable (paged count) · ✅ MYSQL 213/213 after every run |
| 10 | Second run is a no-op | ✅ AIRTABLE | rrn_DIWZLS1Uyy "No changes"; rrn_oCaJrbLyCu (after CRUD) "No changes" — with the DEV-11420 Airtable canonicalizers on · ✅ MYSQL rrn_P1mLEoNgbt and rrn_8d1nqgCivV (after CRUD and drift) wrote nothing · ✅ MariaDB rrn_KTiAQgUt8V and rrn_3eHhvbs1WK (10-21 rrn_bllrxdoqyS, rrn_bvk10Ed1J2, rrn_h4RypGxVUJ) |
| 11 | Destination drift: out-of-band delete restored | ✅ AIRTABLE | deleted "Filler invoice 005" via Airtable REST → rrn_PrkFndWPZn published exactly 1 create, record back with same `postgres_record_id` · ✅ MYSQL deleted "Filler invoice 005" with SQL → rrn_DVBjdmWCkI published exactly 1 create (MariaDB rrn_AOvHzauKMK; 10-21 rrn_PkfI0lff8T) |
| 12 | Findings filed or queued below | ⚠ partly filed | F1/F2 filed as DEV-12576; F3 queued as evidence on DEV-10795; the umbrella issue is still queued (Human remainder) |

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
| F1 → DEV-12576 | transport (`pg-common` pull) | `date` columns pull as server-local midnight → TZ-dependent value; exported to Airtable as a dateTime with a spurious time; also the steady-state churn on Postgres-as-destination (Airtable audit F1) | fixed in DEV-12576 (verbatim `YYYY-MM-DD`, `format: 'date'`, day-granular canonicalizer); not re-audited |
| F2 → DEV-12576 | transport (`pg-common` pull) | `timestamp` (without time zone) columns pull as server-local wall time → every value shifted by the server's UTC offset; extreme values overflow the year | fixed in DEV-12576 (parsed as UTC; μs → ms truncation A4 remains); not re-audited |
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

## Destination: MYSQL (2026-10-21)

> Run for [DEV-12346](https://linear.app/whalesync/issue/DEV-12346) (MySQL as a Live Export destination) against a local
> spinner with the retry fix (!3412) and the egress IP change (!3413). Source: the same `fable_qa_pg_*` seed, in a local
> Postgres database `fable_qa_audit` (`postgres.env` → `postgresql://…@127.0.0.1:5432/fable_qa_audit`). Destination: local
> MySQL 8.4 (`mysql.env`, database `fable_qa_dest_from_supabase`) and MariaDB 11.4 (`--dest-creds mysql-mariadb.env`).

- Workbooks: MySQL `wkb_Uzmi3zQf2M` (sync `syn_lNwncp1KQe`, report `/tmp/audit-postgres-mysql.json`); MariaDB
  `wkb_1risAQ1vdX` (`/tmp/audit-postgres-mariadb.json`).
- Runs (MySQL): rrn_MfEyIJwCPd (first, 216 creates) · rrn_bllrxdoqyS (second, nothing) · rrn_JxG35NOy9r (CRUD) ·
  rrn_PkfI0lff8T (drift, 1 create) · rrn_bvk10Ed1J2 (steady, nothing).
- **Created schema** (checked with `verify-mysql.mjs`): InnoDB, utf8mb4, comment `live_export:<source folder id>`,
  `id bigint unsigned auto_increment` key. text → `mediumtext`, integer and real → `double`, bigint and numeric → `mediumtext`
  (A1), boolean → `tinyint(1)`, timestamp, timestamptz and date → `datetime(3)` (date because of F1 at pull), arrays and
  jsonb → `mediumtext`, `Contact Id` → `bigint unsigned` with a real `ON DELETE SET NULL` constraint to contacts.
  `postgres_record_id` holds the source uuid.
- **Spot checks with SQL:** torture row: emoji, CJK, RTL, quotes, tab and `<b>&amp;</b>` intact; 2,001-character notes
  intact; `9007199254740993` and `-1234567.123456` exact; `+05:30` timestamp stored as its UTC instant
  `2026-08-04 23:00:15.987`; microseconds cut to milliseconds (A4). All-empty row: every column NULL. Long row: 4,001
  characters, `''` kept as `''`, int8 minimum exact, `0100-01-01` and `0001-01-01` stored. Contacts: links point at the
  destination ids of the torture and long invoices.
- **MariaDB 11.4:** the same plan with MariaDB spellings (`int(11)`, `bigint(20) unsigned`); 216 creates, second run
  wrote nothing.
- **Rerun 2026-10-29** (atlanta worktree, master `1a9dfe28f`, after the DEV-12412–DEV-12415 fixes; `postgres.env`
  now ends in `?sslmode=disable`, needed since DEV-12575). Fresh workbooks: MySQL `wkb_gRTj1gfC06` (sync
  `syn_yQGX3gQjpi`, `/tmp/rerun-D-postgres-mysql.json`) and MariaDB `wkb_DmNKhWv5KX` (sync `syn_5gNlpnkyKw`).
  - MySQL runs: rrn_PopmGHsmb7 (216 creates) · rrn_P1mLEoNgbt (nothing) · rrn_lpqMRJglHU (CRUD 1 / 2 / 1) ·
    rrn_DVBjdmWCkI (drift, 1 create) · rrn_8d1nqgCivV (nothing).
  - MariaDB runs: rrn_0RrVY7DjN2 · rrn_KTiAQgUt8V · rrn_0ltTs6LJYH · rrn_AOvHzauKMK · rrn_3eHhvbs1WK, with the same
    results.
  - One change from 10-21: pg `date` now creates a MySQL `date` column (DEV-12576), not `datetime(3)`.
  - The spot checks match the bullets above, and both foreign keys are real constraints on both servers.
- No MySQL-specific findings from this source. MySQL-destination findings from the MySQL source round and the probes are
  in `library/mysql/STATE.md` (Live Export destination round) and filed as DEV-12412–DEV-12415.

## Human remainder (not automatable — do before launch)

- [ ] Full dusky wizard pass (`localhost:3030/exports`): connection-string placeholder/help text, the array
      downgrade warnings and the `hidden_id` needs-target note in the field picker, run from the UI
- [ ] File the umbrella issue with a write-scope Linear token (F1 and F2 are filed as DEV-12576); comment F3 on
      DEV-10795
- [ ] Judgment: should `numeric`/`bigint` export to a wide destination as a number field with a precision warning
      instead of silent text (A1)? (pg `date` → `format: 'date'`: done in DEV-12576)
- [ ] Incremental pull with a declared `modifiedAtField` (`updated_at`) was not exercised by the harness

## Log

- 2026-09-01 — Claude Fable 5.1 (`/test-live-export postgres airtable`, DEV-11420 worktree) — doc created; seeded
  `fable_qa_pg_*` (`seeds/postgres/seed.mjs`, `crud-pass.mjs`); ran gates 1–12 against AIRTABLE with the field-value
  canonicalizers on; second run and post-CRUD run are no-ops; found F1/F2 at pull (pg date + naive timestamp local-time
  parsing) and F3 (arrays → comma text); queued for filing.
- 2026-10-21 — Claude Opus 5.5 (DEV-12346 worktree) — added the MYSQL destination round (and MariaDB 11.4): gates 6–11
  pass, second runs write nothing. The seed ran against a new local database `fable_qa_audit`.
- 2026-10-29 — Claude Opus 5.5 (atlanta worktree) — reran the MYSQL and MariaDB destination rounds on fresh workbooks
  after the DEV-12412–DEV-12415 fixes: gates 6–11 pass on both. `seed.mjs --names` now recreates `fable_qa_pg_names`,
  the DEV-12413 probe table (see MySQL STATE.md).
- 2026-10-30 — Claude Opus 5.5 (almaty worktree, `/review-live-export MYSQL MYSQL,POSTGRES`) — re-proved the
  MYSQL destination round's 10-29 runs on `wkb_gRTj1gfC06`, and ran a probe: an edit and a create, rrn_1JCvbZaP4y, then
  a revert, rrn_HVfjhGAwaN, then a no-op, rrn_boLiTEAbjB. It found DEV-12660: a `jsonb` array lands in MySQL
  `mediumtext` comma-joined (`["p", "q, r"]` → `p, q, r`, `[]` → `''`), though MySQL can create `json`. Chris
  accepted it the same day as a known limitation: JSON fields don't carry over between different database connectors
  yet. A Postgres → Postgres check (`wkb_DH1S7YkfRS`) keeps `jsonb` exactly, except that a string scalar is rejected
  on create. That gap is noted on DEV-12660 too.
