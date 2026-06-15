<!-- Activity log for the Affinity connector — maintained by /connector-build.
     One line per operation actually performed; date in the section header, wall-clock time per row. -->

# Affinity — Activity Log

## 2026-06-11 — first live run: parallel session, connect, pull all tables (read-only)

Session setup (parallel worktree session N=2):
[17:26:30] [Research] Read STATE.md (adoption doc from 2026-06-10) + docs/connector-build.md; template version matched (2026-06-10), no reconciliation needed
[17:28:10] [Scratch CLI] Symlinked server/.env from main checkout into worktree; started session Redis — docker run --rm --name spinner-redis-2 -p 6381:6379 redis:7
[17:30:00] [Manual Edits] Fresh worktree had no node_modules — yarn install (server + root) + yarn workspace @spinner/shared-types build to fix 382 watch-compile errors
[17:36:40] [Scratch CLI] Started monolith server — PORT=3012 REDIS_HOST=localhost REDIS_PORT=6381 SERVICE_TYPE=monolith yarn dev → /health green; scratchmd --scratch-url http://localhost:3012 auth status OK

Browser preflight + login gate:
[17:31:20] [Service UI] gstack browser connected (headed); opened https://login.affinity.co and paused for the user to log in
[17:39:30] [Service UI] User logged in → org is whalesync.affinity.co; user provided v1 + v2 API keys (read-only ops requested)

Connect + pull every table:
[17:40:07] [Scratch CLI] Created workspace — scratchmd --scratch-url http://localhost:3012 workspaces create "affinity" → wkb_Vrr3D1LQJ5
[17:40:40] [Service API] Checked quota — curl -H "Authorization: Bearer zYF…" https://api.affinity.co/rate-limit → org_monthly 99,998/100,000 remaining
[17:40:55] [Scratch CLI] Created connection — connections --workspace wkb_Vrr3D1LQJ5 add --service AFFINITY --param apiKey=zYF… --name "Affinity" → coa_NC1s7DlJ8B, Health OK
[17:41:30] [Scratch CLI] linked available → 5 tenant tables + 19 user lists; linked add persons, companies, opportunities, notes, entity-files, 274008 (Ivan's Org List), 274157 (Ivan's Org List 2), 197394 (Deals) — note: repeatable --table-id only linked the first id; linked one at a time
[17:42:30] [Scratch CLI] Full pull of all 8 tables — linked pull <dfd> --mode full ×8, all completed (proves session worker/queue isolation)
[17:43:30] [Scratch CLI] Cloned workspace — workspaces init wkb_Vrr3D1LQJ5 -o /Users/ijd/repos/spinner/local/cli-v4/affinity (landed at …/affinity/affinity) → People 18 · Companies 39 · Opportunities 2 · Notes 10 · Entity Files 1 · Deals 5 · Ivan's Org List 1 · Ivan's Org List 2 1

Pull-fidelity verification (verbatim vs service API):
[17:44:00] [Service API] Person 153926516 — GET /v2/persons/{id}?fieldTypes=… === local file (after array→keyed-object reindex on fields): exact match
[17:44:20] [Service API] Company 293139834 + Opportunity 90325063 — exact match; Note 26988698 — exact match once includes=companiesPreview&personsPreview&opportunitiesPreview&repliesCount passed
[17:44:40] [Service API] Deals list entry 175883354 — exact match after applying the reindex recursively (connector also keys the nested entity.fields array — documented transform)
[17:45:00] [Service API] Entity file 10852042 — GET /entity-files/{id} (v1 endpoint, v2 Bearer token authorizes it) — exact match; the API itself returns both snake_case and camelCase keys, stored verbatim
[17:45:30] [Research] Tallied valueTypes present in pulled data: number, filterable-text(-multi), interaction, text, location, dropdown, ranked-dropdown, dropdown-multi, person(-multi), company(-multi), datetime — 14 types pulled; updated STATE.md coverage cells

