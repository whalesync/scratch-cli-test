# DEV-10453 — Pipedrive publish read-only fields → surface via validation (handoff)

- **Status:** Resolved
- **Author:** Chris Hoefgen
- **Created:** 2026-06-17
- **Resolved:** 2026-06-18 — both branches landed on master: Pipedrive read-only fields marked in the schema (`74f3170a`) and desktop validation default-on + auto-seed with the read-only-edit warning surfacing (`3066e008`). The resulting validation-noise blocker is tracked and resolved in the companion finding-3 plan. Remaining items in "Open questions" (honor deliberate removal, server-side hard gate D-ii, CLI/web parity) are deferred future considerations, not blocking work.
- **Linear:** [DEV-10453](https://linear.app/whalesync/issue/DEV-10453)

> **Purpose of this doc.** A self-contained handoff so a fresh session can continue this work on
> either of the two branches below without the prior conversation. It covers the customer problem,
> the root cause, the approach we landed on (and the one we abandoned), exactly what each branch
> contains, the key decisions + rationale, what's left, and how to verify.

## TL;DR

- **Customer:** Tim Davidson (`tim.davidson@wiispa.com`), Linear **DEV-10453**. Pipedrive publishes fail.
- **Root cause:** Records are stored as the **verbatim** Pipedrive GET response. On publish, the
  connector sent fields that Pipedrive's **v2 write API rejects as read-only / not-allowed** (it
  returns a hard validation error instead of ignoring them), so the whole record fails. Examples:
  Activities `private` and `person_id`; Deals `update_time`; Notes' hydrated sub-objects.
- **Approach (current):** Instead of silently stripping read-only fields on publish (the abandoned
  v1 below), **surface the problem to the user earlier via validation**: mark the read-only fields
  in the schema, default desktop validation on, and always-run a schema validator that warns when a
  read-only field was edited — *before* publish. The Pipedrive API stays the final backstop.
- **Two branches, both off the latest `origin/master`:**
  - `dev-10453-pipedrive-mark-readonly-fields` → **server** schema marking. **MR !2757** (open).
  - `dev-10453-desktop-default-validation` → **desktop** default-on + auto-seed validator. No MR yet.

> **Update (2026-06-17, session 2).** Desktop testing surfaced that validation showed **nothing** for a
> read-only edit. Root-caused to **three** stacked bugs (seed-trigger gap; cached-table not populated;
> and the keystone — `enforce_schema` ran with `schema=None` in the production index path, so it was
> inert). All three are now fixed on `dev-10453-desktop-default-validation` (one change is in
> `scratch-git-2/src/shared/folder_index.rs`). Fixing them exposed **finding 3**: `enforce_schema` floods
> verbatim records with false-positive errors (~143 on one Activities folder) that bury the read-only
> warning, now workspace-wide. Finding 3 is **open** — full evidence, mechanics, and the decision space
> are in [`2026-06-17-dev-10453-finding3-validation-noise.md`](2026-06-17-dev-10453-finding3-validation-noise.md).

## Customer problem & evidence

Investigated against the **production** Scratch DB (read-only) for workbook `wkb_oVZp2fqpG2` /
user `usr_D7UlfhvhgZ`. Findings:

- Pipedrive connector health = `OK` → **not** an auth/connection problem.
- ~15 of the last 16 `PublishPlan` rows were `completed-with-errors`; failed ops split ~17 `create`
  + ~15 `edit`. The `PublishPlanOperation.error` values grouped into read-only rejections by entity:

| Entity (table) | Phase | Pipedrive rejection |
|---|---|---|
| Activities | create | `Validation failed: private: Parameter 'private' is not allowed for this request` |
| Activities | create/edit | `'person_id' is a read-only field. Add a primary participant to set 'person_id' instead...` |
| Deals | edit | `Validation failed: update_time: Parameter 'update_time' is not allowed for this request` |
| Notes | create/edit | `Bad request` / `Something went wrong...` (read-only hydrated sub-objects) |

