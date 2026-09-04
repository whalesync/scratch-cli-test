# DEV-11420 — Test plan for the Airtable and Postgres/Supabase field-value canonicalizers

- **Status:** In Progress
- **Author:** Rob ODwyer
- **Created:** 2026-09-01
- Linear: https://linear.app/whalesync/issue/DEV-11420

## What changed

The Airtable and Postgres/Supabase field-value canonicalizers (DEV-10556) were implemented and
spec-covered but never registered. This branch registers them:

| Connector | Hook                                   | Registered in                                 |
| --------- | -------------------------------------- | --------------------------------------------- |
| Airtable  | `resolveAirtableFieldValueCanonicalizer` | `library/airtable/airtable-connector.ts`      |
| Postgres  | `resolvePgFieldValueCanonicalizer`       | `library/postgres/postgres-connector.ts`      |
| Supabase  | `resolvePgFieldValueCanonicalizer`       | `library/supabase/supabase-connector.ts`      |

Nothing about the sync's gating changed. The per-field canonical skip in
`SyncService.syncTableMapping` (see [`docs/sync-flow.md`](../../sync-flow.md) § 3c) is still
evaluated once per table mapping against the acting user's
`ENABLE_NOTION_FIELD_VALUE_CANONICALIZERS` flag, fail-closed. That flag now gates all four
registered connectors; its Notion-branded name is historical and the PostHog key was kept so existing
per-user rollouts carry over. Renaming it is a separate PostHog change.

> **Update 2026-09-04:** the flag has since been fully launched and removed from the code. The canonical skip now runs
> for every sync with no per-user gate.

## What "works" means

Each connector has to satisfy two claims, and the second is as important as the first:

1. **Diff stability.** A sync whose source did not change leaves the destination record
   byte-identical on disk and publishes nothing, for exactly the drift classes the canonicalizer
   covers.
2. **Not over-eager.** A real source change still lands on the destination; clearing a source
   field still clears it; with the flag off, behaviour is exactly what it was before.

### Drift classes each canonicalizer is responsible for

**Airtable** (`airtable-field-value-canonicalizer.ts`), for every writable `fields.<name>` column:

| Column type                                                       | Stored (pulled) value | Sync writes                    | Must compare |
| ----------------------------------------------------------------- | --------------------- | ------------------------------ | ------------ |
| text-like, url, email, phone, single select, single link          | key absent            | `""` or `null`                 | equal        |
| checkbox                                                          | key absent            | `false`                        | equal        |
| multipleSelects, multipleRecordLinks, multipleAttachments, collaborators | key absent     | `[]`                           | equal        |
| number, percent, currency, rating, duration                       | `0.1 + 0.2` style noise | 15-significant-digit round    | equal        |
| date (date-only)                                                  | `2026-03-14`          | `2026-03-14T15:09:26.535Z`     | equal (by day) |
| dateTime                                                          | second-precision ISO  | millisecond ISO / `+00:00`     | equal (by second) |
| formula, rollup, lookup, count, created/modified time/by, autoNumber, button, aiText | any | any                   | structural (no canonicalizer) |

**Postgres / Supabase** (`pg-common/pg-field-value-canonicalizer.ts`), keyed on the column's
`x-scratch-connector-data-type`:

| `PostgresColumnType` | Underlying pg types                | Stored (pulled) value          | Sync writes                 | Must compare |
| -------------------- | ---------------------------------- | ------------------------------ | --------------------------- | ------------ |
| `TIMESTAMP`          | timestamptz, timestamp, date       | `2026-07-23T21:12:27.000Z`     | `…27Z` / `…27+00:00`        | equal (ms)   |
| `NUMERIC`            | float8, real, int                  | `0.30000000000000004`          | `0.3`                       | equal        |
| `NUMERIC_STRING`     | numeric, decimal, bigint (strings) | `"1.50"`                       | `1.5` / `"1.5"`             | equal (decimal text, never via float) |
| `JSONB`              | json, jsonb                        | re-serialised (key order, ws)  | source's JSON string/object | equal (parsed) |
| everything else      | text, bool, arrays                 | verbatim                       | verbatim                    | structural   |

