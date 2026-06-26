# Attio connector — activity log

Plain-language, append-only journal of operations performed on the Attio connector. STATE.md says *what's covered*; this says *what was done, in order*. `[hh:mm:ss]` is wall-clock; one operation per line.

## 2026-06-10 — DEV-10303 code review (desk only, no live ops)

Reviewed the connector and bootstrapped its docs. **No service/CLI operations were run** — code review + documentation only; every STATE.md coverage cell is `⬜` (unverified).

[13:55:00] [Research] Cold-read all connector files (attio-connector.ts, attio-api-client.ts, attio-types.ts, attio-json-schema.ts, attio-write-shape.ts, attio-default-view.ts, __tests__/) and the publish pipeline (publish-plan-run.service.ts, diff-utils.ts pickByShape) to confirm the `changedFields` contract is nested (matches `updateRecords`).
[13:56:00] [Research] Researched Attio API currency (web): REST API is v2 (current, no v3, no version header), `GET /v2/self` not deprecated, no official SDK (community SDKs only). Verdict: up to date.
[13:57:00] [Research] Created STATE.md from the code (all coverage ⬜; TODOs seeded from review gaps: no FK declared, readonly-labeling gap, list-entry parent readonly-on-create, users/custom-objects/tasks/notes planned, incremental not wired, dead `listObjects`).
[13:58:00] [Research] Updated /connector-build-execute skill (SKILL.md + coverage-template.md): Endpoints section must now lead with an "API version & client" currency line.

## 2026-06-11 — live-testing session bring-up (parallel session 1, Chrome extension browser)