Proof the fields were literally in the payloads (DB query of `changedFields`/`content` keys):
Deals-edit diff = `{custom_fields, update_time}`; Activities-edit diff = `{person_id}`;
Activities-create content includes `private`, `person_id`, `org_id`, `marked_as_done_time`.

**Re-run the DB investigation** (read-only, sanctioned):
```bash
terraform/tools/connect_to_gcp_db_readonly.sh production "SELECT op.phase, op.status, op.error FROM \"PublishPlanOperation\" op JOIN \"PublishPlan\" p ON op.\"planId\"=p.id WHERE p.\"workbookId\"='wkb_oVZp2fqpG2' AND op.status='failed-batch' LIMIT 50;"
```

A root-cause comment is already posted on **Linear DEV-10453**.

## Approach decision — why we pivoted

**v1 (ABANDONED):** auto-strip the read-only fields in the Pipedrive connector before create/update.
A PR was opened and then **closed**. It violates the product principle *"Surface failures; never
silently succeed"* — silently dropping a user's edit to a read-only field hides the problem. The
team chose to bubble it up instead.

**v2 (CURRENT):** keep only the part of v1 that *helps* surfacing (the schema read-only
annotations), revert the silent stripping, and add validation that warns the user before publish.
This splits cleanly into a small server change and a desktop change — the two branches below.

## Branch map — what to continue where

### Branch A — `dev-10453-pipedrive-mark-readonly-fields`  (server; MR !2757)

- **Base:** latest `origin/master`. **Commit:** `457d8edb`. **MR:** https://gitlab.com/whalesync/spinner/-/merge_requests/2757
- **Scope (2 files):** `server/src/remote-service/connectors/library/pipedrive/pipedrive-json-schema.ts`
  + its spec. Replaces the old flat `READONLY_SYSTEM_FIELDS` set (`id`/`add_time`/`update_time`) with
  a **per-entity `ENTITY_READONLY_FIELDS`** map used to set `X_SCRATCH_READONLY` on each entity's
  system fields. For **v2 activities** it additionally marks `person_id`/`org_id` (read-only
  relations — set via the writable `participants` array) and `private`/`marked_as_done_time`.
- **Why it matters:** this is the schema becoming the **source of truth** for which Pipedrive fields
  are writable. The desktop validator (Branch B) and the UI's read-only treatment both key off these
  `X_SCRATCH_READONLY` annotations, so this is connector-agnostic and reusable.
- **Status:** verified (json-schema spec 25 tests, eslint, prettier). Needs review/merge.
- **Possible next steps:** address review; optionally e2e-verify against a non-customer Pipedrive
  account that editing a writable field on Activities/Deals/Notes now shows those system fields as
  read-only in the UI. Decide whether to keep the *speculative* `private`/`marked_as_done_time`
  entries (they only annotate if the `activityFields` metadata actually surfaces those codes; if not,
  listing them is a harmless no-op).

### Branch B — `dev-10453-desktop-default-validation`  (desktop; no MR yet)

- **Base:** latest `origin/master`. **Commit:** `733a2ebd`. Pushed; **open it as a new Conductor workspace to iterate.**
- **Scope (7 files):**
  - `scratch-desktop/src/renderer/src/stores/workspace-ui-store.ts` — `validateEnabled` default
    flipped to `true` in **two** places: the initial store state **and** the `hydrateWorkbookSettings`
    fallback (`?? true`), so Validation is on by default for **existing** workspaces too.
  - `scratch-desktop/src/main/validation-config.ts` — the **auto-seeder**: a pure
    `computeFoldersNeedingSchemaValidatorSeed(leafFolderNames, existingConfigs)` (unit-tested) + an
    async `ensureSchemaValidatorSeededInEveryFolder(workspacePath)` wrapper that **dynamically
    imports** `listFolders` (keeps this module unit-testable without the native/Electron graph).
  - `scratch-desktop/src/main/index.ts` — IPC handler `files:ensure-schema-validator-seeded`.
  - `scratch-desktop/src/preload/index.ts` + `index.d.ts` — `scratchFiles.ensureSchemaValidatorSeeded` bridge + type.
  - `scratch-desktop/src/renderer/src/pages/WorkspacePage.tsx` — fire-and-forget trigger on
    **workspace load** and **after pull** (`handlePullAndRefresh`).
  - `scratch-desktop/src/main/__tests__/validation-config.spec.ts` — 5 unit tests for the seeder.
