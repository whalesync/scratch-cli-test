# DEV-10453 — Finding 3: enforce_schema floods verbatim records with false-positive errors (handoff)

- **Status:** In Progress
- **Author:** Chris Hoefgen
- **Created:** 2026-06-17
- **Linear:** [DEV-10453](https://linear.app/whalesync/issue/DEV-10453)

> **Purpose.** Self-contained handoff for a fresh session investigating **finding 3** — the validation
> *noise* problem. It records (a) the full root-cause chain behind "no validation warnings in desktop"
> and the three fixes already applied this session, and (b) the finding-3 decision space with evidence
> and exact code pointers. Read the companion doc
> [`2026-06-17-dev-10453-pipedrive-readonly-validation.md`](2026-06-17-dev-10453-pipedrive-readonly-validation.md)
> for the original problem, branches, and the seed/validation architecture.

## TL;DR

- While testing the desktop app, editing a read-only Pipedrive field (`person_id → 99`) directly on
  disk produced **no validation warning**. Root-causing revealed **three stacked bugs**; all three are
  now **fixed** (changes uncommitted on branch `dev-10453-desktop-default-validation`).
- The keystone bug (**#3**): `enforce_schema` was **inert in production** — the desktop's index/grid
  validation path passed `None` for the schema, so the validator returned **zero** problems on every
  record. The CLI `dry-run` passed the real schema, which is why dry-run "worked" but the app didn't.
- With that fixed, the read-only warning now surfaces — **but so does a flood of false-positive errors**
  (143 on one 9-record Activities folder). That is **finding 3**, and it is now **live workspace-wide**
  for every seeded connection. The remaining work is deciding how to handle that noise. No code beyond
  the three fixes has been written for finding 3.

## What was actually broken (the three-bug chain)

The desktop chain to show a read-only warning is: **seed `enforce_schema` into the folder → run
validators → populate the `validation_results` table → panel/grid render it.** Three independent
breaks, each masking the next:

| # | Bug | Root cause | Fix (this session) | Verified |
|---|-----|-----------|--------------------|----------|
| 1 | Validator never seeded into Pipedrive | Seeder runs only on mount + connection-change pull, via a one-shot `listFolders` snapshot. Pipedrive was pulled *after* the mount-time seed (a focus-sync / non-seeding pull path), so it was missed. Only the four Pipedrive folders lacked `validation.json`; every other connection had it. | Seed after **every** pull at the main-process choke point `scratch:pull-workspace-changes` ([index.ts](../../scratch-desktop/src/main/index.ts)). | ✅ app re-seeded Pipedrive at runtime once present |
| 2 | Seeding doesn't populate the cached problems table | `validation.json` is just config; the `validation_results` table that powers the panel/sidebar is only filled by an explicit validate run (`index refresh-folder --validate`). | After seeding, revalidate **only the newly-seeded folders** via a new `refreshFolderIndex(..., {validate:true})` wrapper ([scratchmd.ts](../../scratch-desktop/src/main/scratchmd.ts)); helper `seedSchemaValidatorsAndPopulateProblems` in [index.ts](../../scratch-desktop/src/main/index.ts). Steady-state no-op. | ✅ (mechanism) |
| 3 | **`enforce_schema` produced 0 problems in the real app** | The production validate path `validate_page_records` called `run_validators_dry(..., None, ...)` — **schema = `None`**. `enforce_schema` then hits its `ctx.schema.get("schema")` guard and returns empty. dry-run passed the real schema → 16 problems; production → 0. | Load the folder `schema.json` (sibling of `validation.json`) and pass it to the validator ([folder_index.rs:~1832](../../scratch-git-2/src/shared/folder_index.rs#L1832)). | ✅ 9 read-only warnings now emitted |

### Exact changes applied this session (uncommitted)

- **`scratch-git-2/src/shared/folder_index.rs`** — in `validate_page_records`, load
  `folder_schema` from `validation_json_path.with_file_name("schema.json")` and pass
  `folder_schema.as_ref()` to `run_validators_dry` instead of `None`. **This is the keystone fix.**
  All three production validate entrypoints (`paginate-records --validate`, `index refresh-folder
  --validate`, `validate_files`) funnel through this one call. `cargo fmt`/`build` clean; `cargo test
  --lib validators` (64) + `folder_index` (46) pass.
- **`scratch-desktop/src/main/index.ts`** — seed-after-pull in `scratch:pull-workspace-changes`;
  new helper `seedSchemaValidatorsAndPopulateProblems` (seed → revalidate newly-seeded folders);
  `files:ensure-schema-validator-seeded` wrapped in `withWorkspaceInternalMutation` and routed through
  the helper; import `refreshFolderIndex`.
- **`scratch-desktop/src/main/scratchmd.ts`** — new `refreshFolderIndex(workspacePath, folder,
  {validate?})` wrapping `index refresh-folder [--validate]`.
- **`scratch-desktop/src/preload/index.ts` + `index.d.ts`** — `ensureSchemaValidatorSeeded` return type
  `Promise<Array<…>>` → `Promise<void>` (handler now returns void; renderer only fire-and-forgets).
- Desktop `yarn lint` / `yarn build` / seeder tests (5) all pass.

> ⚠️ **The desktop app must use the rebuilt `scratchmd`** for fix #3 to take effect. The app resolves a
> bundled/installed binary, **not** `target/debug`. `cargo build --bin scratchmd` was run; a `yarn dev`
> run picks up `target/debug`, a packaged app needs a re-bundle. See
> [`scratch-desktop/src/main/scratchmd.ts:~234`](../../scratch-desktop/src/main/scratchmd.ts#L234).

## Finding 3 — the problem to solve

With #3 fixed, validating one **untouched-shape, verbatim** Pipedrive Activities folder (9 records)
yields **152 problems: 143 errors + 9 warnings.** The 9 warnings are the *desired* output (the
read-only `person_id` edit). The 143 errors are **false positives on data we intentionally store
verbatim**, and they bury the signal. This violates the product principle *"preserve external data
fidelity / adapt the schema to the data."* It is now live for **every** seeded connection (validation
is default-on and `enforce_schema` is auto-seeded everywhere).

### Evidence (reproducible)

`enforce_schema` runs three checks (see [builtin.rs:118-280](../../scratch-git-2/src/shared/validators/builtin.rs#L118)).
On a single verbatim Activities record the error sources are:

- **`required` (the bulk):** the Activities schema marks **27 fields required** — effectively *every*
  field. A verbatim record legitimately leaves ~12 of them `null`/absent (`marked_as_done_time`,
  `due_time`, `duration`, `note`, `location`, `lead_id`, `project_id`, `priority`, `attendees`,
  `conference_meeting_{client,id,url}`). `enforce_schema`'s required check treats null/absent/empty as
  "missing" → ~12 errors/record.
- **`format: date` vs date-time:** `add_time`/`update_time` are typed `format: 'date'` but hold
  datetime values like `"2026-06-04T14:14:02Z"` → 2 anyOf errors/record.
- **`participants` anyOf:** the stored shape `[{person_id, primary}]` fails the schema's anyOf → 1/record.

≈16 errors × 9 records ≈ 143.

### Root cause of the noise (where the strictness comes from)

The Pipedrive schema is built with TypeBox in
[`pipedrive-json-schema.ts`](../../server/src/remote-service/connectors/library/pipedrive/pipedrive-json-schema.ts):

- **Everything is required.** Fields are emitted as non-`Optional` `Type.Union([..., Type.Null()])`
  inside a `Type.Object`, so TypeBox puts **all** of them in the schema's `required` array. Nothing
  derives "required" from Pipedrive's own mandatory-field metadata.
- **Date typing.** `case 'date'` → `Type.String({ format: 'date' })`
  ([pipedrive-json-schema.ts:59-60](../../server/src/remote-service/connectors/library/pipedrive/pipedrive-json-schema.ts#L59));
  there is no date-time case, so datetime-valued system fields fail `format: date`.

This is **pre-existing latent strictness** — it never mattered because `enforce_schema` never ran on
these records (bug #3). Turning validation on by default + auto-seeding `enforce_schema` + fixing #3 is
what surfaces it. Other connectors with verbatim records likely have the same latent problem.

> **Confirmed in another connector — fixed 2026-06-17.** The Postgres-based connectors (Supabase + the
> generic Postgres connector, which share `pg-common`) had the same date-vs-date-time mismatch: a
> Postgres `date` column was typed `format: 'date'`, but the `node-postgres` driver parses the `date`
> OID (1082) into a JS `Date`, which serializes to a full RFC 3339 date-time on disk
> (e.g. `"1944-11-19T00:00:00.000Z"`), never `YYYY-MM-DD`. So every verbatim row failed the `anyOf` — one
> error per record on every `date` column. Fixed in
> [`pg-type-mapping.ts`](../../server/src/remote-service/connectors/library/pg-common/pg-type-mapping.ts)
> by mapping `PG_DATE_TYPES` to `format: 'date-time'` (display is unaffected — both `date` and `timestamp`
> already share `pgType: TIMESTAMP`, which the view renders as a date column). Tests in
> [`pg-type-mapping.spec.ts`](../../server/src/remote-service/connectors/library/pg-common/__tests__/pg-type-mapping.spec.ts).
> Like the Pipedrive fix, the live workspace needs a **re-pull** to regenerate `schema.json` before the
> errors clear.

### Worked example — the `add_time` / date-time `anyOf` error

A representative noise error:

> `"2026-06-04T14:14:02Z" is not valid under any of the schemas listed in the 'anyOf' keyword` — field `add_time`

Mechanics:

- `add_time`'s schema is `{ "anyOf": [ { "type": "string", "format": "date" }, { "type": "null" } ] }` —
  a value must be a `format: date` string (`YYYY-MM-DD`) **or** `null`.
- The stored value `"2026-06-04T14:14:02Z"` is a date-**time**, so it fails the `format: date` branch
  (RFC 3339 *full-date* rejects the time component) and obviously isn't `null` → **neither** `anyOf`
  branch matches.
- It only fires because `enforce_schema` opts into format validation —
  [builtin.rs:168-170](../../scratch-git-2/src/shared/validators/builtin.rs#L168) builds the JSON Schema
  validator with `.should_validate_formats(true)`. With formats off (the JSON Schema default) the string
  would pass `type: string`. The check is **master-independent**, so it fires on a completely untouched,
  verbatim record.
- Origin: the connector maps Pipedrive `field_type: 'date'` → `Type.String({ format: 'date' })`
  ([pipedrive-json-schema.ts:59-60](../../server/src/remote-service/connectors/library/pipedrive/pipedrive-json-schema.ts#L59)).
  Pipedrive types its timestamp system fields (`add_time`, `update_time`, `marked_as_done_time`, …) as
  `field_type: 'date'` but returns full ISO timestamps; there is no date-time case, so they inherit the
  stricter `format: 'date'`.

**Resolution — done (first option). ✅ APPLIED 2026-06-17.** Map the timestamp-valued system fields
(`add_time`, `update_time`, `marked_as_done_time`, and any other datetime-bearing `'date'` field) to
`format: 'date-time'` instead of `'date'` in `pipedriveFieldToJsonSchema`. `format: 'date-time'` accepts
`"2026-06-04T14:14:02Z"`, so it clears the error while keeping format validation meaningful. Alternatives
considered and **not** chosen: relax `case 'date'` to a plain `Type.String()` with no format (cheapest,
but drops date validation entirely); or sniff datetime-shaped values at schema-build time (more complex,
brittle). After changing the connector, **re-pull** to regenerate `schema.json` on disk, then revalidate.

> **Implementation.** Added helper `pipedriveDateFieldHoldsDateTime(field)` in
> [`pipedrive-json-schema.ts`](../../server/src/remote-service/connectors/library/pipedrive/pipedrive-json-schema.ts):
> a `field_type: 'date'` field is treated as a date-time when its `field_code` ends in `_time` —
> Pipedrive's own convention for timestamp system fields (`add_time`/`update_time`/`marked_as_done_time`/
> `won_time`/`lost_time`/`close_time`/…), while date-only fields end in `_date` or are custom hash codes,
> and clock-time `due_time` is `field_type: 'time'` (handled separately). `case 'date'` then emits
> `format: 'date-time'` for those and `format: 'date'` otherwise. This is metadata-driven (reads the field
> code, not the value) and generalises across every entity, so it needs no per-field list. Tests added in
> [`pipedrive-json-schema.spec.ts`](../../server/src/remote-service/connectors/library/pipedrive/__tests__/pipedrive-json-schema.spec.ts);
> server `test`/`lint`/`prettier:check`/`typecheck` all clean. **Still requires a re-pull** to regenerate
> the on-disk `schema.json` before the live workspace stops emitting the 2 date-time errors/record.
>
> **Scope:** this clears only the **date-time** slice (≈2 of ≈16 errors/record). The dominant noise —
> the `required` bulk (~12/record) and the `participants` anyOf (1/record) — is **not** addressed here;
> see Option A (scope the validator) or the rest of Option B (derive `required` from Pipedrive metadata).

## Decision space (pick a direction)

| Option | What | Pros | Cons | Where |
|---|---|---|---|---|
| **A. Scope the seeded validator to read-only-only** *(recommended)* | Add a param to `enforce_schema` (e.g. `params: { checks: ["readonly"] }` or a `mode`) so the auto-seeded entry runs **only** the read-only-edit check, skipping JSONSchema conformance + required. | Connector-agnostic; kills the noise everywhere at once; exactly matches the feature's stated goal (surface read-only edits before publish); no per-connector schema work. | Rust change to `enforce_schema` + the dispatcher; `enforce_schema` currently always runs all three checks. Schema-conformance validation then isn't run by the auto-seed (acceptable — it was never usefully running). | [builtin.rs:135](../../scratch-git-2/src/shared/validators/builtin.rs#L135) (`enforce_schema`), seeded entry `AUTO_SEEDED_ENFORCE_SCHEMA_ENTRY` in [validation-config.ts](../../scratch-desktop/src/main/validation-config.ts) |
| **B. Fix the connector schema to match verbatim data** | Derive `required` from Pipedrive's mandatory-field metadata (stop marking nullable fields required); add a date-time case. | Honors "adapt schema to data"; makes conformance validation genuinely useful. | Per-connector; large; every other connector likely needs the same; risk of whack-a-mole. | [pipedrive-json-schema.ts](../../server/src/remote-service/connectors/library/pipedrive/pipedrive-json-schema.ts) (`required` construction + `case 'date'`/types) |
| **C. Demote conformance to warnings / suppress** | Make required+format violations warning-level (or suppressible) so the read-only finding isn't buried under errors. | Lowest effort. | Leaves real noise; weakens schema validation generally; doesn't fix the fidelity violation. | [builtin.rs:188-240](../../scratch-git-2/src/shared/validators/builtin.rs#L188) (`ValidationLevel::Error` for conformance + required) |

**Recommendation: A.** It is the most targeted, connector-agnostic fix and directly serves the
feature's intent without per-connector schema surgery. B is the "principled" fix but is broad and
ongoing; consider it a longer-term follow-up. A and B are not mutually exclusive.

## Reproduce / verify (read-only, sanctioned)

Test workspace used: `/Users/chrishoefgen/Documents/ScratchWorkspaces/Many Connections`, folder
`Pipedrive/Activities` (records have `person_id` edited to `99` on disk; schema marks `person_id`
`x-scratch-readonly`).

```bash
SC=scratch-git-2/target/debug/scratchmd   # must be a build that INCLUDES the #3 fix
WS="/Users/chrishoefgen/Documents/ScratchWorkspaces/Many Connections"

# Populate problems for the folder, then read them back:
"$SC" --json index rebuild-folder  --workspace "$WS" --folder "Pipedrive/Activities" >/dev/null
"$SC" --json index refresh-folder  --workspace "$WS" --folder "Pipedrive/Activities" --validate
"$SC" --json validation get-folder-problems --workspace "$WS" --folder "Pipedrive/Activities"
# → 152 problems: 143 error + 9 warning. The 9 warnings are the read-only person_id edits.

# Compare with the validator in isolation (always passed the schema — this is why it "worked"):
"$SC" --json validation dry-run --workspace "$WS" --folder "Pipedrive/Activities" --file "sample-context-call.json"
```

> **State note:** during investigation, `Pipedrive/Activities` validation results were populated in the
> live workspace index (benign, under `.scratch/.repos/`; reflects the post-fix reality). The four
> Pipedrive `validation.json` files were seeded by the desktop app itself at runtime.

## File reference index

- Keystone fix: `scratch-git-2/src/shared/folder_index.rs` → `validate_page_records` (the lone
  `run_validators_dry` call site for all production validate paths).
- Validator: `scratch-git-2/src/shared/validators/builtin.rs` → `enforce_schema` (conformance 168-196,
  required 199-240, readonly 242-280). Context built in `validators/mod.rs`
  (`run_validators_dry` ~358, `apply_validators_to_record` ~722).
- Desktop seed/revalidate: `scratch-desktop/src/main/{index.ts,scratchmd.ts,validation-config.ts}`.
- Connector schema: `server/src/remote-service/connectors/library/pipedrive/pipedrive-json-schema.ts`
  (+ Branch A read-only annotations, MR !2757).
