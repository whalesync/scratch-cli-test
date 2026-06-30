---
name: audit-validation-noise
description: Audit a local Scratch workspace (a desktop-app workspace folder on disk) for noisy enforce_schema validation errors and decide, per connector, whether each failing shape is (a) stale-schema noise that clears on re-pull, (b) a still-live connector-schema false positive (the generated JSON schema is stricter than the verbatim value the service's API returns), or (c) genuinely bad data. Strictly READ-ONLY against the workspace — never edits/deletes workspace files, never runs the desktop app's pull/sync/publish, never pushes data back to Scratch or any connector. It queries the per-connection SQLite index (validation_results table), reads the on-disk schema.json + record files, reads the connector's TypeBox schema builder and its git history, and consults the connector's external API docs to confirm whether a verbatim value is legitimate. Produces a written diagnosis with counts, evidence, and recommended remediation. Use when a user reports validation noise / false-positive enforce_schema errors in a workspace, or asks to evaluate a workspace or a connector (Webflow, WordPress, Notion, Pipedrive, Airtable, …) for schema noise.
user-invocable: true
argument-hint: "[workspace-folder-path]"
---

# Audit a Scratch workspace for `enforce_schema` validation noise

Evaluate a local Scratch **desktop** workspace (a folder on disk) for noisy `enforce_schema`
validation errors and classify each failing shape. The desktop workspace is a local clone of the
user's data; auditing it on disk does **not** touch the production Scratch system. The deliverable is
a written diagnosis (use [report-template.md](report-template.md)) — and, only if the user then asks,
a connector-schema fix in the repo.

## Read-only — hard rules (do not violate)

These are non-negotiable. The user is trusting this skill not to disturb their data.

1. **Never modify, create, rename, or delete any file inside the workspace folder.** Treat it as
   immutable. Open every SQLite index in **immutable** mode (see
   [Opening the SQLite indices](#opening-the-sqlite-indices-read-this-first) — plain `-readonly`
   does **not** work on these workspace DBs). Only ever run `SELECT`/`.tables`/`.schema` — never
   `INSERT`/`UPDATE`/`DELETE`/`DROP`/`PRAGMA writes`.
2. **Never push data back.** Do not run the desktop app, `scratchmd` write/sync verbs, or anything
   that pulls, syncs, publishes, accepts, rejects, or otherwise writes to Scratch or a connector's
   external service. No connector API **writes** either — API docs are for **reading**, and you may
   only **GET** to confirm a value's shape if asked, never POST/PUT/PATCH/DELETE.
3. **Do not interact with the production Scratch system.** Everything you need is the on-disk
   workspace + the connector source in this repo + public API docs.
4. **Repo code is the only thing you may edit — and only when the user explicitly asks for fixes
   after seeing the diagnosis.** Fixes go in the connector's schema builder + a regression test
   (see [Optional: propose fixes](#optional--propose-connector-schema-fixes)); they **never** touch
   the workspace data. Default outcome of this skill is a diagnosis, not a code change.

## Step 0 — get the workspace folder

If the path wasn't given as an argument, **ask the user** for the workspace folder (the desktop app's
workspace directory, e.g. `~/Documents/ScratchWorkspaces…/<name>` — note the path often contains
spaces, so always quote it). Confirm it exists and contains both `.repos/` and `.scratch/`. If
either is missing, it isn't a desktop workspace root — ask for the correct folder.

## Opening the SQLite indices (read this first)

**`sqlite3 -readonly "<db>" …` does NOT work on these workspace DBs** — it fails with
`Error: unable to open database file`, even after copying the `.db` to a writable temp dir. The
desktop app leaves the index in a state where SQLite still wants to touch lock/journal/WAL sidecars
or a temp dir on open, and `-readonly` doesn't fully suppress that.

**Use the `immutable=1` URI instead** — it opens the file with zero side effects (no lock, no journal,
no sidecar creation), which is exactly what we want for a strictly read-only audit:

```bash
sqlite3 "file:<absolute-db-path>?immutable=1" ".tables"
sqlite3 "file:<absolute-db-path>?immutable=1" "SELECT … ;"
```

Practical tips:

- **Quote the whole `file:…` argument** — workspace paths contain spaces. The URI needs an absolute
  path; relative paths plus a `cd` into a space-containing dir are fragile (the shell `cwd` may reset
  between calls). Prefer a variable: `WS="/abs/path/with spaces"; sqlite3 "file:$WS/.repos/X.db?immutable=1" …`.
- `immutable=1` tells SQLite the file will not change while open. That holds for an audit (you never
  write), and it's safe even if the desktop app is running — you get a consistent read of the file as
  it is on disk.
- Still only ever run `SELECT` / `.tables` / `.schema`. `immutable=1` is about *how* you open, not a
  license to mutate.
- A small helper keeps the rest of the steps clean:
  `q() { sqlite3 "file:$WS/.repos/$1.db?immutable=1" "$2"; }` then `q Notion ".tables"`.

Every query example in the steps below assumes this `q()` helper (or the inline `file:…?immutable=1`
URI). If you ever see `Error: unable to open database file`, you've reverted to plain `-readonly` —
switch back to the URI form.

## Step 1 — locate the stored validation results

Validation results are stored per connection, computed by the same validator the desktop app shows.

- Each connection is a SQLite index at `<workspace>/.repos/<Connection Name>.db`. List them:
  `ls "<workspace>/.repos/"`. The connection name is the `.db` basename (also the first segment of
  every `folder_path`).
- Find the results table — **its name varies by desktop build**: `validation_results__v4`,
  `validation_results_v1`, … This vintage matters (an old build can be the whole story; see Step 4).
  ```
  sqlite3 "file:<db>?immutable=1" ".tables"
  sqlite3 "file:<db>?immutable=1" ".schema <that table>"     # confirm columns
  ```
  Columns are typically: `folder_path, filename, field_path, validator_kind, level, message,
  description, fixable`. Confirm the distinct `validator_kind` and `level` values present.

## Step 2 — aggregate the noise per connection (don't dump rows)

A clean record produces **no** rows, so the table is only the failures. Use aggregates:

```
# uses the q() helper from "Opening the SQLite indices": q() { sqlite3 "file:$WS/.repos/$1.db?immutable=1" "$2"; }
# totals by level
q <Connection> "SELECT level, COUNT(*) FROM <table> WHERE validator_kind='enforce_schema' GROUP BY level;"
# top failing shapes
q <Connection> "SELECT field_path, level, substr(message,1,160) m, COUNT(*) c FROM <table> WHERE validator_kind='enforce_schema' GROUP BY field_path, m, level ORDER BY c DESC LIMIT 50;"
# distribution across tables
q <Connection> "SELECT folder_path, COUNT(*) FROM <table> WHERE validator_kind='enforce_schema' GROUP BY folder_path ORDER BY 2 DESC;"
```

Report real counts. `level=error` = JSON-schema / required / format failures; `level=warning` =
read-only / write-once (these only fire on edits vs `main`, so they're a different class — note but
usually don't chase). For a large workspace, **fan out**: launch one read-only **Explore** subagent
per connection (and one to read the connector code), each told the hard rules above.

## Step 3 — gather evidence per top failing shape

For each of the top ~8–12 distinct shapes (by count):

1. Find a representative failing record (using the `immutable=1` URI / `q()` helper from
   [Opening the SQLite indices](#opening-the-sqlite-indices-read-this-first)):
   `q <Connection> "SELECT folder_path, filename FROM <table> WHERE validator_kind='enforce_schema' AND field_path='<fp>' LIMIT 1;"`
2. **Read the verbatim value** at that `field_path`. Record files live at
   `<workspace>/<folder_path>/<filename>` (discover the exact layout — it can vary). Quote the real
   value: is it `null`, `""`, an object, an array, a number, a string like `"NA"`? This is the
   ground truth.
3. **Read the schema fragment that rejects it.** The schema each record is validated against lives at
   `<workspace>/.scratch/connections/scratch/<folder_path>/schema.json`. Extract the constraint on
   that `field_path` and the schema's **`generatedAt`** timestamp (a workspace can hold a *mix* of
   schema vintages). A quick extractor:
   ```
   python3 -c "import json,sys; s=json.load(open(sys.argv[1])); print(s.get('generatedAt')); import json as j; j.dump((s.get('schema') or s).get('properties',{}).get(sys.argv[2]), sys.stdout, indent=2)" "<schema.json>" "<top-level-field>"
   ```

> The error's stored `message` is usually the **failing instance** followed by the failing keyword.
> Watch for a mismatch between `field_path` and the instance: when a blank/odd leaf sits inside an
> object wrapped in an `anyOf`, the failure bubbles up and is reported against the **whole parent
> object** at the parent `field_path` — so read the message, not just the path, to find the real
> offending leaf. (This nuance is the subject of follow-up DEV-10540.)

## Step 4 — classify each shape (the core judgement)

For each shape, walk this decision tree. Use the connector's **external API documentation**
(WebSearch / WebFetch the service's REST/GraphQL docs) to settle "is this value legitimate?".

1. **Is the verbatim value what the service's API legitimately returns?** (Check the API docs and the
   record itself.)
   - **No — it's genuinely malformed / bad data** → a *real* validation issue. Surface it to the
     user; do **not** recommend loosening the schema to hide it. (Per product principle: *surface
     failures; never silently succeed.*)
   - **Yes** → it's a **false positive**. Continue.
2. **Is the on-disk schema stale?** Compare its `generatedAt` to the connector's schema-fix history:
   `git -C <repo-root> log --oneline -15 -- server/src/remote-service/connectors/library/<connector>/<connector>-json-schema.ts`
   (and `git show`/`git log -p` to see whether a commit *after* `generatedAt` already handles this
   shape).
   - **Stale** (schema predates a fix already on `master`) → **stale-schema noise**; it clears on a
     fresh **re-pull** once the server carrying that fix is deployed. No new code needed.
   - **Current** (schema is post-fix vintage, yet still flags) → a **still-live connector-schema
     bug**: the generated schema is stricter than the verbatim shape. Recommend a connector-schema
     fix (Step 5 / Optional fixes).
3. **Cross-check the validator itself** (`scratch-git-2/src/shared/validators/builtin.rs` →
   `enforce_schema`). Current behavior to confirm against live code (line numbers drift — grep, don't
   trust offsets): formats **are** asserted (`should_validate_formats(true)`); a top-level empty
   string `""` is **exempt**; a top-level `null` is **skipped**; required-but-nullable fields aren't
   flagged. If the failing value is a top-level `""`/`null` yet still shows as a row, the **desktop
   build is old** (e.g. table is `validation_results__v4` while current code writes a newer table) —
   updating the desktop binary clears it with no schema change.

### Known noise patterns & worked examples (start here — most noise is one of these)

- **Verbatim shape the schema didn't anticipate** → connector-schema bug. E.g. **Pipedrive** empty
  multi-option `set` returns `null` vs a non-nullable array; **Webflow** `VideoLink` returns an oEmbed
  **object** `{url, metadata}` not a `format:'uri'` string; **WordPress** ACF empty *number* fields
  return `""` (ACF's unset sentinel) against a `number|null` type.
- **Over-strict `format` assertion on free-text** → connector-schema bug. E.g. **Notion** `email`/
  `url` properties hold free text ("NA", "tbc", schemeless URLs) that the service accepts but
  `format:'email'`/`format:'uri'` rejects.
- **Stale schema, already fixed on `master`** → clears on re-pull. E.g. **Notion** old icon/date
  shapes.
- **Nested blank escaping the top-level `""`/`null` skip** (a blank inside an `anyOf`-wrapped object) →
  worked around per-connector today; general validator fix tracked in **DEV-10540**.

## Step 5 — write the diagnosis

Fill in [report-template.md](report-template.md): per connection — table vintage, total error/warning
counts, a top-shapes table, per-shape evidence (verbatim value + schema fragment + `generatedAt` +
API-doc citation), the **classification** for each, and **recommended remediation** (re-pull / update
desktop build / connector-schema fix + regression test / fix bad data). State plainly that the audit
was read-only and nothing was changed.

Present the diagnosis inline. Offer to save a copy to the **repo's** `.context/` (gitignored) as
`.context/validation-noise-<workspace-slug>-<date>.md` — **never** write the report into the user's
workspace folder.

## Optional — propose connector-schema fixes

Only if the user asks after seeing the diagnosis. Fixes belong in the connector's TypeBox schema
builder (`server/src/remote-service/connectors/library/<connector>/<connector>-json-schema.ts`), not
in the frontends and not in the workspace data. Principles:

- **Preserve external data fidelity** — make the schema accept the verbatim value; never reshape the
  data to fit the schema. Loosen the type / add the nullable or blank member / model the real object
  shape.
- **Add a regression test** in the connector's `__tests__/<connector>-json-schema.spec.ts` that feeds
  the exact failing verbatim shape through the generated schema and asserts it validates (and that a
  genuinely-wrong value still fails). These specs are behavior-based — see the Webflow/WordPress ones
  for the pattern.
- Verify with targeted tests + checks (this repo needs **Node 22** — `nvm use`; if nvm's env is
  broken in a worktree, prepend an installed `~/.nvm/versions/node/v22*/bin` to `PATH`):
  `yarn jest <connector>-json-schema`, then `yarn typecheck`, `yarn lint` + `yarn prettier:check` on
  the changed files.
- A landed connector-schema fix only clears the workspace's errors after the connection is
  **re-pulled** (which regenerates the on-disk schema) on a server carrying the fix.

## Reference

- Validator: `scratch-git-2/src/shared/validators/builtin.rs` (`enforce_schema`).
- Connector schema builders (TypeBox): `…/library/<connector>/<connector>-json-schema.ts`; quirks are
  recorded in each connector's `STATE.md`.
- Product principles (why we accept verbatim shapes): repo root `CLAUDE.md` → *Preserve external data
  fidelity*, *Surface failures; never silently succeed*.