- **What it does:** seeds the record-scoped `enforce_schema` validator into every data folder's
  `validation.json` so schema validation always runs; its read-only check warns when an
  `x-scratch-readonly` field was edited vs the published `master` value. Idempotent, order-preserving,
  writes only under `.scratch/`.
- **Status:** verified (seeder 5 tests, eslint, electron-vite build). **No MR yet** — this is the
  iterate-on branch.
- **Open next steps / decisions (see "Open questions" below).**

## Key technical decisions & rationale

1. **Schema is the source of truth for read-only.** All read-only handling keys off the
   `X_SCRATCH_READONLY` annotation (`packages/shared-types/src/connector/json-schema.ts`). Branch A
   completes Pipedrive's annotations; everything else (validator + UI) reads them. Connector-agnostic.

2. **Desktop validation on by default for all workspaces** — flipped both the initial state and the
   hydration fallback (not just new workspaces). This was an explicit choice ("on by default").

3. **"Always apply" = auto-seed `enforce_schema` (option D-i), advisory/warn, desktop-only.** Chosen
   over **D-ii** (a *server* pre-publish gate that hard-blocks for all clients) as the first step
   because it's cheap, schema-driven, and multi-connector. D-ii remains a possible follow-up for a
   hard guarantee across desktop + CLI + web (the dormant `Connector.validateFiles` hook at
   `server/src/remote-service/connectors/connector.ts` is the seam; it is **defined but never
   called**).

4. **No "suppression sentinel" — we re-seed instead.** We considered honoring a user who deletes the
   validator in the UI by writing a `noop:enforce_schema_suppressed` tombstone. **Rejected:** the
   Rust dispatcher `bail!`s (errors) on an unknown validator kind
   (`scratch-git-2/src/shared/validators/mod.rs:~850`), so a `noop:` entry would break that folder's
   validation. Because the directive was "**always** be applying," the seeder simply **re-seeds on
   the next load** if removed. ⚠️ **Trade-off to revisit:** a user can't permanently remove it via
   the UI. Honoring deliberate removal would need a different mechanism (e.g. a sibling marker file
   the seeder reads — not a validator entry).

5. **Disk-seed, not runtime injection.** Runtime injection is impossible — Rust loads validators
   **only** from on-disk `validation.json` (no CLI flag / default-validators path). Disk-seeding is
   **safe for publishing** because `validation.json` lives under `.scratch/`, which Rust excludes
   from unreviewed/dirty detection (`is_data_path_in_folder` in `review_ops.rs`). So seeding never
   creates an unreviewed change, never blocks publish, and never pollutes the user's record diff.

6. **Seed every leaf folder.** `enforce_schema` **no-ops** on a folder with no schema
   (`scratch-git-2/src/shared/validators/builtin.rs:~140` returns empty when `schema.schema` is
   absent), so seeding schema-less/asset folders is harmless. (Optional refinement: seed only folders
   that have a `schema.json`.)

## How validation works (architecture a fresh session needs)

- **Schema:** each table is a TypeBox `TSchema` carrying annotations like `X_SCRATCH_READONLY`. The
  Pipedrive schema is built in `pipedrive-json-schema.ts` (dynamic entities pull fields from the
  v1-era `*Fields` metadata; static entities — leads/notes/pipelines/stages — use
  `pipedrive-static-schemas.ts`).
- **Validators (Rust):** `scratch-git-2/src/shared/validators/{mod.rs,builtin.rs}`. `enforce_schema`
  is the **only** record-vs-schema validator. It checks JSONSchema conformance, required fields, and
  **read-only** (`x-scratch-readonly`): for an existing record it compares each read-only field's
  working value to the `master` (published) value and emits a **Warning** if changed; for a new
  record it warns if a read-only field is set. Run via `scratchmd validation get-folder-problems`.
