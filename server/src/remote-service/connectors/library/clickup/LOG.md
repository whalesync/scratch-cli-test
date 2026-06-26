<!-- ⛔ DO NOT DELETE. Human-readable activity log for the ClickUp connector build,
     maintained by /connector-build-execute. One line per operation; tags:
     [Service UI] [Service API] [Scratch CLI] [Manual Edits]. Secrets masked. -->

# ClickUp — Connector Build Activity Log

Plain-language journal of every operation performed, in order, so a human can review what was done. Tokens masked as `pk_…`. Backfilled 2026-06-08.

Provision the test account:
[Service UI] Signed up for ClickUp Free Forever — workspace "Connector Builder Test" (team `90121811855`), via the gstack browser at https://app.clickup.com/signup; completed Google SSO + email verification (user)
[Service UI] Generated the personal API token — Settings → Apps → API Token → Generate → Copy (https://app.clickup.com/90121811855/settings/apps); the field is masked, only Copy yields the real `pk_…` (user cleared the Google SSO re-auth)

Research the live ClickUp API (ground the connector design):
[Service API] Verified the token / whoami — `curl -H "Authorization: pk_…" https://api.clickup.com/api/v2/user` → Ivan Dimitrov / ivan@whalesync.com
[Service API] Listed workspaces — `curl … /api/v2/team` → `90121811855` (Connector Builder Test)
[Service API] Listed spaces — `curl … /api/v2/team/90121811855/space` → Team Space (`90127893019`)
[Service API] Listed folders + folderless lists — `curl … /space/90127893019/folder` (none) and `/space/90127893019/list` → Project 1 (`901218672815`), Project 2 (`901218672816`), Get Started (`901218672820`)
[Service API] Inspected a list's custom fields — `curl … /list/901218672815/field` → 0 custom fields (fresh workspace)
[Service API] Inspected tasks + their shape — `curl … /list/901218672815/task` → 3 tasks, 38 top-level keys
[Service API] Probed the create write-shape — `curl -X POST … /list/901218672815/task -d '{"name":…,"status":"to do","priority":2,"due_date":…}'` → confirmed status/priority come back as objects (read) but write as name/int
[Service API] Deleted the probe task — `curl -X DELETE … /task/869dktang` → 204

Stand up the CLI harness + first pull:
[Scratch CLI] Created a workbook — `scratchmd workspaces create "ClickUp Test"` → `wkb_O6iqsdiLIV`
[Scratch CLI] Created the CLICKUP connection — `scratchmd connections --workspace wkb_O6iqsdiLIV add --service CLICKUP --param apiKey=pk_… --name "ClickUp"` → `coa_63AcxAewsa`, Health OK
[Scratch CLI] Cloned the workspace — `scratchmd workspaces init wkb_O6iqsdiLIV -o /tmp/clickup-ws`
[Scratch CLI] Listed discoverable tables — `scratchmd linked available coa_63AcxAewsa` → 3 lists
[Scratch CLI] Linked Project 1 as a table — `scratchmd linked --workspace wkb_O6iqsdiLIV add --connection-id coa_63AcxAewsa --table-id 901218672815 --name "Project 1"` → `dfd_cgQbNlXDwW`
[Scratch CLI] Full pull — `scratchmd linked --workspace wkb_O6iqsdiLIV pull dfd_cgQbNlXDwW --mode full` → 3 tasks landed verbatim as `ClickUp/Project 1/task-{1,2,3}.json`
[Manual Edits] Enabled CLI publishing for the user — `UPDATE "User" SET settings = jsonb_set(…,'{cliCanPublish}','true') WHERE email='ivan@whalesync.com'` (local `scratch` DB)

Test edit → push (via Scratch CLI publish):
[Manual Edits] Edited a task's name + description — `ClickUp/Project 1/task-1.json` (name → "Task 1 — edited via scratchmd", description set)
[Scratch CLI] Accepted the change — `scratchmd files accept "ClickUp/Project 1/task-1.json"` → 1 change accepted
[Scratch CLI] First upload attempt — `scratchmd files upload` → **500 (blocked)**: server log shows GCS signing error (`invalid_rapt`) on `upload-patch/init`; local gcloud ADC expired. Not a connector bug. (User reauthed: `gcloud auth application-default login`; server restarted to pick up new ADC.)
[Scratch CLI] Re-ran upload + publish after reauth — `scratchmd files upload && scratchmd files publish` → "1 modified", "Published 1 connection(s)"
[Service API] Verified the edit landed — `curl … /api/v2/task/869dkt3e8` → name="Task 1 — edited via scratchmd", description set
[Scratch CLI] Confirmed nothing pending — `scratchmd files unpublished` → "No unpublished changes."

Verify writes against the live API (live-integration spec, bypasses the blocked CLI publish):
[Service API] Created a task via the connector's `createRecords` on Project 2 — integration spec → new task id; verified with `curl … /task/{id}` (status="to do", priority="high", due_date set, description correct)
[Service API] Probed ClickApp gating — `curl -X POST … /list/901218672816/task -d '{…,"points":5}'` → **400 `ITEM_227` "Sprint Points ClickApp is not enabled"**; same payload without `points` → 201. Connector now omits null/feature-gated `points`/`time_estimate`.
[Service API] Updated the task via `updateRecords` (name + priority) — verified `curl … /task/{id}` → name renamed, priority="low"
[Service API] Deleted the task via `deleteRecords` — verified `curl … /task/{id}` → 404 (gone)
[Service API] Cleaned up probe tasks — `curl -X DELETE … /task/869dktuza`, `/task/869dktv70`

Test new → push (via Scratch CLI publish):
[Manual Edits] Created a new local task file — `ClickUp/Project 1/scratch-new-task.json` (name, description, status `{status:"to do"}`, priority `{priority:"high"}`)
[Scratch CLI] Accepted + uploaded + published — `scratchmd files accept "ClickUp/Project 1/scratch-new-task.json" && files upload && files publish` → "1 added", "Published 1 connection(s)"
[Service API] Verified the new task in ClickUp — `curl … /list/901218672815/task` → id `869dku1by`, name "scratch-new-task (created via CLI)", status="to do", priority="high" (both write-shape translations applied)
[Manual Edits] Confirmed the remote id flowed back — `ClickUp/Project 1/scratch-new-task.json` now has `id: 869dku1by`

Stop the local server (user request):
[Manual Edits] Killed the NestJS server — `lsof -ti tcp:3010 | xargs kill` (user will restart it; then re-killed once more on a second request)

Test delete → push (after server restart):
[Scratch CLI] Deleted the new task locally + published — `rm "ClickUp/Project 1/scratch-new-task.json" && scratchmd files accept … && files upload && files publish` → "1 deleted", "Published 1 connection(s)"
[Service API] Verified it's gone — `curl … /task/869dku1by` → `ITEM_013 "Task not found, deleted"`; `GET /list/901218672815/task` → back to 3 tasks
[Service UI] Confirmed in the ClickUp board (gstack browser) — Project 1 shows "Task 1 — edited via scratchmd", Task 2, Task 3; the created-then-deleted task is absent

Seed + round-trip a custom field (Pass 2 — browser does what the API can't):
[Service UI] Created a "CF Text" custom field on Project 1 — Fields panel → Create new → Text → name "CF Text" → Create (gstack browser); confirmed via `curl … /list/901218672815/field` → type `short_text`, id `0cc8628d-…`
[Service API] Seeded a value on Task 2 — `curl -X POST … /task/869dkt3ea/field/0cc8628d-… -d '{"value":"seeded-via-API for read test"}'`
[Scratch CLI] Re-pulled — `scratchmd linked pull dfd_cgQbNlXDwW --mode full` → task-2.json `custom_fields` holds CF Text verbatim **and** the schema legend auto-updated to include CF Text (dynamic discovery, no connector change)
[Manual Edits] Edited the custom field value — `ClickUp/Project 1/task-2.json` custom_fields[0].value → "edited-via-scratchmd push"
[Scratch CLI] Accepted + uploaded + published — connector set it via `POST /task/{id}/field/{id}`
[Service API] Verified the new custom field value landed — `curl … /task/869dkt3ea` → CF Text = "edited-via-scratchmd push"

Multi-entity refactor + hierarchical path (Workspace/Space/List + Users + Docs):
[Service API] Confirmed Users source + Docs API — `curl /api/v2/team` (members inline), `curl /api/v3/workspaces/{id}/docs` (2 docs); `GET /space/{id}` has no team id → encode kind+teamId in `remoteId`
[Manual Edits] Refactored the connector to multi-entity (`remoteId` = `['list',teamId,listId]` / `['users',teamId]` / `['doc',teamId]`); Workspace name → top path segment via `basePath`; Users from `GET /team` members; Docs via v3 API (own codepath); Users/Docs read-only. 23 unit tests + build + lint green.
[Scratch CLI] Linked Users — `scratchmd linked add --table-id users --table-id 90121811855` → pulled to `Connector Builder Test/Users/ivan-dimitrov.json` (id 302523935)
[Scratch CLI] Linked Docs — `scratchmd linked add --table-id doc --table-id 90121811855` → pulled to `Connector Builder Test/Docs/{onboarding-assistant-memory,team-docs}.json` (v3 API)
[Scratch CLI] Re-linked Project 1 (new format) — `--table-id list --table-id 90121811855 --table-id 901218672815` → tasks now at `Connector Builder Test/Team Space/Project 1/{task}.json` (full Workspace/Space/List path)
[Scratch CLI] Removed the two stale pre-fix folders (flat `Project 1`, `Team Space/Project 2`) → clean tree: everything under `Connector Builder Test/…`

Prove space-level path disambiguation:
[Service API] Created a 2nd space — `POST /team/90121811855/space {"name":"QA Space"}` → `90127895999`; list "Bugs" (`901218678720`) + a task
[Scratch CLI] Linked Bugs — `--table-id list --table-id 90121811855 --table-id 901218678720` → pulled to `Connector Builder Test/QA Space/Bugs/first-bug-in-qa-space.json`, distinct from `Connector Builder Test/Team Space/Project 1/…` (two spaces disambiguated by the path segment)

Fix desktop app (unrelated to CLI):
[Manual Edits] Built the **debug** scratchmd binary — `cd scratch-git-2 && cargo build --bin scratchmd` → `target/debug/scratchmd` (the desktop app shells out to the debug path; only the release binary existed, which is what the CLI uses)

_Next: a 2nd ClickUp **workspace** (account-level — needs the browser; API can't create workspaces) to prove cross-workspace disambiguation (same mechanism as cross-space, already proven). Then Dropdown/Relationship custom fields + FK both directions._