## Layer 1 — Unit tests (done, automated in CI)

All four suites pass on this branch (82 tests):

```bash
cd server && npx jest \
  src/remote-service/connectors/library/airtable/__tests__/airtable-field-value-canonicalizer.spec.ts \
  src/remote-service/connectors/library/pg-common/__tests__/pg-field-value-canonicalizer.spec.ts \
  src/remote-service/connectors/__tests__/field-value-canonicalization.spec.ts \
  src/sync/__tests__/sync-execution.spec.ts
```

What they prove:

- The registry now resolves canonicalizers for `Service.AIRTABLE`, `Service.POSTGRES` and
  `Service.SUPABASE` (the "is NOT registered" assertions were flipped to positive assertions on
  the exact field set: Airtable → every writable column and nothing for computed columns or the
  `id`/`fields`/`createdTime` envelope; pg → `created_at`, `price`, `amount`, `payload`, `id` and
  nothing for `name`/`active`).
- Each drift class in the tables above compares equal, and a real value change or a clear compares
  different (`expectSame` / `expectDifferent` cases).
- `transformRecordAsync` keeps the stored value when canonically equal, replaces it wholesale
  otherwise, and still overlays when no canonicalizer is declared.

What they cannot prove: that the real pull schema carries the annotations the resolver keys on
(`x-scratch-connector-data-type`, `x-scratch-readonly`) for a live table, and that the whole
pull → sync → publish → pull loop converges. That is Layer 2.

## Layer 2 — Local end-to-end with the Live Export audit harness

The harness at `tools/live-export-audit/audit.mjs` drives the production sync-draft flow against a
local server and has a built-in steady-state check (`--second-run-check`) that reports how many
publish operations a second run with no source changes executed. That number is the metric: it was
23 for the Airtable-source round and 22 for the Supabase-source round in the Google Sheets
shakedown (see the two `LIVE_EXPORT_AUDIT.md` files), and both were attributed to the DEV-10556
family.

### Prerequisites

