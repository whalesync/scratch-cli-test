# Live Export audit — MYSQL (source)

> Gates 1–5 are destination-independent; gates 6–12 are re-proved per destination. MySQL as a Live Export
> *destination* (the create path, retries, the probes that only a MySQL destination hits) is written up in
> [`STATE.md`](./STATE.md#live-export-destination-round-2026-10-21), next to the connector it tests.

- Umbrella Linear issue: [DEV-12346](https://linear.app/whalesync/issue/DEV-12346) (MySQL as a Live Export destination;
  this source audit is the "add a MySQL source if it passes the same audit" part of it). MySQL went live as a Live Export
  source in Whalesync on 2026-10-21, before this audit ran.
- Credentials: `local/audit-creds/mysql.env` → `connectionString=mysql://root:root@127.0.0.1:3306?ssl-mode=DISABLED`
  (the local `server/localdev/docker-compose.mysql.yml` server; root, because the seed creates databases and the
  `test` user only sees `test_db`). `mysql-mariadb.env` points at the MariaDB 11.4 server on 3307. The connector
  refuses unknown credential keys, so pass `--dest-parent <database>` instead of `DEST_PARENT_ID` in the file.
- OAuth-only? no.
- Seed script: `tools/live-export-audit/seeds/mysql/seed.mjs` (drops and recreates `fable_qa_my_src`; `--wide`,
  `--reset-dest`) · CRUD pass: `seeds/mysql/crud-pass.mjs` · read-back: `tools/live-export-audit/verify-mysql.mjs`.
- Torture tables (database `fable_qa_my_src`):
  - `fable_qa_my_invoices` ×214 — BIGINT UNSIGNED AUTO_INCREMENT ids from 2^53+1, VARCHAR(255) / CHAR(5) /
    MEDIUMTEXT (markdown + 2,001 and 4,001 characters, emoji, CJK, RTL, quotes, tab, HTML entity), INT, BIGINT max and
    min, BIGINT UNSIGNED max, DECIMAL(18,6), DOUBLE (0.1+0.2, −0.0), FLOAT (1e30), TINYINT(1) holding 0, 1 and 2, DATE
    (incl. `0000-00-00` and `1000-01-01`), DATETIME(6) at both limits, TIMESTAMP(3) at 1970 and 2038, ENUM incl.
    "Paid, with comma", SET, JSON object / array / string scalar (and an integer above 2^53 inside an object), YEAR,
    TIME (−838:59:59), BIT(8), VARBINARY(16), an `ON UPDATE CURRENT_TIMESTAMP(3)` column, FK → contacts, FK →
    `fable_qa_my_hidden` (never exported), an all-empty row, a zero-date row, 210 fillers.
  - `fable_qa_my_contacts` ×3 — VARCHAR, TINYINT(1) (1, 0, NULL), `favorite_invoice_id` FK back to invoices.
  - `fable_qa_my_hidden` ×2 — FK target that is never exported.
  - `fable_qa_my_wide` (only with `--wide`) — 185 INT columns, for the destination field cap probe.

## Gates

Evidence is from the 2026-10-29 rerun (fresh workbooks, after the DEV-12412–DEV-12415 fixes); the 2026-10-21 round's
run ids are in the Log.

| # | Gate | Status | Evidence |
|---|---|---|---|
| 1 | Preflight (server, token, creds) | ✅ | Local spinner on :3010 and scratch-git on :3100 from the atlanta worktree at master `1a9dfe28f`, 2026-10-29 (the first round, 2026-10-21, ran master + !3412 + !3413) |
| 2 | Recon: connector + View read, tables chosen | ✅ | `mysql-type-mapping.ts`, `mysql-json-schema.ts`, `mysql-temporal-values.ts`, `mysql-default-view.ts`; invoices + contacts (FK both ways), hidden left out on purpose |
| 3 | Torture data seeded + read back via service API | ✅ | `seed.mjs --wide --reset-dest` → `{"fable_qa_my_invoices":214,"fable_qa_my_contacts":3,"fable_qa_my_hidden":2,"fable_qa_my_wide":2}`, first id 9007199254740993 |
| 4 | Plan audit: every downgraded field judged | ✅ | `/tmp/rerun-A-mysql-mysql.json`, `/tmp/rerun-C-mysql-postgres.json`; same plan as 10-21, see Accepted downgrades |
| 5 | FKs identified as foreignKey; links resolve on destination | ✅ | `contact_id`, `hidden_id`, `favorite_invoice_id` all `foreignKey`; real constraints on MySQL (`fk_fable_qa_my_invoices_contact_id_b3e16f67`), MariaDB and Postgres; `hidden_id` correctly dropped |
| 6 | First run: publish failures = 0 or all filed | ✅ MYSQL · ✅ POSTGRES · ✅ MariaDB | rrn_vEJ6m476XK · rrn_F8r04lrmO1 · rrn_h3VzujcEBm, 217 creates each; `failedOperations: []` everywhere |
| 7 | Destination-side spot check (≥3 records/table) | ✅ MYSQL · ✅ POSTGRES · ✅ MariaDB | MySQL and MariaDB: every source row compared column by column with the destination row (214/214 invoices, 3/3 contacts, links mapped back to source ids); only the 5 accepted cells below differ. Postgres: torture, long, zero-date rows and the 3 contacts with psql |
| 8 | CRUD pass: edit / create / delete mirrored | ✅ MYSQL · ✅ POSTGRES · ✅ MariaDB | `crud-pass.mjs` tag 202610292230 → rrn_8oR8mm5Dmc · rrn_ECckygllCn · rrn_MtGIXKLRx5: 1 create / 2 edits / 1 delete, checked with SQL (MySQL and MariaDB by the full-table comparison) |
| 9 | Pagination: 200+ record table fully synced | ✅ MYSQL · ✅ POSTGRES · ✅ MariaDB | 214/214 invoices after every run |
| 10 | Second run is a no-op | ✅ MYSQL · ✅ POSTGRES · ✅ MariaDB | rrn_BbXhYOPyen · rrn_hf17LiOhZQ · rrn_rBZXYXZMeE "No changes", and again after CRUD and drift (rrn_uVZHWm2BhD · rrn_FBu4Vre4qq · rrn_XXwvAcas79). [DEV-12415](https://linear.app/whalesync/issue/DEV-12415) verified: on 10-21 MySQL and MariaDB rewrote 1 record every run |
| 11 | Destination drift: out-of-band delete restored | ✅ MYSQL · ✅ POSTGRES · ✅ MariaDB | deleted "Filler invoice 005" in each → rrn_EmpmcSC367 · rrn_01Cfjo52cS · rrn_p6A4pV5QlY each published exactly 1 create |
| 12 | Findings filed or queued below | ✅ | DEV-12412–DEV-12415 (sub-issues of DEV-12346, label `live-export-qa`) fixed and re-verified 2026-10-29; DEV-12614 and DEV-12615 open; the rerun found nothing new |

## Destination: MYSQL (MySQL 8.4 → MySQL 8.4, and → MariaDB 11.4) — 2026-10-21, rerun 2026-10-29

- Workbooks (2026-10-29): MySQL `wkb_F6mYRcS1G0` (sync `syn_VJL8fi1EF1`, database `fable_qa_dest_from_mysql`, report
  `/tmp/rerun-A-mysql-mysql.json`); MariaDB `wkb_7YLSFAi2jL` (sync `syn_V95C7nAaKR`, same database name,
  `--dest-creds mysql-mariadb.env`). 10-21: `wkb_Le3Qczfn5N` and `wkb_grgQISNpSY`, stale since the reseed.
- **Rerun (2026-10-29):** first run 217 creates, second run "No changes", CRUD 1 / 2 / 1, drift exactly 1 create, then
  "No changes" again, on both servers. The created types are the same as 10-21. A full-table comparison (every column of
  every source row against its destination row, links mapped back to source ids) finds only the 5 accepted cells:
  `ratio`, `meta.big`, `bits`, and the zero-date row's `due` and `created_at`.
- **Exact types (DEV-11903):** a MySQL → MySQL plan recreates each column's `COLUMN_TYPE`: `varchar(255)`, `char(5)`,
  `int`, `bigint`, `bigint unsigned` (18446744073709551615 intact), `decimal(18,6)`, `double`, `float`, `tinyint(1)`,
  `date`, `datetime(6)` (9999-12-31 23:59:59.999999 intact), `timestamp(3)`, `json`, `year`, `time` (−838:59:59 intact).
  ENUM and SET become `mediumtext`, BIT a `double` (165), VARBINARY base64 text; NOT NULL and `ON UPDATE` aren't copied.
  MariaDB gets the same types in its own spelling (`int(11)`, JSON as `longtext`).
- **Zero dates:** the source keeps `0000-00-00` verbatim (STATE.md), and the engine's date guard writes NULL with a
  warning ("Skipped invalid date … Wrote an empty value"). Later runs compare equal: no churn.
- **Second run:** one rewrite per run, the torture row. Its JSON holds `12345678901234567000`, and the destination
  stores `12345678901234570000`; [DEV-12415](https://linear.app/whalesync/issue/DEV-12415). Found by isolating: clearing
  the zero-date row's JSON didn't stop it; the scratch-git history of the destination folder showed the changed key.
  MySQL isn't the one changing it: the destination's `dirty` file still holds `…567000`, but the publish plan stores
  the operation through Prisma `Json`, which rounds it one float64 step to `1.234567890123457e19`
  (`PublishPlanOperation.content`), and MySQL stores what it is sent. Root cause:
  [DEV-12614](https://linear.app/whalesync/issue/DEV-12614). DEV-12415's fix: the MySQL JSON canonicalizer compares
  numbers that aren't safe integers at 15 significant digits, so the next run keeps the stored value. Verified
  2026-10-29: the destination still holds `12345678901234570000` (DEV-12614), and every later run wrote nothing.

## Destination: POSTGRES (local, schema `fable_qa_dest_from_mysql`) — 2026-10-21, rerun 2026-10-29

- Workbook `wkb_auGDV5c6Me` (sync `syn_S9wI9ZloAA`, report `/tmp/rerun-C-mysql-postgres.json`; 10-21:
  `wkb_USlHVP8vrb`). Second run, post-CRUD run and post-drift run wrote nothing. `Meta` (text) keeps
  `12345678901234567000` exactly, and the links (`Contact Id`, `Favorite Invoice Id`) carry real `ON DELETE SET NULL`
  constraints.
- Types: varchar/text → `text`, int/double/float/year/bit/tinyint(1) → `double precision`, bigint / decimal / bigint
  unsigned → `text` (exact digits), date → `date`, datetime and timestamp → `timestamptz`, JSON → `text`, TIME → `text`,
  FK → `uuid` with a constraint.

### Findings

| Issue | Layer | Summary | Status |
|---|---|---|---|
| [DEV-12415](https://linear.app/whalesync/issue/DEV-12415) | dest-pack | MySQL → MySQL: a JSON integer above 2^53 rewrites the record every run | fixed (canonicalizer), verified 2026-10-29 |
| [DEV-12614](https://linear.app/whalesync/issue/DEV-12614) | core | The publish plan's Prisma `Json` storage rounds numbers one float64 step (the cause of DEV-12415 and of the `ratio` downgrade) | filed |

Destination-only findings (DEV-12412, DEV-12413, DEV-12414) are listed in STATE.md's destination round.

### Accepted downgrades (not bugs)

| Field | Type | Why accepted |
|---|---|---|
| paid, flag_byte | TINYINT(1) → number | The connector reads TINYINT(1) as a number on purpose: the column can hold −128…127, and the seed's `2` survives |
| status, tags | ENUM / SET → select / text | ENUM and SET members aren't recreated (`isRecreatableMySqlNativeColumnType`); the value text is kept |
| bits, raw | BIT / VARBINARY → number / base64 | The read side's representation; a MySQL destination can't recreate them from it |
| ratio | 0.30000000000000004 → 0.3 | Same 15-significant-digit behavior the Postgres audit accepted (A6). MySQL keeps all 17 digits from a literal insert; the rounding is the publish plan's Prisma `Json` storage ([DEV-12614](https://linear.app/whalesync/issue/DEV-12614)), and the canonicalizer compares at 15 |
| meta | JSON integer above 2^53 loses digits | Known gap (STATE.md) on pull; the extra step lost on publish is [DEV-12614](https://linear.app/whalesync/issue/DEV-12614); the churn it caused is DEV-12415 (fixed) |
| due, created_at | zero dates → NULL | Not real dates; the engine writes NULL with a warning, and runs converge |
| meta (→ POSTGRES only) | JSON → `text`: arrays comma-joined, `[]` → `''`, string scalars unquoted | Accepted limitation (2026-10-30, [DEV-12660](https://linear.app/whalesync/issue/DEV-12660)): JSON fields don't carry over between different database connectors yet. MySQL → MySQL and MariaDB keep `json` exactly |

### Observations (not filed)

- One routine run (`rrn_IuKb5A1Ftl`, retry-probe workbook) failed its pull with "Couldn't complete the MySQL request".
  The cause was a local scratch-git staging error (HTTP 500 on `/api/staging/…/files`), not MySQL; it didn't recur on
  the next two runs. The MySQL connector's error mapping labels any error it gets as a MySQL one, so a scratch-git
  failure reads as a database problem.

## Human remainder (not automatable — do before launch)

- [x] Full Whalesync wizard pass with a MySQL source and a MySQL destination: the connection string help text (now
      naming 35.233.96.253), the field picker's notes, run from the UI. Done 2026-10-30 after
      [DEV-12659](https://linear.app/whalesync/issue/DEV-12659) merged; see Wizard pass below.
- [x] Airtable → MySQL: blocked on 2026-10-21 by the Airtable quota (`PUBLIC_API_BILLING_LIMIT_EXCEEDED`); ran
      2026-10-29 with a new token and base, and passes (`library/airtable/LIVE_EXPORT_AUDIT.md`, Destination: MYSQL).
- [x] `/review-live-export MYSQL MYSQL,POSTGRES` (the DEV-12346 "Done when" gate). Ran 2026-10-30: PASS once
      [DEV-12660](https://linear.app/whalesync/issue/DEV-12660), its only finding, was accepted as a known limitation the
      same day (see the Review below).

## Review — 2026-10-30

Verdict: **PASS**, with [DEV-12660](https://linear.app/whalesync/issue/DEV-12660) accepted as a known limitation. The
review first returned FAIL on that one `[picker]` finding. Chris accepted it the same day: JSON fields don't carry over
between different database connectors yet, and the fix comes later. No code or data changed in between, so the
evidence below stands without a rerun. The finding isn't MySQL's: it reproduces from a Postgres source into MySQL, and
the MySQL and MariaDB destinations found nothing. Every gate's evidence reproduced.

Re-proved (local spinner and scratch-git from the almaty worktree at master `194edc5f7`; destinations read with mysql2
and pg directly, never through our pull; the full-table comparisons are in the almaty worktree's `.context/review/out/`):

- **Preflight**: OK for → MySQL, → MariaDB, → Postgres, and Postgres → MySQL (`/tmp/review-preflight-*.json`,
  plan-only workbooks `wkb_2jw11r2Da4`, `wkb_6vd1zImqsK`, `wkb_rL2skgX1Eh`, and `wkb_mL6VeZ5OXK`).
- **The author's evidence (gates 4–11)**:
  - All 20 run ids on `wkb_F6mYRcS1G0`, `wkb_7YLSFAi2jL`, `wkb_auGDV5c6Me`, and `wkb_gRTj1gfC06` were re-read with
    `GET /routine-runs/:id?includeJobs=true`. Statuses, per-table counts, and `failedOperations: []` match the doc.
  - `/tmp/rerun-{A,B,C,D}-*.json` agree: `maxFieldsPerTable: 180`, three `needs_target` FKs, and `hidden_id` dropped.
  - The gate 2 files exist.
- **Destination read-back (gates 5, 7, and 9)**:
  - MySQL and MariaDB: 214/3 rows; the `COLUMN_TYPE`s in "Exact types"; both `ON DELETE SET NULL` constraints by
    name; and the `live_export:dfd_…` comments. NOT NULL and `ON UPDATE` are not copied.
  - Every source row was compared column by column with its destination row, links mapped back to source ids. The only
    cells that differ are `ratio`, `meta.big`, and the zero-date row's `due` and `created_at`. BIT and VARBINARY match
    in the read side's representation (165, base64). MariaDB stores JSON compacted.
  - Postgres: types as listed, both constraints, and `Meta` keeps `12345678901234567000`. It differs at the same cells
    plus `Meta` for `[]` (stored `''`) and `"just a string"` (stored unquoted), which is finding 1.
- **Fresh rerun (gate 10)**: rrn_FklF3G60BP, rrn_pynyQ25zXY, rrn_pQmsWpn0Eu, and rrn_ImDah9Hfw8 (PG → MySQL) all
  report "No changes".
- **Own CRUD probe (gate 8)**, on rows `crud-pass.mjs` doesn't touch (`.context/review/source-crud-probe.mjs`, tag
  202610301500). The order below is MySQL, MariaDB, then Postgres for each step:
  - **Phase 1**: create a contact and an invoice linked to it, re-point Filler 120 to the contact, and edit JSON
    arrays, a JSON scalar, DATETIME(6) microseconds, BIGINT UNSIGNED max, `ratio`, and Carol's `vip`.
    - rrn_T1IPcAL1VZ, rrn_a2RKUXCvYQ, and rrn_JUgGQfQAko each made 2 creates and 6 edits with 0 failures.
    - The comparisons match apart from the known cells.
    - The next runs (rrn_jsgWXK0Y8I, rrn_CmDzZgbaGw, and rrn_tjLTWit4wy) report "No changes".
  - **Phase 2**: delete the review contact (the source FK sets its links NULL) and the review invoice, then restore
    every edit.
    - rrn_VnB6zcDX76, rrn_r68sZ31F0x, and rrn_LN6hFG1qoO each made 7 edits and 2 deletes.
    - All three destinations are back to the baseline, with the links NULL.
- **Own drift probe (gate 11)**: in each destination, tamper Filler 130's `qty` and delete Bob, which nulls the Long
  invoice's link.
  - rrn_ryBwUctJTo, rrn_G5AlAggp6K, and rrn_IlZo06vIiT each made 1 create and 2 edits. Bob came back, the link was
    re-pointed, and `qty` was restored.
  - Then rrn_bOkPmyVdOw, rrn_YioFLkPQ7t, and rrn_w036UhckPf report "No changes".
- **PG → MySQL** (`wkb_gRTj1gfC06`): an edit to Filler 140 and a create linked to Carol.
  - rrn_1JCvbZaP4y made 1 create and 1 edit. The `+05:30` instant is stored in UTC, `9007199254740993` is exact, and
    the link resolves.
  - The revert, rrn_HVfjhGAwaN, made 1 edit and 1 delete, and rrn_boLiTEAbjB reports "No changes". The destination is
    back to 213 invoices.
- **DEV-12614 on a second destination**: the sync's dirty write of Filler 123 holds `0.30000000000000004`.
  `PublishPlanOperation.content` holds `0.3` for all three destinations, and so do the destination rows. The `[core]`
  tag stands.
- **Layers**:
  - DEV-12412 `[core]` and DEV-12414 `[core]` hold. Notion, Supabase, Airtable, and Postgres also return `partial`
    creates, and Airtable also declares `maxFieldsPerTable`.
  - DEV-12413, DEV-12415, and DEV-12615 `[dest-pack]` hold. Postgres takes emoji names and didn't churn on `meta`, and
    DEV-12615's fix is in `mysql-create-schema.ts`. DEV-12415 names its root cause, DEV-12614.
  - No duplicates of the known generics.

Findings:

1. **`[picker]` The `meta` JSON → text downgrade on Postgres was never judged, and it loses data.**
   - The plan notes Postgres `Meta` as `downgraded` ("Can't unpack this MySQL object field"). Neither Accepted
     downgrades nor gate 4 covers it; the doc only lists "JSON → text".
   - Postgres can create `jsonb`. Objects survive as JSON text, but arrays and string scalars don't:
     - `["x", "y, with comma"]` becomes `x, y, with comma`;
     - `[{"a": 1}, {"b": [2, 3]}]` becomes `{"a":1}, {"b":[2,3]}`;
     - `[]` becomes `''`;
     - `"just a string"` loses its quotes.
   - Reproduced from the other direction: Postgres `jsonb` `["p", "q, r"]` lands in MySQL `mediumtext` as `p, q, r`.
   - Cause: `inferLogicalFieldType` keeps the json kind only for schema types `object` and `array`, and both connectors
     type JSON columns `Unknown`. The picker then comma-joins arrays.
   - Filed as [DEV-12660](https://linear.app/whalesync/issue/DEV-12660) (Medium, related to DEV-12572 and DEV-11903).
   - **Accepted 2026-10-30** as a known limitation, now listed under Accepted downgrades. DEV-12660 tracks the later
     fix.
   - DEV-12660 also notes a same-connector gap found while checking this: Postgres → Postgres rejects a `jsonb` string
     scalar on create (`wkb_DH1S7YkfRS`). It doesn't touch this source's destinations.

Observations (not filed):

- **The sync step never reports deletes.** `sync-data-folders.job.ts` copies `recordsCreated` and `recordsUpdated` into
  each table's progress, but not `recordsDeleted` / `deletedPaths`. FK-phase updates aren't counted either.
  - Phase 2's sync read "Synced 5 records" with 0 deletes, while the publish made 7 edits and 2 deletes. The author's
    CRUD runs show the same pattern.
  - The web client's job indicator shows that 0; dusky reads only the publish counts.
  - It's generic and Low.
- **Steady-state runs always warn.** Every run, no-ops included, reads "Completed with 2 warning(s)" for the zero-date
  row. That's truthful, since the value is still not exported.
- **BIGINT, DECIMAL, and BIGINT UNSIGNED land as text on Postgres.** The digits are exact, and Postgres could hold
  `numeric`. This is the same open judgment as the Postgres audit's A1, not a new finding.
- **Linear hygiene.** DEV-12412–DEV-12415 and DEV-12615 are in project Listings & Discoverability rather than
  `[MAJOR] Live Export`, grouped under DEV-12346. DEV-12614 has no `live-export-qa` label, which fits: it affects every
  classic publish. Not blocking.

Human remainder confirmed outstanding: the wizard pass (done the same day, see below), and, for DEV-12346's "Done
when", MySQL in `LIVE_EXPORT_DEST_SERVICES`'s `LAUNCHED` variation (LaunchDarkly).

## Wizard pass — 2026-10-30

Local dusky (`localhost:3030/exports`) and bottlenose at whalesync master `7e41e7c9b`, which includes DEV-12659
(`ee64dd3d6`). Local spinner at `194edc5f7`. Chris signed in with Google, and the rest was driven with Playwright
over CDP. It's a MySQL → MySQL export of `fable_qa_my_src` invoices, contacts, and `fable_qa_my_wide` (185 columns)
into a new database, `fable_qa_dest_wizard`. Workbook `wkb_HeeRSz8LgS`.

Passed:

- **Connect**:
  - MySQL is offered as a destination (LaunchDarkly test env).
  - The connection string has the placeholder `mysql://user:password@host:3306/database`, and its help text names
    35.233.96.253.
  - Both connections succeed, and the location picker lists the server's databases.
- **Field picker**:
  - Each field shows its native type (`decimal(18,6)`, `bigint unsigned`, `datetime(6)`, `json`, …).
  - `hidden_id` is disabled with a "+ fable_qa_my_hidden" button, since that table isn't in the export.
  - Links into a table already in the export are selected (`favorite_invoice_id`). MySQL → MySQL has no `downgraded`
    notes, so there are no other glyphs.
- **DEV-12659**:
  - The wide table starts at "180 of 186". c180–c185 are unselected, each with the amber glyph. Its tooltip reads
    "left unselected — MySQL allows at most 180 fields per table and this table has 186, so 6 fields were left out;
    select it in place of another field to include it".
  - Selecting c180 turns the count red (181) and shows "Too many fields selected. MySQL allows at most 180 fields per
    table, and this table has 181 selected. Unselect 1 field." Next is disabled until c180 is unselected again.
- **Create**: "3 tables and 212 fields are ready in MySQL" (6 + 26 + 180).
  - The wide table has 181 columns: the injected `id` plus 180 fields, with c180–c185 absent.
  - All three tables carry `live_export:dfd_…` comments.
  - Both foreign keys are real `ON DELETE SET NULL` constraints.
- **Run from the UI**:
  - "Run first export" ran rrn_1NX8mK1d0n: "Published 219 changes" (214 + 3 + 2), 0 failed operations, and "Completed
    with warnings" (the zero-date row).
  - A column-by-column comparison of every row differs only at the zero-date row's `due` and `created_at`.
  - "Rerun now" ran rrn_HpfYL5V6Xm: "No changes".

Notes (only the dropped-link one is filed, as DEV-12662):

- **The run-store engine was on by default.** "Use the new run-store engine (faster, experimental)" is a developer
  option, and it came pre-checked for this account, so both runs used `liveExportEngine: run_store`. On that engine
  `ratio` (`0.30000000000000004`) and `meta.big` (`12345678901234567000`) land exactly. DEV-12614's rounding is
  classic-engine only, and the audit and review above cover the classic engine.
- **Adding tables one at a time drops links.** A link field starts unselected when its target table isn't in the
  export yet, and adding the target later doesn't select it.
  - Invoices was added before contacts, so `contact_id` stayed unticked, with no warning, until it was ticked by hand.
    "Add all tables" avoids this.
  - It's the documented behavior in `usePlaceholderTables.ts` (an existing selection is never overwritten). It isn't a
    DEV-12659 regression, and it isn't MySQL-specific.
  - Filed as [DEV-12662](https://linear.app/whalesync/issue/DEV-12662) (Whalesync project, UI bug, Medium, S).
- **The CA certificate field is a single-line password input.** Chrome strips the line breaks from a pasted PEM, but
  the server normalizes newline-stripped PEMs (`pem-certificates-and-keys.ts`), so it still works. The multi-line
  input needs a dusky bump of `@spinner/shared-types` to a version with DEV-12644's `format: 'pem'`.
- **Not exercised:**
  - DEV-12659's failed-table naming, since the wizard now blocks the selection that used to cause the failure.
  - The edit-mappings flow's cap check.

## Log

- 2026-10-21 — Claude Opus 5.5 (DEV-12346 worktree) — doc created. Seeded `fable_qa_my_*`; ran MYSQL → MYSQL, → POSTGRES
  and → MariaDB; gates 1–9 and 11 pass on all three; gate 10 fails on the MySQL-family destinations (DEV-12415).
- 2026-10-29 — Claude Opus 5.5 (osaka-v1 worktree) — traced DEV-12415 in `wkb_Le3Qczfn5N`: the destination `dirty`
  file holds `…567000` and `PublishPlanOperation.content` holds `1.234567890123457e19`, so the publish plan's Prisma
  `Json` storage rounds it, not MySQL (filed DEV-12614). Fixed the churn in the MySQL JSON canonicalizer; gate 10 not
  re-run yet.
- 2026-10-29 — Claude Opus 5.5 (atlanta worktree, master `1a9dfe28f`) — reran gates 1–11 on fresh workbooks after the
  DEV-12412–DEV-12415 fixes (`seed.mjs --wide --reset-dest`): MYSQL → MYSQL, → MariaDB and → POSTGRES all pass,
  gate 10 included, so DEV-12415 is verified. The fix probes are in STATE.md's destination round. 10-21 run ids:
  first runs rrn_1csHjZixOo / rrn_6o1CE8T2gF / rrn_zjFDzf0VDg, CRUD rrn_tba1s2Y4di / rrn_VuTfEv3PF3, second runs
  rrn_i28O1s2rYr / rrn_OwZGfhAhGC / rrn_HmJy15i7M6, drift rrn_z4o6Djr6iR / rrn_tgBsPMeyfj.
- 2026-10-30 — Claude Opus 5.5 (almaty worktree, master `194edc5f7`) — `/review-live-export MYSQL MYSQL,POSTGRES`:
  every gate's evidence reproduced, and my own CRUD, drift, and PG → MySQL probes passed on all three destinations.
  FAIL on one upstream finding, DEV-12660 (a JSON column crossing between MySQL and Postgres lands as text). The dusky
  wizard pass waits on DEV-12659.
- 2026-10-30 — Claude Opus 5.5 (almaty worktree) — Chris accepted DEV-12660 as a known limitation (JSON fields don't
  carry over between different database connectors yet), so the review's verdict is PASS. Added `meta` (→ POSTGRES) to
  Accepted downgrades.
- 2026-10-30 — Claude Opus 5.5 (almaty worktree) — dusky wizard pass after DEV-12659 merged (whalesync `7e41e7c9b`):
  MySQL → MySQL through `localhost:3030/exports` (`wkb_HeeRSz8LgS`). The over-cap fields start unselected and Next is
  blocked over the limit. The run from the UI (rrn_1NX8mK1d0n) matches the source, and the rerun (rrn_HpfYL5V6Xm) wrote
  nothing. Both runs used the run-store engine (pre-checked developer option).