DEV-10298 Phase 1 — implement write support (code only; live verification deferred, read-only run):
[17:52:00] [Research] Fetched DEV-10298 from Linear (read-only → read-write, High/S, In Progress); cold-read connector/api-client/json-schema/default-view code and the Copper write pattern
[17:58:00] [Research] Pulled exact v2 write shapes from developer.affinity.co OpenAPI excerpts: PATCH {persons|companies}/{id}/fields + lists/{id}/list-entries/{id}/fields with {operation:'update-fields', updates:[{id,value}]} ≤100; write refs are {id} / {dropdownOptionId} only (additionalProperties:false); notes POST /v2/notes (type-discriminated), POST /v2/notes/{id} (sparse), DELETE /v2/notes/{id}
[18:10:00] [Research] Implemented: affinity-write-translation.ts (read→write narrowing, truncated-multi-value guard, changed-record update assembly, note-create builder); api-client write methods (batch PATCH chunking, notes CRUD); connector createRecords/updateRecords/deleteRecords with per-kind dispatch + read-back; schema x-scratch-readonly audit (computed fields, record basics, note includes, entity-file metadata); default view propagates readonly to dynamic + location columns
[18:18:00] [Scratch CLI] npx jest affinity → 5 suites, 211 tests green (38 new); yarn build green; yarn lint green after prettier --write
[18:23:00] [Research] Updated STATE.md: Milestone 5 → 🔄 (code landed, live verification pending), TODOs checked (write support phase 1, readonly audits), Endpoints table +6 write rows, Publishing section status

Auth interchangeability probe (user question):
[19:05:00] [Service API] Proved v1/v2 keys fully interchangeable — both keys × both API versions × Bearer/Basic all 200 (curl GET /persons?page_size=1 and GET /v2/lists?limit=1); recorded in STATE.md Gotchas

Live write pass — Edit→Push on Deals list entry (user approved writes):
[19:20:00] [Scratch CLI] cliCanPublish already true (psql check); re-pulled all 8 tables so stored schemas pick up new x-scratch-readonly flags — linked pull <dfd> --mode full ×8
[19:24:30] [Manual Edits] Set 6 fields of 6 valueTypes on Lists/Deals/greylock.json (ranked-dropdown 10157168, number 1500000, dropdown 10157153, dropdown-multi ×2, text, person-multi [{id:153926540}])
[19:25:30] [Scratch CLI] files accept → upload → publish → "Published 1 connection(s)"
[19:26:30] [Service API] ALL 6 values verified landed — GET /v2/lists/197394/list-entries/173234389
[19:30:00] [Research] files unpublished kept showing modified → traced: re-anchor compares patch vs hydrated canonical (person-multi read back as full person + totalCount) → phantom pending patch + conflicts.log entry; server main/dirty correct
[19:45:00] [Scratch CLI] files discard greylock → clean

