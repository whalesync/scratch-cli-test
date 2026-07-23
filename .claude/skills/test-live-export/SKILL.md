---
name: test-live-export
description: Audit ONE Live Export source service end-to-end against one or more real destinations — `/test-live-export <source> <dest1>[,<dest2>…]` (e.g. `/test-live-export HUBSPOT AIRTABLE,SUPABASE`). Drives the production sync-draft flow headlessly via tools/live-export-audit/audit.mjs against the LOCAL spinner server, seeds torture data ONCE through the source service's own API, then loops the destinations sequentially (one workbook each), verifies published data on each destination's own API, runs CRUD + steady-state passes, and triages every finding to the LAYER that owns the fix (default View vs connector transport vs shared transform picker vs destination pack vs core engine) — using cross-destination reproduction as the [dest-pack]-vs-upstream discriminator. Files Linear issues in the [MAJOR] Live Export project with the `live-export-qa` label. Preflights all secrets/servers UP FRONT for EVERY requested destination and stops with an explicit checklist if anything is missing, so it can run unsupervised. Resumable per source service via server/src/remote-service/connectors/library/<source>/LIVE_EXPORT_AUDIT.md.
user-invocable: true
---

# test-live-export — source-service launch audit

Audits one **source** connector for Live Export readiness by exporting real (torture) data to
one or more vanilla **destinations** and interrogating every seam: schema plan, publish, CRUD
mirroring, steady-state. `/test-live-export <SOURCE> <DEST1>[,<DEST2>…]` — service names are the
connector enum values (`AIRTABLE`, `HUBSPOT`, `POSTGRES`, `NOTION`, `SHOPIFY`, …).

**Destinations run sequentially in one invocation**, reusing the same seeds and source
connection; each gets its own workbook and its own section in the audit doc. Two well-chosen
destinations beat one: pair a **wide-typed** destination (AIRTABLE or NOTION — selects,
multi-values, rich text packing) with a **narrow/relational** one (SUPABASE or POSTGRES — scalar
columns, real FK constraints, multi→single collapse). Besides coverage, the second destination is
your best triage instrument (see Phase 5): a failure that reproduces on both destinations is not
a destination bug. When running many source audits in parallel (one workspace per source), the
sequential destination loop also naturally staggers load on shared destination accounts.

**Source of truth = the audit doc** `server/src/remote-service/connectors/library/<source>/LIVE_EXPORT_AUDIT.md`
(create from [audit-template.md](audit-template.md) on first run). Read it first; resume from the
first unchecked gate. One doc per source; destination-specific results live in per-destination
sections inside it.

**Prime directive (same as /connector-build-execute): trust nothing you didn't confirm against the
destination service's own API.** "Routine run completed" is not proof — runs report `completed`
even when every record was rejected. Read the publish step's `failedOperations` and then read the
data back from the destination service directly.

## Phase 0 — Preflight. ALL-OR-NOTHING, before any work.

Run the harness preflight first — it checks everything and prints a fix-it checklist:

```bash
node tools/live-export-audit/audit.mjs --source <SOURCE> --dest <DEST> --no-run --max-tables 0 --report /tmp/preflight.json
```

Requirements it enforces (echo this checklist to the user if anything is missing, then STOP —
do not begin a half-configured run):

1. **Local spinner server** on `http://localhost:3010` (or `SPINNER_API_URL`).
2. **API token** in `local/audit-creds/_spinner.env` → `SPINNER_API_TOKEN=...` (mint via
   `POST /users/current/api-token`, or copy a USER token from the local scratchpaper DB's
   `"APIToken"` table). `local/` is gitignored — credentials never land in git or in this doc.
3. **Source credentials** in `local/audit-creds/<source>.env`, keys named exactly after the
   connector's `userProvidedParams` (the preflight prints the required field names from
   `GET /connectors/metadata` when the file is missing). **Burner account only** — this skill
   creates, edits, and DELETES records on the source, and writes freely to the destination.
4. **Destination credentials** for EVERY requested destination (`local/audit-creds/<dest>.env`) —
   check them all up front, not lazily at each loop iteration, so an unattended run can't die at
   destination #2. For Notion add `DEST_PARENT_ID=<page id>` — a dedicated QA parent page shared
   with the integration.
5. **OAuth-only sources** (no user-provided credential fields): the harness cannot mint an OAuth
   session. Tell the user to connect the service ONCE through local dusky
   (`localhost:3030/exports` → new export → connect the source), then re-invoke with
   `--workbook <wkb_…> --source-connection <coa_…>` so the audit adopts that workbook's
   connection. Say this explicitly and stop; it is the one human step this skill cannot absorb.
6. **Linear MCP** available (for filing). If not, still run the audit; findings queue in the
   audit doc with a `⚠ not yet filed` marker.

## Phase 1 — Recon (read, don't run)

