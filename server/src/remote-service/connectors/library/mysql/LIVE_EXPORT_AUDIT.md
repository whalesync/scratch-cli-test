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

### Observations (not filed)

- One routine run (`rrn_IuKb5A1Ftl`, retry-probe workbook) failed its pull with "Couldn't complete the MySQL request".
  The cause was a local scratch-git staging error (HTTP 500 on `/api/staging/…/files`), not MySQL; it didn't recur on
  the next two runs. The MySQL connector's error mapping labels any error it gets as a MySQL one, so a scratch-git
  failure reads as a database problem.

## Human remainder (not automatable — do before launch)

- [ ] Full Whalesync wizard pass with a MySQL source and a MySQL destination: the connection string help text (now
      naming 35.233.96.253), the field picker's notes, run from the UI.
- [x] Airtable → MySQL: blocked on 2026-10-21 by the Airtable quota (`PUBLIC_API_BILLING_LIMIT_EXCEEDED`); ran
      2026-10-29 with a new token and base, and passes (`library/airtable/LIVE_EXPORT_AUDIT.md`, Destination: MYSQL).
- [ ] `/review-live-export MYSQL MYSQL,POSTGRES` (the DEV-12346 "Done when" gate).

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