Revert leg + the null-clear platform bug:
[19:50:00] [Manual Edits] Reverted the 6 fields (5 × data:null + Status→New) on greylock.json
[20:05:00] [Scratch CLI] accept/upload kept flagging "unreviewed" → traced to merge-patch dialect: null = DELETE-KEY, so a worktree null can never converge; converged by REMOVING the data keys instead
[20:10:00] [Scratch CLI] published the revert → only Status (non-null) landed; the 5 clears were SILENTLY DROPPED (computeChangedFields ignores deleted keys by design + merge-patch can't express null) — platform bug, every connector affected
[20:12:00] [Service API] Raw probe: PATCH update-fields with data:null clears fine (service OK) — bug is ours, not Affinity's; cleared the remaining 4 test values via raw API and re-pulled

Tenant tables Edit→Push + multi-folder publish bug:
[20:20:00] [Manual Edits] Set person john-doe (210381719) Random=text + New Global Column=42.5; company acme-ai-example (292372019) One-Liners=text
[20:22:00] [Scratch CLI] accept-all → upload → publish (ONE publish, TWO folders)
[20:23:00] [Service API] Both writes verified in service; BUT only People got the "Publish V2 edit batch" commit — Companies file stale on main/dirty, patch lingering, all ops "success" (multi-folder publish commit-loss platform bug)
[20:26:00] [Scratch CLI] Re-published the leftover company patch alone → commit landed, patch cleared (single-folder publish is correct)

Notes CRUD:
[20:40:00] [Manual Edits] Edited Notes/30535251.json content.html → publish → service shows new html + updatedAt bumped; patch cleared cleanly
[20:45:00] [Manual Edits] Created Notes/cli-created-note.json (content.html + personsPreview data id 210381719) → publish → note 31424422 created, remote id flowed back into the file, confirmed via GET /v2/persons/210381719/notes
[20:50:00] [Scratch CLI] Deleted the local note file → accept-all → publish → GET /v2/notes/31424422 = 404; unpublished clean

Negative test (read-only basics):
[20:55:00] [Manual Edits] Set firstName="Johnny" on john-doe.json → publish → connector refused with clear error ("cannot be written via the Affinity v2 API … firstName"); op failed, patch stayed in unpublished, service unchanged ("John"); discarded after

Service→Scratch direction (gstack browser):
[21:10:00] [Service UI] Verified CLI-written values visible on john-doe's Affinity page (activity feed attributes them to the API-key owner); edited Random inline in the UI to "UI edit roundtrip — pulled into Scratch"
[21:12:00] [Scratch CLI] linked pull People → local file shows the UI edit (unicode em-dash intact)

Field-type seeding (v1 fields API) + remaining types:
[23:20:00] [Service API] POST /fields ×5 on Deals list (date/location/company/company-multi/person) — first attempt 422 ("List EntityAttribute must have same model type as list type": entity_type must match what the list HOLDS → Deals holds companies → entity_type 1)
[23:25:00] [Scratch CLI] Re-pulled Deals — all 5 new fields discovered dynamically with correct valueTypes, writable
[23:30:00] [Manual Edits] Set all 5 on greylock.json → publish (after dropping a nested "state":null — merge-patch strips nested nulls too) → ALL 5 verified in service. Date quirk found: 10:30Z snapped to 07:00Z (org-tz midnight, day-granularity)
[23:40:00] [Service API] Cleanup: DELETE /fields ×5, cleared person/company test values via raw API, re-pulled 4 tables, discard-all → "No unpublished changes"; quota used by entire run: 234/100,000

Documentation:
[23:54:00] [Research] STATE.md: matrix Edit→Push/Notes-CRUD ✅s with verification notes, Milestone 5 update, 8 Edge cases, bulk-limits rows; docs/connector-build.md: 4 new cross-connector trick entries + Affinity date-snap example; this LOG backfill

## 2026-06-12 — environment recovery + incremental resolution + foreign keys

Environment recovery (Docker Desktop had quit overnight, took down the shared stack + session Redis):
[16:15:00] [Scratch CLI] Restarted Docker Desktop (`open -a Docker`); shared stack was cleanly stopped (Exit 0) → `docker compose -f server/localdev/docker-compose.yml up -d` (Postgres :5432 + Redis :6379 back, data intact); scratch-git :3100 had survived
[16:16:00] [Scratch CLI] Re-created session Redis — `docker run --rm --name spinner-redis-2 -p 6381:6379 redis:7` (background); server :3012 survived and reconnected to fresh Redis + Postgres
[16:17:00] [Scratch CLI] Isolation re-verified — `linked pull dfd_LDSGkQmQts --mode full` completed on this session's worker; `files unpublished` clean

Incremental polling (DEV-10159) — resolved with live evidence:
[16:30:00] [Service API] Decisive future-date filter test (must return 0 if honored): Persons v2 `filter=updatedAt>=2030` → 18/18 (ignored); Companies → 39/39 (ignored); List-entries → not narrowed + records carry only `createdAt` (no row-modified ts); v1 `/persons?min_last_modified=2030` → 18/18 (ignored)
[16:32:00] [Service API] Notes v2 `filter=updatedAt>=…` IS honored (10→0 future, 10→2 for >=2020) — but 8/10 notes have `updatedAt: null` (never edited), so a watermark would drop never-edited records → unsafe for one small table
[16:36:00] [Research] STATE.md Incremental section rewritten with the evidence table + Notes-null caveat (verdict: not feasible, DEV-10159 correctly canceled); PLAN.md TODO closed; 2 reusable gotchas added to docs/connector-build.md (filter-ignored-but-200; updatedAt-null-drops-records)

Foreign keys (Milestone 6):
[16:40:00] [Research] Read FK contract (`X_SCRATCH_FOREIGN_KEY_OPTIONS` = `{linkedTableId: <table wsId>}`, Copper/Pipedrive/GHL idiom: nullable-number value); determined Entity-Files `person_id`/`organization_id`/`opportunity_id` are the only clean scalar-id FK surface
[16:42:00] [Manual Edits] Declared FKs in `affinity-json-schema.ts` (entity-files parent ids → persons/companies/opportunities, kept read-only) + unit test; the CRM person/company refs are decorated objects nested in field values → not declarable without reshaping (documented as a design decision in PLAN.md)
[16:50:00] [Scratch CLI] jest affinity 212/212; prettier + eslint clean; `tsc --noEmit` clean (after a stale shared-types dist rebuild — unrelated `CreateFieldResult`/schema-builder errors cleared)
[16:55:00] [Service API] FK read-direction verified live: re-pulled Entity Files, stored schema carries `x-scratch-foreign-key:{linkedTableId}` on all 3 ids, and the file's `person_id` 168116437 resolves to a real People record ("Example Person") in both the local table and `GET /v2/persons/168116437`

## 2026-06-12 — DEV-10298 P2: v1 write codepath (create/update/delete + list membership)

Research — v1 endpoint shapes (throwaway records, deleted immediately):
[17:00:00] [Service API] Confirmed v1 surface from api-docs.affinity.co: POST/PUT/DELETE /persons, /organizations, /opportunities; POST/DELETE /lists/{id}/list-entries; all deletes → {success:true}
[17:05:00] [Service API] Live-probed POST /persons {first_name,last_name,emails} → v1 record w/ new id → GET /v2/persons/{id} (v2 readback shape) → DELETE → 404. Same for org (POST /organizations), list-entry (POST /lists/197394/list-entries {entity_id}), opportunity (POST /opportunities {name,list_id} — needs an opportunity-TYPE list, 204872; 422 on a company list)
[17:08:00] [Service API] KEY finding: v2 PATCH /v2/companies/{id}/fields succeeds on a v1-created org (HTTP 200) → architecture: create basics via v1, set field values via v2, sidestepping the v1 field-values endpoint + multi-value diff entirely

Implementation:
[17:15:00] [Research] Added v1 types + client methods (createPerson/updatePerson/deletePerson, create/update/deleteCompany→/organizations, create/update/deleteOpportunity, createListEntry/deleteListEntry; 404-noop delete helper); v1 translation builders (create payloads, basics-update split basics-vs-fields, non-empty-field-values-for-new-record); made basics writable in the tenant schemas (firstName/lastName/emailAddresses; name/domain; name) with derived siblings kept read-only; wired connector createRecords/updateRecords/deleteRecords to route per table (v1 lifecycle + v2 field values)
[17:30:00] [Scratch CLI] jest affinity 241/241 (29 new P2 tests; updated 4 stale P1 "not-supported" tests that P2 now implements); prettier + eslint clean; `tsc --noEmit` 0 errors (after `prisma generate` + a stale-shared-types rebuild cleared unrelated workbook/schema-builder errors)

Live end-to-end verification:
[17:34:00] [Manual Edits] Applied pending migration `20260611120000_workbook_add_settings` (ADD COLUMN settings JSONB) — the shared `scratch` DB was behind the branch schema; blocked ALL publishes with Prisma P2022 until applied. Restarted the :3012 server to pick up the fresh client + migrated schema
[17:36:00] [Scratch CLI] CLI `files upload` then 500'd with `invalid_rapt`/SigningError → **GCS application-default credentials expired** (infra gate, not connector) → CLI publish blocked until `gcloud auth application-default login`
[17:40:00] [Scratch CLI] Proved the v1 write path WITHOUT GCS via a connector-driven live integration spec (`test/integration/affinity-connector.spec.ts`): `AffinityConnector.createRecords` → person created in the service (id flowed back) → `updateRecords` renamed basics (v1 PUT) → `deleteRecords` → by-id pull returns nothing. PASS (2.9s) against the live API; throwaway record auto-cleaned. CLI-publish ✅ (strict) still pending GCS reauth.

CLI publish ✅ verification (after GCS reauth + server restart):
[00:15:00] [Scratch CLI] GCS application-default creds reauthed by user → restarted :3012 server to clear the in-process cached creds (+ rebuilt stale shared-types dist for `PublishFailedOperation`)
[00:25:00] [Manual Edits] New→Push person `Affinity/People/zzz-cli-p2.json` → accept→upload→publish → service person 267567479 (id flowed back). [Service API] `GET /v2/persons/267567479` confirms. EDGE CASE: Affinity title-cased `ZZZ-CLI-P2`→`Zzz-cli-p2` on create
[00:27:00] [Manual Edits] Edit→Push basics: renamed firstName→`ZZZCLIRenamed` → publish → [Service API] confirms (v1 PUT)
[00:28:00] [Manual Edits] Delete→Push person → publish → [Service API] `GET /v2/persons/267567479` = HTTP 404; unpublished clean
[00:29:00] [Manual Edits] New→Push company `zzz-cli-co.json` → service company 312660569 (name+domain match); New→Push list membership (`Lists/Deals/zzz-cli-membership.json` entity.id=312660569) → list-entry 243192547 (company in Deals list)
[00:30:00] [Manual Edits] Delete→Push list membership → entry 404; Delete→Push company → company 404; New→Push opportunity `zzz-cli-opp.json` (listId 204872) → opp 101773518 → Delete→Push → opp 404; unpublished clean
[00:31:00] [Research] P2 fully CLI-verified → STATE matrix all P2 cells ✅, Milestone 5 ✅, edge case logged; moved P2 from PLAN.md to ARCHIVE.md; updated LOG + cross-connector playbook

Deep pass — Pass-2 write edge cases (Milestone 7):
[00:38:00] [Service API] Boundary sweep on a throwaway person: emoji/unicode PRESERVED in text + name (`café ☕ 日本語 🎯`, utf8mb4); 5000-char string ok (no truncation); integers read back as floats (`0`→`0.0`); multi-value write caps at 100 (OpenAPI); null clears accepted by service. Documented in STATE edge cases + playbook; Milestone 7 → ✅

Deep pass — new entity: Users (workspace teammates):
[00:40:00] [Service API] Discovered `GET /v2/users` (HTTP 200) + `GET /v2/users/{id}` — fixed shape {id,firstName,lastName,photoUrl,primaryEmailAddress,status,emailAddresses,role}, 2 users, cursor pagination. (`GET /reminders` exists but org has 0 → deferred.)
[00:42:00] [Research] Added the Users entity: AffinityUser type, client `listAllUsers`/`getUser`, `buildAffinityUsersTableSpec` (all-readonly reference schema), connector wiring (listTables/fetchJsonTableSpec/pullRecordFiles/pullRecordFilesByIds/parse/describe + read-only create/update/delete guards); +4 unit tests, fixed 2 listTables count tests (5→6 tenant tables). 245 tests green, lint + tsc clean
[00:44:00] [Scratch CLI] Linked + pulled the Users table (dfd_TAEohmDUDL) → 2 records (affinity-help, whalesync-testing). [Service API] local == `GET /v2/users/153926540` verbatim. Users entity live-verified end-to-end

## 2026-06-15 — gate Affinity writes behind a feature flag (DEV-10298)

Flag-guarding the connector so it can merge to prod safely (writes stay off for everyone but allow-listed users):
[17:24:00] [Research] Added server-only `UserFlag.ENABLE_AFFINITY_WRITE` (server/src/experiments/flags.ts), fail-closed (default false; PostHog-unreachable → false). NOT in ClientUserFlags
[17:25:00] [Research] Gated every service-mutating publish phase (edit/backfill/create/delete) in `PublishPlanRunService` — flag evaluated once per run against `plan.userId`; `processBatch` throws a read-only error for Affinity when the user isn't on the flag (the pre-write-codepath behavior, recorded per record as failed-batch). Non-Affinity connectors untouched. +4 unit tests in publish-plan-run.service.spec.ts → 461 publish-plan+affinity tests green, lint + tsc clean
[17:26:00] [Research] Created the PostHog flag in BOTH projects, targeted to Ivan only (person `email` exact ∈ {ivan@whalesync.com, ivan.jd@gmail.com}, 100% rollout): Prod (214130) flag 716807 — https://us.posthog.com/project/214130/feature_flags/716807 · Test (225935) flag 716808 — https://us.posthog.com/project/225935/feature_flags/716808

Refactor: move the gate into the connector (reviewer feedback — no Affinity knowledge in the generic publish runner):
[18:30:00] [Research] Added `isFeatureEnabled(flagKey)` to `ConnectorFactoryContext` (host-injected per-user flag check, same pattern as getOAuthAccessToken/createRateLimiter); `ConnectorsService` binds it to the connector's `userId` via `ExperimentsService.getBooleanFlag` (lazy user lookup, fail-closed). Threaded `plan.userId` into the publish path's `getConnector` (always set — for scheduled publishes it's `SchedulerService.buildActor`: schedule creator → first org user)
[18:31:00] [Research] AffinityConnector now owns the gate: `assertAffinityWritesEnabled()` checks `ENABLE_AFFINITY_WRITE` at the top of create/update/delete and throws the read-only error itself (inert when no checker is wired, e.g. tests). Removed the `affinityWriteFlagEnabled` param + `service === AFFINITY` branch from `PublishPlanRunService.processBatch` — runner is connector-agnostic again. Moved the 4 gate tests from the runner spec to the connector spec. 2521 publish-plan+connectors tests green, lint + tsc clean