- Read the source connector: `server/src/remote-service/connectors/library/<source>/`
  (`<source>-connector.ts`, `<source>-json-schema.ts`, `<source>-default-view.ts`, `STATE.md` if
  present). Note: how types are declared, which fields the View hides/renames, how FKs are
  expanded, what the connector's own docs warn about.
- List tables via the harness's `availableTables` (or `GET .../connections/:id/tables`). Pick the
  tables that maximize *type coverage*, not record count. Record the choice + reason in the audit doc.

## Phase 2 — Seed torture data (via the source service's public API)

Seed a dedicated table/object set named `fable_qa_*` (idempotent — re-runs update, not duplicate).
Cover every value class the service supports:

- **Every field type the service offers** — one column each (consult recon; for dynamic-schema
  services create the fields via API where possible).
- nulls / empty strings / unset — one all-empty record.
- Unicode: emoji, CJK, RTL, zero-width; newlines/tabs/quotes/HTML entities.
- Long text: >2000 chars and >4000 chars (destination caps), plus a boundary value (2001).
- Numbers: 0, negatives, >2^53 integers, high-precision decimals, currency, percent.
- Dates: date-only, datetime with seconds + sub-second, extreme past/future, TZ-sensitive values.
- Arrays/multi-values: 0, 1, and 3+ elements; elements containing commas/quotes.
- **Foreign keys / associations**: at least two linked tables with links in both directions,
  plus a link pointing at a record that is NOT in the export.
- Rich text: headings, bold/italic, links, lists, an image, a code block (drives MD/HTML checks).
- 200+ records in one table (forces pagination).

Persist the seeding script under `tools/live-export-audit/seeds/<source>/` so later runs and the
review skill can re-seed identically. Verify seeds by reading them back via the service API.

## Phase 3 — Run the harness, once per destination

For each destination, in order:

```bash
node tools/live-export-audit/audit.mjs --source <SOURCE> --dest <DEST_N> \
  --tables <torture tables> --second-run-check --report /tmp/audit-<source>-<dest_n>.json
```

Each invocation creates its own workbook (record all of them in the audit doc). The report gives
you, per table: the create-plan **notes** (every downgraded field + reason), the field list with
kinds, dropped FKs, **sampled raw pulled values** per field, publish counts, every per-record
`failedOperation`, and the second-run no-op verdict. The pull/plan-side signal (downgrades, sample
values, dropped FKs) is destination-independent — judge it once, on the first destination; on
later destinations only diff what changed (created types, publish behavior).

Then **verify on each destination's side directly** (that service's API, not our own pull): pick
≥3 records per table — the all-empty one, the unicode/long-text one, a linked one — and
field-by-field compare destination values against the source. Notion truncates seconds and
normalizes rich_text spans; those are destination limitations, not bugs.

## Phase 4 — CRUD + drift passes

Do ONE round of source-side edits via the **source service's API** — edit 2 records (one touching
a long-text field), create 1, delete 1 — then replay it into every destination workbook:

```bash
node tools/live-export-audit/audit.mjs --workbook <wkb_dest_n> --rerun --report /tmp/crud-<dest_n>.json
```

Verify on each destination: edits applied, create appeared, delete mirrored. Then a
destination-side drift check per destination: archive/delete one destination record out-of-band,
re-run, confirm the engine restores it (or fails loudly — record which).

## Phase 5 — Triage: name the layer before you name the bug

This is the part that keeps the codebase healthy. **Every finding gets a layer, and the layer
decides where the fix goes.** The most common failure mode of this process is misfiling a
default-View gap as a core-engine bug — or worse, "fixing" the engine for one service's quirk.

**Use the destinations as a differential first.** With two or more destinations audited, every
publish-side finding gets a free experiment before any code reading:

- Fails on **exactly one** destination → `[dest-pack]` (or a destination-specific transformer).
- Reproduces on **two+** destinations → NOT the destination connector; look upstream — wrong/vague
  declaration (`[view]`), missing coercion (`[picker]`), or engine behavior (`[core]`).
- Wrong **at pull** (bad sampled value in the report) → upstream of all destinations by
  definition: `[transport]` or `[view]`.

Record the differential result in the issue ("fails Notion only; Airtable/Supabase clean").

