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

| # | Gate | Status | Evidence |
|---|---|---|---|
| 1 | Preflight (server, token, creds) | ✅ | Local spinner on :3010 from the DEV-12346 worktree (master + !3412 + !3413), 2026-10-21 |
| 2 | Recon: connector + View read, tables chosen | ✅ | `mysql-type-mapping.ts`, `mysql-json-schema.ts`, `mysql-temporal-values.ts`, `mysql-default-view.ts`; invoices + contacts (FK both ways), hidden left out on purpose |
| 3 | Torture data seeded + read back via service API | ✅ | `seed.mjs` → `{"fable_qa_my_invoices":214,"fable_qa_my_contacts":3,"fable_qa_my_hidden":2}`, first id 9007199254740993 |
| 4 | Plan audit: every downgraded field judged | ✅ | `/tmp/audit-mysql-mysql.json`, `/tmp/audit-mysql-postgres.json`; see Accepted downgrades |
| 5 | FKs identified as foreignKey; links resolve on destination | ✅ | `contact_id`, `hidden_id`, `favorite_invoice_id` all `foreignKey`; real constraints on MySQL (`fk_fable_qa_my_invoices_contact_id_b3e16f67`) and Postgres; `hidden_id` correctly dropped |
| 6 | First run: publish failures = 0 or all filed | ✅ MYSQL · ✅ POSTGRES · ✅ MariaDB | rrn_1csHjZixOo 217 creates · rrn_6o1CE8T2gF 217 creates · rrn_zjFDzf0VDg 217 creates; `failedOperations: []` everywhere |
| 7 | Destination-side spot check (≥3 records/table) | ✅ MYSQL · ✅ POSTGRES | `verify-mysql.mjs` and psql: torture, zero-date, all-empty rows and the 3 contacts (below) |
| 8 | CRUD pass: edit / create / delete mirrored | ✅ MYSQL · ✅ POSTGRES | `crud-pass.mjs` tag 202610212148 → rrn_tba1s2Y4di and rrn_VuTfEv3PF3: 1 create / 2 edits / 1 delete, checked with SQL |
| 9 | Pagination: 200+ record table fully synced | ✅ MYSQL · ✅ POSTGRES | 214/214 invoices after every run |
| 10 | Second run is a no-op | ❌ MYSQL · ✅ POSTGRES · ❌ MariaDB | MySQL rrn_i28O1s2rYr and MariaDB rrn_OwZGfhAhGC rewrite 1 record each run: [DEV-12415](https://linear.app/whalesync/issue/DEV-12415), fixed in the MySQL canonicalizer (not re-run yet). Postgres rrn_HmJy15i7M6 wrote nothing |
| 11 | Destination drift: out-of-band delete restored | ✅ MYSQL · ✅ POSTGRES | deleted "Filler invoice 005" in each → rrn_z4o6Djr6iR and rrn_tgBsPMeyfj re-created it |
| 12 | Findings filed or queued below | ✅ | DEV-12412–DEV-12415 (sub-issues of DEV-12346, label `live-export-qa`) |

## Destination: MYSQL (MySQL 8.4 → MySQL 8.4, and → MariaDB 11.4) — 2026-10-21

- Workbooks: MySQL `wkb_Le3Qczfn5N` (sync `syn_IXUFPLro9L`, database `fable_qa_dest_from_mysql`); MariaDB
  `wkb_grgQISNpSY`.
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
  numbers that aren't safe integers at 15 significant digits, so the next run keeps the stored value.

## Destination: POSTGRES (local, schema `fable_qa_dest_from_mysql`) — 2026-10-21

- Workbook `wkb_USlHVP8vrb` (report `/tmp/audit-mysql-postgres.json`). Second run wrote nothing.
- Types: varchar/text → `text`, int/double/float/year/bit/tinyint(1) → `double precision`, bigint / decimal / bigint
  unsigned → `text` (exact digits), date → `date`, datetime and timestamp → `timestamptz`, JSON → `text`, TIME → `text`,
  FK → `uuid` with a constraint.

### Findings

| Issue | Layer | Summary | Status |
|---|---|---|---|
| [DEV-12415](https://linear.app/whalesync/issue/DEV-12415) | dest-pack | MySQL → MySQL: a JSON integer above 2^53 rewrites the record every run | fixed (canonicalizer) |
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

### Observations (not filed)

- One routine run (`rrn_IuKb5A1Ftl`, retry-probe workbook) failed its pull with "Couldn't complete the MySQL request".
  The cause was a local scratch-git staging error (HTTP 500 on `/api/staging/…/files`), not MySQL; it didn't recur on
  the next two runs. The MySQL connector's error mapping labels any error it gets as a MySQL one, so a scratch-git
  failure reads as a database problem.

## Human remainder (not automatable — do before launch)

- [ ] Full Whalesync wizard pass with a MySQL source and a MySQL destination: the connection string help text (now
      naming 35.233.96.253), the field picker's notes, run from the UI.
- [ ] Airtable → MySQL: not run. The audit token's Airtable workspace is over its monthly API quota
      (`PUBLIC_API_BILLING_LIMIT_EXCEEDED`, 2026-10-21).

## Log

- 2026-10-21 — Claude Opus 5.5 (DEV-12346 worktree) — doc created. Seeded `fable_qa_my_*`; ran MYSQL → MYSQL, → POSTGRES
  and → MariaDB; gates 1–9 and 11 pass on all three; gate 10 fails on the MySQL-family destinations (DEV-12415).
- 2026-10-29 — Claude Opus 5.5 (osaka-v1 worktree) — traced DEV-12415 in `wkb_Le3Qczfn5N`: the destination `dirty`
  file holds `…567000` and `PublishPlanOperation.content` holds `1.234567890123457e19`, so the publish plan's Prisma
  `Json` storage rounds it, not MySQL (filed DEV-12614). Fixed the churn in the MySQL JSON canonicalizer; gate 10 not
  re-run yet.