- Local stack up (`yarn dev`, Postgres + Redis via `server/localdev`, scratch-git).
- The flag on for the acting user (**no longer needed as of 2026-09-04** — the flag was removed and the
  canonicalizers are always on; the control runs below can no longer be reproduced by flipping it). If PostHog
  already evaluated `ENABLE_NOTION_FIELD_VALUE_CANONICALIZERS` true for you (it did for the 2026-09-01 runs, via local
  evaluation with the server's PostHog keys) nothing is needed. Otherwise force it in `server/.env`:

  ```
  FEATURE_FLAG_OVERRIDES_FOR_LOCAL_DEV=ENABLE_NOTION_FIELD_VALUE_CANONICALIZERS=true
  LOG_LEVEL=debug
  ```

  The override is comma-separated `KEY=true|false` pairs, beats PostHog, and is never honoured in
  production. Set it to `false` and restart the server for the control runs below. `LOG_LEVEL=debug`
  is needed to see the hook-resolution log line.

- Credentials under `local/audit-creds/` (gitignored, per worktree): `_spinner.env` with an API
  token minted from `POST /users/current/api-token`, plus `airtable.env` (`apiKey=`) and
  `supabase.env` (`connectionString=`). Run the harness with no arguments to get the preflight
  checklist. Use burner accounts; the harness creates and deletes real records.

### Test pairs

Use the standing torture data so results are comparable with the earlier audits:

| Pair | Source                                                        | Destination | Exercises                                                                                                                                                          |
| ---- | ------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A    | Supabase `fable_qa.{authors,types,bulk,author_bios}` (pooler project) | AIRTABLE    | Airtable absent-vs-empty on every nullable pg column, date-only vs timestamp columns, float noise on real/double columns                                            |
| B    | Airtable `fable_qa_at_*` (base `appGoopxI4Px4dyuv`, seeded by `seeds/airtable/seed.mjs`) | SUPABASE    | pg `TIMESTAMP` (dateTime → timestamptz, date → date), `NUMERIC` (plain number → double precision), `NUMERIC_STRING` (percent/currency/precision number → numeric) |

Pair B is the more informative one because the create-schema path in `pg-create-schema.ts` maps a
plain Airtable number to `double precision` (the `NUMERIC` canonicalizer) and percent, currency and
decimal numbers to `numeric` (the `NUMERIC_STRING` canonicalizer), so both numeric families fire on
one table. Note that create-schema never emits a `jsonb` column, so the `JSONB` canonicalizer only
gets Layer 1 coverage unless you point the harness at a pre-existing destination table with a
`jsonb` column (`--dest-connection` + `--tables`).

The Airtable seed includes an "All-empty invoice" record, which is the single best probe for the
absent-vs-empty class: every writable column of that record is absent on read and written as its
empty spelling by the sync.

### Procedure (per pair)

1. **Control run, flag OFF.** Establish the baseline churn.

   ```bash
   node tools/live-export-audit/audit.mjs --source SUPABASE --dest AIRTABLE \
     --second-run-check --report /tmp/audit-A-flag-off.json
   ```

   Record `secondRunCheck.verdict` from the report. Expect `NOT a no-op: N operations`. If N is
   already 0 the pair is not exercising any drift class and you need different torture data.

2. **Flip the flag ON**, restart the server, and rerun the same workbook without touching the
   source:

   ```bash
   node tools/live-export-audit/audit.mjs --workbook wkb_<from step 1> --rerun \
     --report /tmp/audit-A-flag-on.json
   ```

   Expect the publish step in the last run to show `createsExecuted + editsExecuted +
   deletesExecuted === 0`. Every remaining op is a residual to triage (step 6).

3. **Confirm the hook actually engaged.** In the server log, one debug line per table mapping:

   ```
   Destination AIRTABLE declares field-value canonicalizers for <N> field(s) of /<folder path>
   ```

   For pair B the service is `SUPABASE`. If the line is missing while the flag is on, the pull
   schema is not carrying `x-scratch-connector-data-type` for that table and the resolver returned
   nothing; inspect the folder's `schema.json` in the workbook repo before going further.

4. **Mutation pass (not over-eager).** Change one source value per drift class and rerun:

   - Airtable destination: a text, a checkbox, a multi-select, a date, a dateTime and a number
     on one record.
   - Supabase destination: a dateTime, a plain number, a percent or currency, and a date.

   ```bash
   node tools/live-export-audit/audit.mjs --workbook wkb_<id> --rerun --report /tmp/audit-A-mutate.json
   ```

   Expect exactly the edited records in `editsExecuted`, and confirm the new values through the
   destination's own API: `tools/live-export-audit/verify-supabase.mjs` for Supabase, the Airtable
   REST API for Airtable. Trust nothing you did not read back from the destination.

5. **Clear pass.** Set the same source fields to empty / NULL and rerun. Expect the same records to
   publish again, and on read-back: Airtable omits the key entirely, Supabase returns NULL. This is
   the case a too-loose canonicalizer would swallow (an empty template compared "equal" to a stale
   value).

6. **Steady-state again.** One more `--rerun` with no changes. Expect 0 ops.

7. **Residual triage.** Anything still publishing on unchanged data falls into one of three buckets:

   - A drift class listed in the tables above → a bug in the canonicalizer, fix it here.
   - A timestamp written into a `date` column that genuinely lost its time of day → DEV-11086,
     a schema problem the canonicalizer deliberately does not paper over.
   - A field the sync does not own changing on the source side (computed Airtable fields, a
     `modified_at` trigger on the pg table) → source instability, out of scope.

   Record the bucket and count per residual in the pair's `LIVE_EXPORT_AUDIT.md`.

## Layer 3 — Flag-off regression

With the override set back to `false`, rerun each pair's workbook once. The churn from step 1
should come back, proving the gate still holds and nothing leaks when the flag is off. Then run the
connector unit suites to make sure registration did not disturb anything else:

```bash
cd server && npx jest src/remote-service/connectors/library/airtable src/remote-service/connectors/library/pg-common \
  src/remote-service/connectors/library/postgres src/remote-service/connectors/library/supabase
```

## Layer 4 — Production rollout check

The flag is per-user in PostHog. Turn it on for one internal user who owns an existing Airtable
Live Export and an existing Supabase Live Export, let the routines run twice, and check:

- The routine run summary reads "completed" with zero publish operations on the second run.
- The read-only DB script (`terraform/tools/connect_to_gcp_db_readonly.sh production`) shows the
  publish run counts for that workbook dropping to zero on unchanged data.
- No `A field-value canonicalizer threw` warning in Cloud Logging for `spv1eu-production`. The
  warning is logged once per process, so its presence means a canonicalizer is falling back to
  structural compare for some field.

Enabling the flag for a user is a PostHog mutation and needs explicit sign-off; use the
`scratch-posthog` skill.

## Known caveats (expected, not failures)

- A Postgres/Supabase `date` column churns on every run when the server runs in a non-UTC
  timezone. The `pg-common` pull lets node-postgres parse the date OID into a JS Date at _local_
  midnight, so a PDT server stores `2026-05-01T07:00:00.000Z` for a source `2026-05-01`, and the
  millisecond-instant compare correctly says "different". On a UTC server the pull renders
  `T00:00:00.000Z` and it converges, which is why production is unaffected. This is a transport bug
  in the pull, not a canonicalizer bug, and a day-granular compare would not fix it either (a
  UTC-positive server lands on the previous UTC day). Fix is the pass-through date parser proposed
  as F1 in both `LIVE_EXPORT_AUDIT.md` files. Until then, local Layer 2 runs with a `date` column
  on the Postgres side show exactly that column churning and nothing else.
- A `date` column that receives a full timestamp genuinely loses the time of day and still diffs
  (DEV-11086, a schema problem).
- Canonicalizers are sync-only. The publish plan's `computeChangedFields` does not consult them, so
  a local edit that only differs canonically from `main` still publishes.
- Airtable multi-value order is preserved by Airtable, so a reordered link list is a real change
  and should diff.
- The `JSONB` family has only unit coverage unless a pre-existing jsonb destination column is used.

## Acceptance

- [x] Layer 1: the four unit suites pass with the positive registry assertions.
- [x] Layer 2 pair A (run 2026-09-01 as POSTGRES → AIRTABLE, workbook wkb_0EOrtJnfeI, see
      `library/postgres/LIVE_EXPORT_AUDIT.md`): second run and post-CRUD steady-state run both
      "No changes" with the flag on; CRUD and drift-restore passes verified via the Airtable REST
      API. The torture set carried `''`, `[]`, `false` and `0.30000000000000004`, all read back by
      Airtable as absent / `0.3`, and none churned.
- [x] Layer 2 pair B (run 2026-09-01 as AIRTABLE → POSTGRES, workbook wkb_1toKLoHtt9, see
      `library/airtable/LIVE_EXPORT_AUDIT.md`): `NUMERIC` (double precision), `TIMESTAMP`
      (timestamptz), boolean, text and uuid FK columns all converge; CRUD and drift-restore passes
      verified via psql. The one residual is the `date` column (212 of 213 invoices, isolated by
      the all-empty record and the CRUD-created record that has no `Due`), which is the F1 pull
      bug above, not a canonicalizer defect.
- [ ] Layer 3: flag-off rerun restores the control churn. Not run: the flag was already true for the
      acting user through PostHog local evaluation, so no flag-off control exists yet.
- [x] Residuals recorded per bucket in both `LIVE_EXPORT_AUDIT.md` files (F1 transport, F2
      transport, F3 view; none attributed to the canonicalizers).
- [ ] Layer 4: one internal user with both exports shows zero ops on the second run in production.