| Layer | Owns | Tell-tale signals | Fix lives in |
|---|---|---|---|
| **`[view]` Default View** | *Editorialization*: which columns exist, display names, semantic types (`TablePropertyType`), codecs that pluck useful inner values, FK identification, hiding plumbing columns | Field downgraded with "Don't recognize … field type" / "Can't unpack"; samples show a useful inner value inside an object (`{text: "ABC"}` → want `.text`); FK not offered as foreignKey; number/date typed as text; junk columns users don't care about | `library/<source>/<source>-default-view.ts` (type map, codec, FK expansion). Per-service, low blast radius. **Most findings land here.** |
| **`[transport]` Connector pull/auth** | Faithful raw storage, schema annotations (`format: date-time`, readonly, last-modified), pagination, incremental pull, delete detection, auth + credential metadata (labels/placeholders) | Values missing or wrong AT PULL (check the pulled file, not the destination); pagination stops at a page boundary; source deletes never detected; TZ shifts introduced during pull; connection test fails; bad API-key placeholder text | `library/<source>/<source>-connector.ts`, `<source>-json-schema.ts`, connector metadata |
| **`[picker]` Shared transform picker** | Generic coercion between declared source type and destination pack (`auto_convert`, cardinality reshape) | Publish rejected on a type mismatch even though the View declares the right type AND the raw value is right; the identical failure reproduces from a *second* source service | `packages/shared-types/src/transform-picker.ts`. **High blast radius — file, do not fix in passing.** Check the known-issues list below first; it is probably already filed. |
| **`[dest-pack]` Destination connector** | Property envelope shapes, service caps (rich_text 2000), relation packing, created property types | Destination API validation errors on correctly-typed values; cap overflows; failure is identical regardless of source | `library/<dest>/` (e.g. `notion-json-schema.ts` pack transformers, `notion-write-validation.ts`) |
| **`[transformer]` Custom transformers** | Rich text and complex format conversion (MD **and** HTML), service-specific value surgery beyond built-ins | Value arrives but is useless: raw HTML in a plain-text column, delta/AST JSON, concatenated garbage | `server/src/sync/transformers/implementations/` + the View wiring that selects it |
| **`[core]` Sync/publish engine** | Diffing, record matching, FK resolution phase, delete mirroring, pending-publish lifecycle, routine orchestration | Wrong operation planned (edit for a new record); second run is not a no-op; records permanently wedged/refailing; cascade failures through relations | `server/src/sync/`, `server/src/publish-plan/`, `server/src/sync-draft/`. **Suspect the View first**; core bugs must reproduce with a correctly-described source. |

Rules of thumb:

- The View is **product judgment, not plumbing**: "this column should be a number", "pluck
  `.text`", "hide `hs_` plumbing" are editorial decisions that belong next to the connector — a
  fix there can't break the other 20 services. If your proposed fix touches shared code, you need
  the same failure from **two different source services** (or a maintainer's blessing) before it's
  allowed to be `[picker]`/`[core]`.
- A downgraded field is a **finding only when the data shows we could do better** (a plausible
  inner value to pluck, a declarable type). "Unknown exotic type synced as text, and text is the
  honest representation" is a PASS — note it as accepted, don't file it.
- Judge downgrades by **looking at the sampled values**, then propose the concrete View change
  (type-map entry / codec / FK expansion), with the sample as evidence.

**Known generic issues — check before filing (do not re-file per service; comment your evidence
on the existing issue instead):** DEV-10952/DEV-10953 (picker: missing coercion into text/number
packs), DEV-10955 (Notion 2000-char split on the edit path), DEV-10956 (multi→single collapse
takes first element), DEV-10954 ({ref} FK targets skip resolution; relation cascade failures),
DEV-10556 (republish churn / second run not a no-op), DEV-10957 (archived destination pages),
DEV-10959 (dotted column names break save), DEV-10960 (out-of-range dates), DEV-10962
(rejected records refail forever; runs read "completed"). Also search Linear for label
`live-export-qa` before filing anything.

## Phase 6 — File issues (Linear)

Every confirmed finding, one issue each:

- **Team** `Dev`, **project** `[MAJOR] Live Export`, **label** `live-export-qa` (create the label
  if it doesn't exist), **parent**: the per-service umbrella issue `Live Export QA: <SOURCE>
  source` (create it under the project on first run; put its id in the audit doc).
- **Title**: `[<SOURCE>→<DEST>][<layer>] <one-line defect>` — e.g.
  `[HUBSPOT→AIRTABLE][view] deal amount declared as text, should be number`.
- **Body must contain**: the layer + the file where the fix most likely lives; repro ids
  (workbook, sync, routine-run); the exact error or a source-value → destination-value pair as
  evidence; for `[view]` findings, the proposed editorial change. Never paste credentials.
- **Priority rubric**: Urgent = records rejected or data corrupted on the happy path. High =
  silent data loss or permanently wedged records. Medium = fidelity downgrades that carry a
  planning warning, View improvements. Low = observability/UX.

## Phase 7 — Close out the audit doc

Update `LIVE_EXPORT_AUDIT.md`: gates checked with evidence ids, per-destination results section,
findings table (issue links), accepted-downgrades list, and the **explicitly-human remainder**:

- OAuth connect flow in the real UI (if applicable)
- One full wizard pass in local dusky (`localhost:3030/exports`): credential placeholder text,
  field-picker warnings match the plan notes, run from the UI
- Judgment sign-off on the proposed View changes

End your run by printing the gate summary (per destination) and the human-remainder list. A
source is launch-ready only when `/review-live-export <source> <dests>` returns PASS on this doc —
the reviewer re-proves every destination section, not just one.