- **Validator config:** per-folder `validation.json` under
  `.scratch/connections/scratch/<connectionDirName>/<folderPath>/validation.json` (a JSON array of
  `{ validator, field?, fields?, params?, order?, note? }`). Read/written by
  `scratch-desktop/src/main/validation-config.ts` (`getValidationConfigs` / `writeValidationConfig`).
- **Desktop wiring:** `validateEnabled` (in `workspace-ui-store.ts`) gates the **display** of the
  Validation panel / sidebar dots; the validators that **run** per folder are whatever is in that
  folder's `validation.json`. The desktop runs validators via `scratchmd` and renders results
  (`use-validation.ts`, `ValidationPanel.tsx`, `WorkspaceSidebar.tsx`).
- **Folder enumeration:** `listFolders(workspacePath)` (`scratch-desktop/src/main/local-files.ts`)
  walks the worktree, skips `.scratch`/hidden, returns `FolderEntry { name, path, fileCount }` where
  `name` is the POSIX workspace-relative leaf path whose **first segment is the connection
  `dirName`** — i.e. split on the first `/` to get `(connectionDirName, folderPath)`, the same key
  `validation.json`/review maps use.
- **Server publish path (for D-ii later):** `server/src/publish-plan/publish-plan-run.service.ts`
  dispatches create/update/delete batches per phase; per-record errors land in
  `PublishPlanOperation.error` and the job's `failedOperations[]`, surfaced to the desktop. There is
  **no** record-vs-schema validation in this path today.

## Open questions / next steps (mostly Branch B)

1. **Honor deliberate removal?** Today removing `enforce_schema` via the UI gets re-seeded next load.
   If we want to respect removal, add a sibling-marker mechanism (not a `noop:` validator — Rust
   errors on unknown kinds).
2. **Server-side hard gate (D-ii)?** Implement the dormant `Connector.validateFiles` (or a new
   `PublishSchemaValidatorService`) and call it before dispatch in `publish-plan-run.service.ts` to
   block publishing schema-violating records across desktop + CLI + web. Decide warn vs block.
3. **End-to-end manual check (Branch B):** open a Pipedrive workspace, edit a read-only field (e.g.
   an activity `person_id`), confirm a **warning** appears in the Validation panel **before** publish,
   and that publish is **not** blocked by it.
4. **Seed scope:** seed every leaf folder (current) vs only folders with a `schema.json`.
5. **CLI/web parity:** validation auto-apply is desktop-only today; D-ii would cover all clients.
6. **Trim `ENTITY_READONLY_FIELDS.activities`?** Keep `private`/`marked_as_done_time` speculatively
   (harmless) or trim to metadata-confirmed codes.

## Verification commands

> **Fresh worktree first-time setup** (a brand-new worktree shares `.git` but **not** `node_modules`):
> `nvm use` (Node 22; the shell defaults to 20), `yarn install` where needed, and
> **build shared-types** (`cd packages/shared-types && yarn build`) — the server `tsc` fails on stale
> shared-types. Do **not** symlink `node_modules`.

**Server (Branch A)** — from repo root:
```bash
cd server && yarn jest src/remote-service/connectors/library/pipedrive   # pipedrive suite
yarn typecheck && yarn build && yarn lint
yarn prettier --check "src/remote-service/connectors/library/pipedrive/**/*.ts"
```

**Desktop (Branch B)** — from `scratch-desktop/` (it is **not** in Turborepo):
```bash
cd scratch-desktop
yarn test src/main/__tests__/validation-config.spec.ts   # seeder unit tests
yarn lint && yarn build                                   # electron-vite type-checked build
```

## Reference material

- `.context/dev-10453-rev2-investigation.md` — full revert/keep + validator investigation (sections A–E).
- `.context/dev-10453-autoseed-plan.md` — the auto-seed design (disk-seed safety, idempotency, hooks).
- Linear **DEV-10453** (root-cause comment posted). Production DB read-only script:
  `terraform/tools/connect_to_gcp_db_readonly.sh production "<SQL>"`.
- Abandoned v1 lives on the old branch `investigate-dev-10453-pipedrive-publish` (commit `cfeca950`,
  closed MR !2755) — for reference only; do not build on it.