Stood up an isolated parallel session for live Attio testing per /start-parallel-session: server :3011 (monolith, this worktree's branch) + Redis :6380, shared Postgres/scratch-git/CLI. Browser = Claude-in-Chrome (user-requested), own tab on app.attio.com.

[16:50:30] [Research] Resumed from STATE.md (all cells ⬜, no test account). Worktree detected → parallel session required; N=1 free (ports 3011/6380).
[16:51:10] [Service UI] Opened own Chrome tab → https://app.attio.com/ → sign-in wall; paused for user login (human gate).
[16:51:40] [Manual Edits] Symlinked server/.env from main checkout into the worktree (fresh worktree had none).
[16:52:30] [Scratch CLI] Started session-1 stack — docker spinner-redis-1 on :6380 (PONG) + `PORT=3011 REDIS_HOST=localhost REDIS_PORT=6380 SERVICE_TYPE=monolith yarn dev` (first start failed exit 127: worktree had no node_modules → `yarn install`; then 382 TS errors → built @spinner/shared-types).
[16:57:00] [Scratch CLI] scratch-git :3100 started by the user (their call); verified HTTP 200 on /health.
[16:59:30] [Scratch CLI] `scratchmd --scratch-url http://localhost:3011 workspaces list` → 500: branch migration 20260610120000_workbook_add_managed_by not applied to shared DB; migration already on master → ran `yarn migrate`; list then OK (11 workspaces).
[17:02:00] [Manual Edits] Isolation smoke test: edited Copper/People/dadad.json title → "QA Engineer 0611 session-1" in the existing Copper workbook checkout (wkb_lsWnc2smsb).
[17:02:40] [Scratch CLI] `files accept` OK, but `files upload` hit :3010 — discovered the workspace marker (.scratch/.scratchmd → serverUrl) OVERRIDES both --scratch-url and scratchmd.config.yaml for files commands; pointed marker at :3011.
[17:04:30] [Scratch CLI] upload → 500 `invalid_rapt` SigningError (expired gcloud ADC — the known GCS gate); user re-authed; `touch main.ts` did NOT recycle the node process (pid predated reauth) → hard-restarted the server task.
[17:08:30] [Scratch CLI] `files upload` + `files publish` → "Published 1 connection(s)" via session-1 worker. Post-publish refresh failed (workspace git remote still :3010, baked at clone) → `files unpublished` stale-showed 1 change; service API is the proof.
[17:09:40] [Service API] Verified in Copper: `GET /developer_api/v1/people/183382759` → title "QA Engineer 0611 session-1", date_modified 2026-06-11T14:08:38Z. End-to-end edit→push through session-1 CONFIRMED.
[17:10:30] [Manual Edits] Cleanup: restored Copper workspace marker to :3010, removed scratchmd.config.yaml + /tmp creds file.

Connecting Attio + first fetch:
[17:25:00] [Service UI] User logged into Attio → workspace `whalesync-attio` (developer program, "data periodically removed"). Created access token "Scratch connector-build" via Settings → Developers → New access token; set all 12 scopes Read-write; revealed + captured token.
[17:28:30] [Service API] Verified token: `curl https://api.attio.com/v2/self -H "Authorization: Bearer 9448…"` → active, 12 read-write scopes, no expiry.
[17:29:24] [Scratch CLI] `workspaces create "attio"` → wkb_N8QkBoNSTH (server :3011).
[17:29:50] [Scratch CLI] `connections add --service ATTIO --param apiKey=***` → coa_Am0iQb8Kgb, Health OK.
[17:30:30] [Scratch CLI] `workspaces init wkb_N8QkBoNSTH -o …/cli-v4/attio` → nested attio/attio; hand-`mv` flattening BROKE git worktree absolute paths ("failed to open worktree") → rm -rf + re-init with `-o …/cli-v4` (init appends the workspace name itself).
[17:34:00] [Scratch CLI] GOTCHA: `linked add` repeatable `--table-id` flags are the SEGMENTS of ONE compound EntityId, not multiple tables — a 6-table one-shot silently created folders with polluted tableId arrays (verified in DB), and `--table-id "list,new_list"` errors "Unknown Attio table id". Removed the 2 polluted folders; relinked one table per call; lists as `--table-id list --table-id <slug>`.
[17:37:00] [Scratch CLI] `linked pull <dfd> --mode full` × 6 → all completed on session-1 worker (companies dfd_NzfaZRCF0T, people dfd_NclKl3kion, deals dfd_YUG7Bq906v, lists dfd_F3WofIuw9Y/new_list dfd_T5svrlQrr5/recruiting dfd_3OpE8cDSF2/vc_deal_flow).
[17:39:00] [Service API] Verified counts: 21 companies / 65 people / 5 deals / 1+1+1 list entries — local file counts match `…/records/query` + `…/entries/query` exactly.
[17:40:30] [Service API] Deep-compared pulled `Attio/Companies/atlas.json` vs `GET /v2/objects/companies/records/4ab62b33…` → canonical-JSON IDENTICAL (pull is verbatim).

Edit→Push coverage (all 4 entity kinds):
[17:42:10] [Manual Edits] atlas.json `values.description[0].value` → "Edited via Scratch CLI connector-build 2026-06-11 17:42".
[17:42:40] [Scratch CLI] accept → upload → publish: "Published 1 connection(s)".
[17:43:10] [Service API] Verified: GET companies/records/4ab62b33… description = edited text, fresh active_from. **Companies Edit→Push ✅**
[17:43:40] [Scratch CLI] Discovered the post-publish PHANTOM: `files unpublished` keeps showing the file (service rotated active_from/created_by_actor into main; local copy stale); re-pull does not clear it; `files discard <path>` converges it (local then has edit + fresh envelope).
[17:45:30] [Manual Edits] adam-spencer.json job_title (was empty → bare `[{value:"CB Test Title 1742"}]`, no envelope); new-deals.json name → "CB Edited Deal 1742"; VC Deal Flow entry new_text → "CB list-entry edit 1742".
[17:46:20] [Scratch CLI] accept ×3 → upload → publish: "Published 1 connection(s)" (3 modified).
[17:47:10] [Service API] Verified all 3: person job_title ✅ (envelope-less write OK), deal name ✅, list entry new_text ✅ (note: entry GET needs `id.entry_id`, not the filename which is parent_record_id). **People/Deals/List-entry Edit→Push ✅**
[17:48:00] [Scratch CLI] `files discard` ×3 → "No unpublished changes."

New→Push + Delete→Push — found & fixed a publish-pipeline bug (nested IdPath):
[17:52:00] [Manual Edits] Wrote 3 new record files (cb-new-co.json companies, cb-new-person.json people, cb-new-deal.json deals) with write-shape values only (no id).
[17:53:00] [Scratch CLI] accept ×3 → upload → publish "3 added"; `files download`; remote ids flowed back into all 3 files.
[17:54:00] [Service API] Verified all 3 creates exist in Attio (company+domain, person name+email, deal name + stage "Lead" + actor-ref owner set on create). **New→Push ✅ (objects)**
[17:56:00] [Manual Edits] Wrote list-entry file cb-new-entry.json (New List) with parent_record_id=d31701ae… + parent_object=companies, empty entry_values.
[17:56:40] [Scratch CLI] publish → entry created; entry_id 93d50b66… flowed back; verified via entries/query. **New→Push ✅ (list entries)** — the `x-scratch-readonly` parent fields do NOT block raw-file CLI creates.
[17:58:00] [Scratch CLI] Delete test: rm entry+person+deal → accept → upload → publish printed "3 deleted … Published" — **but all 3 still existed in Attio** (200/200/in-query). SILENT FAILURE.
[18:00:00] [Research] Server log: "Could not resolve remote ID for entry: …" ×3 (also for the phantom re-publishes). FileIndex had rows for pulled records only — none for publish-created ones. Root cause: publish-plan-run.service.ts used PLAIN property access on `idColumnRemoteId` (`returned[idField]`) although it's a lodash dot-path and Attio's is nested (`id.record_id`); helpers `readRecordId`/`readRecordIdAsString` exist and pull/sync already use them. Also delete filters were built as flat `{"id.record_id": id}` keys the connector's `extractRecordId` can't read.
[18:03:00] [Manual Edits] FIXED publish-plan-run.service.ts: `readRecordId` in dispatchUpdateBatch (sentinel check, identity assertion), cloneDeep+`set` for id fill, cloneDeep+`unset` for sentinel strip in dispatchCreateBatch, `readRecordId` for the FileIndex row, lodash `set` for delete filters. Server hot-reloaded clean.
[18:05:00] [Scratch CLI] Re-pull ×4 reconciled state (the unindexed creates had been re-materialized under canonical filenames — downstream damage of the bug). Deleted entry+person+deal again → publish → **404/404/gone in API, unpublished empty ✅**; deleted company → 404 ✅. **Delete→Push ✅ (all 4 entity kinds)**
[18:07:00] [Scratch CLI] Clean-room proof of the fix: created cb-cycle-test.json → publish → **FileIndex row written** (3ec53a30…) → edited description (NO re-pull) → publish → API shows v2 ✅ → deleted → publish → 404 ✅, no unpublished. **create→edit→delete cycle ✅**
[18:08:30] [Research] Ran `jest publish-plan-run.service.spec` → 7/7 pass with the fix.

Create-in-UI → Pull:
[18:12:00] [Service UI] Companies grid visually confirms the Atlas edit ("Edited via Scratch CLI …17:42" in Description). Created "UI Created Co 0611" via + New Company (name + description) → record 41a4656a….
[18:13:30] [Scratch CLI] `linked pull dfd_NzfaZRCF0T --mode full` → ui-created-co-0611.json landed locally with matching record_id/name/description. **Create→Pull ✅**
[18:13:50] [Research] Noted in the Attio sidebar: **Users** and **Workspaces** standard objects exist in this workspace — candidates for the planned-entities work (workspace members already a TODO).

## 2026-06-12 — PLAN backfill + P2/P3 (read-only flags, list-entry writable)

Backfilled the planning docs and executed the approved plan items P2 & P3:
[14:20:00] [Research] Re-read connector-build SKILL.md (new PLAN.md/ARCHIVE.md flow); created `attio/PLAN.md` (11 FOR_REVIEW items from STATE TODOs) and `attio/ARCHIVE.md` (A1 = the shipped nested-id pipeline fix, MR !2696).
[14:25:00] [Research] P3 investigation: grepped server/shared-types/CLI for write-once/create-only handling — none. Only `x-scratch-readonly` (always read-only, enforced by Rust `builtin.rs` validator). `writeOnce?: boolean` exists in `wordpress-types.ts` but is read by nothing.
[14:30:00] [Service API] P2 correctness check — `GET /v2/objects/companies/attributes` and `/v2/lists/vc_deal_flow/attributes`: `is_system_attribute` is `true` for writable standard fields (name/description/domains) — NOT a read-only signal. `is_writable === false` is the precise signal (record_id, created_at, *_interaction, logo_url, follower counts). Present on both object + list attributes. (Also confirmed every custom-field type already seeded: custom_companies_{number,checkbox,date,rating,select,multiselect,currency,record,status,location,phone} — field-type matrix seed data is ready.)
[14:33:00] [Manual Edits] P2: added `isAttributeReadonly(attr)` (`is_archived || is_writable === false`) in `attio-json-schema.ts`; used it in `valueArraySchemaForAttribute`. Explicitly NOT keyed off `is_system_attribute` (documented why).
[14:34:00] [Manual Edits] P3: made `parent_record_id`/`parent_object` writable in the list schema (`attio-json-schema.ts`) and removed them from `HIDDEN_FIXED_FIELDS` + `READONLY_FIXED_FIELDS` in `attio-default-view.ts`.
[14:35:00] [Manual Edits] Tests: +4 read-only-propagation cases + 1 parent-fields-writable case in `attio-json-schema.spec.ts`; updated the two stale parent-field assertions + the list fixture in `attio-default-view.spec.ts`. `jest attio-json-schema.spec attio-default-view.spec` → 56 pass. eslint clean.
[14:35:30] [Manual Edits] Filed **DEV-10408** (Linear, Scratch/Backlog/Low/S, assigned Ivan) — "Support write-once (create-only) fields in the publish pipeline".
[14:36:00] [Research] Updated PLAN.md (P2/P3 → APPROVED+landed; P4/P5/P6 → APPROVED, not yet implemented; fixed P5 "all lists" wording), STATE.md TODOs (P2/P3 resolved, write-once TODO + DEV-10408).

## 2026-06-12 — stack restore + P2/P3 live-validation + P4/P5 build + P6 spec

[17:30:00] [Scratch CLI] Restored the dev stack: Docker daemon had recovered (shared Postgres/Redis/scratch-git back); only `spinner-redis-1` (:6380) was missing (ephemeral `--rm`, removed when the daemon died). Recreated it; server :3011 reconnected; a real `linked pull` completed → queue/worker confirmed.
[17:34:00] [Scratch CLI] P2/P3 live-validation: re-pulled companies + New List. companies schema.json — writable fields (name/description/domains/custom_companies_number) readonly=false; non-writable (record_id/created_at/created_by/last_interaction/logo_url/twitter_follower_count) readonly=true. New List schema + default view — parent_record_id/parent_object now readonly=false + visible; id/created_at still readonly. **P2 + P3 validated.**
[17:42:00] [Service API] P5/P4/P6 discovery: `GET /v2/objects` → 7 objects (companies/people/deals + events/products/users/workspaces). `GET /v2/workspace-members` → **404**; `GET /v2/workspace_members` (underscore) → 200 (1 member). `GET /v2/tasks` → 200 (0 tasks).
[17:50:00] [Manual Edits] P5: `listTables` now enumerates objects via `listObjects()` + exposes all lists (dropped standard-object filter); `parseAttioTableId` routes any non-`list` head to object; `buildAttioObjectTableSpec` takes a display label (cached). Removed dead STANDARD_OBJECTS/STANDARD_OBJECT_DISPLAY imports.
[17:55:00] [Scratch CLI] P5 validated: picker gained Events/Products/Users/Workspaces; linked+pulled Products (new-name.json) and Users — both round-tripped the object path. Edit→push on Products attempted → hit GCS gate (write path identical to standard objects; not a connector issue).
[17:58:00] [Manual Edits] P4: added `AttioWorkspaceMember` type + `members` table kind + `listWorkspaceMembers()` + hardcoded all-read-only `buildAttioMembersTableSpec`; wired listTables (writes disabled)/parse/fetch/pull/pullByIds + read-only guards in create/update/delete. Path `/Workspace Members` (distinct from `users` object `/Users`).
[18:00:00] [Scratch CLI] P4 validated: "Workspace Members (creates not supported)" in picker; member pulled verbatim to whalesync-whale.json; schema.json all-read-only, idColumnRemoteId=id.workspace_member_id. **P4 done (read-only).** jest attio = 3901 pass, lint clean.
[18:00:30] [Service API] P6 (Tasks) spec: seeded a task via `POST /v2/tasks` (id 19f110dd-…) to learn the shape — `id.task_id`; read-only completed_at/created_by_actor/created_at; **read `content_plaintext` but write `content`+`format`** (read≠write, likely content-immutable-on-update → write-once/DEV-10408); writable is_completed/deadline_at/linked_records[]/assignees[]. Pagination `?limit&offset`. Captured in PLAN P6; impl **deferred** — bespoke write path can't be CLI-validated while the GCS publish gate is down.
[18:02:00] [Manual Edits] Docs: PLAN P4/P5 → done+validated, P6 → spec'd/deferred; STATE entities table + milestone 4 + TODOs updated (members endpoint correction, listObjects no longer dead).
[18:02:30] [Scratch CLI] ⚠️ BLOCKER: `files upload` 500s with GCS `invalid_rapt` (SigningError) — gcloud ADC expired again. Blocks ALL publish/write validation: P6 CRUD, P5-write reconfirm, field-type matrix (task 5), FK write (task 6). Needs `gcloud auth application-default login` + server restart.

## 2026-06-13 — deep pass: P6 CRUD + FK + field-type matrix (publish unblocked)

[23:30:00] [Scratch CLI] GCS reauth confirmed (ADC impersonation OK). Restarted spinner-redis-1 (:6380) + the :3011 server (both died in the session transition); rebuilt @spinner/shared-types to clear stale-dist TS errors. P5 edit→push on Products re-confirmed (write path = standard objects).
[23:45:00] [Service API] P6 Tasks contract probed live: update accepts only is_completed/deadline_at/linked_records/assignees; **content rejected on update (400 unrecognized_keys) → immutable/write-once**; create requires all of content/format/deadline_at(date|null)/is_completed/linked_records/assignees.
[00:10:00] [Manual Edits] Implemented P6: AttioTask type + `tasks` kind + client (queryTasks/getTask/createTask/updateTask/deleteTask) + hardcoded schema (`buildAttioTasksTableSpec`) + connector wiring (read≠write content, sparse update skips content). jest attio 3940 pass, lint clean.
[00:20:00] [Scratch CLI] P6 CRUD validated: pull (2 tasks, count match); edit→push (is_completed+deadline landed, content_plaintext UNCHANGED — write-once works); create→push (id 5b9aea1b… flowed back, in API w/ assignee); delete→push (404, clean). **P6 ✅**
[00:30:00] [Scratch CLI] FK move parent→parent: re-pointed person 1bd56232 `company` → Atlas (4ab62b33), published, verified re-parent in API. **Milestone 6 capability ✅** (record-reference write path already correct).
[00:35:00] [Manual Edits] Implemented P1 FK declaration: `foreignKeyOptionsForAttribute` → `x-scratch-foreign-key` on single-target record-reference (object-id→slug via `listObjects`) + actor-reference (→ workspace_members). +4 unit tests. Validated live in pulled schema: people/deals references all resolved to target tables. **FK ✅**
[00:45:00] [Service API] Field-type matrix: set 11 custom-field types on atlas (text/number/checkbox/date/rating/select/multiselect/currency/status/location/phone) in one edit→push → all confirmed in API. select/status terse-write→object-read ✓; date no tz shift; multiselect 2 options. **Pass 2 / Milestone 7 ✅**
[00:50:00] [Manual Edits] Reverted all test edits (atlas, tasks, person) — `files unpublished` empty. Updated PLAN (P1/P6 ✅), STATE (field-type matrix, FK table, milestones 4-7, entities table), LOG.

## 2026-06-15 — write-once feature (DEV-10408), separate branch `dev-10408-write-once-fields`

Implemented the generic **write-once** field mechanism (the DEV-10408 follow-up from P3/P6), with Attio as the proving ground. Connector code, no live ops here — desktop/live validation pending.

[--:--:--] [Manual Edits] shared-types: added `X_SCRATCH_WRITE_ONCE = 'x-scratch-write-once'` (json-schema.ts) + `writeOnce?: boolean` on `TableViewCol`/`TableViewSubfield` (table-view.ts).
[--:--:--] [Manual Edits] Attio: marked list-entry `parent_record_id`/`parent_object` and task `content_plaintext` `x-scratch-write-once` (dropped their interim plain-writable state); `attio-default-view.ts` `buildFixedCol`/`buildValueCol` now derive `writeOnce` from the schema, mirroring `readonly`. Updated specs (write-once asserted, not readonly).
[--:--:--] [Manual Edits] Desktop: `ColumnAttributes.writeOnce` + parse in `build-column-definitions.ts`; `FolderDataGrid` `isColumnWriteOnce`/`isNewRecordRow`/`isCellReadonly` (effective editability = `readOnly || (writeOnce && !isNew)`, new = `__rowStatus` added/addedUnpublished) in `getCellContent` + `onCellEdited`; `RecordDetailView` adds write-once cols to `readOnlyFields` only when the record is not new. Vitest + eslint clean.
[--:--:--] [Manual Edits] scratch-git: `enforce_schema` (builtin.rs) warns when a write-once field changes on an EXISTING record (master present), silent on NEW (master None) — the create-only counterpart to readonly. +3 cargo tests (all pass).
[--:--:--] [Manual Edits] Docs: CONNECTOR_GUIDE.md (`x-scratch-write-once` section + default-view guideline), connector-build.md (create-only-fields gotcha), generate_docs.rs (agent-facing create/update guidance + validator table), attio STATE/PLAN updated (DEV-10408 resolved).
