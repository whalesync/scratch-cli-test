# Prompt: add the Live Export engine developer option to Whalesync (dusky)

Paste the prompt below into the Whalesync agent once the Scratch MR that adds the run-store engine is
deployed and `@spinner/shared-types` with `LIVE_EXPORT_ENGINE_WORKBOOK_SETTING_KEY` is published to the
GitLab registry.

---

**Task: add a "Live Export engine" developer option to dusky's Live Export create flow and settings page.**

Scratch now has two engines for running a Live Export: `classic` (the default: every run persists through
Scratch's git store and Postgres indexes) and `run_store` (every run works in a disposable per-run store; much
faster on large exports). The engine is chosen **per Live Export** by a key in the Scratch workbook's settings
map. Every Live Export defaults to `classic`; an internal user opts one in by ticking a box. Build the UI to
choose it when creating a Live Export and to toggle it afterwards.

**Where:** in a "Developer options" section, both in the Live Export create flow and on a Live Export's
settings page. If the page already has a
developer/admin-only area (or dusky has a developer-mode / internal-user gate), put it there; otherwise add the
section behind an existing internal-only feature flag so customers don't see it yet.

**Control:** a checkbox — label "Use the new run-store engine (faster, experimental)", helper text "Runs this
Live Export without Scratch's git store. Takes effect from the next run."

**Data (Scratch REST, same API-Token/session auth dusky already uses for the Live Export's workbook):**

- At creation: dusky already creates the Live Export's workbook with `POST /workbook` and
  `{ "managedBy": "ws_export", … }`. Always add `"liveExportEngine"`: `"run_store"` when the create-flow box is
  ticked, `"classic"` otherwise (typed client: `api.workspaces.create({ …, liveExportEngine })`). Scratch
  stores it as the workbook's `live_export_engine` setting and rejects the field with a 400 on a workbook that
  isn't `ws_export`.
- Read the current value from `GET /workbook/:workbookId` → `settings.live_export_engine`. The checkbox is
  checked iff it equals `"run_store"` (absent / anything else = classic). With the typed client:
  `api.workspaces.detail(workbookId)`.
- Turn it on: `PATCH /workbook/:workbookId/settings` with `{ "updates": { "live_export_engine": "run_store" } }`.
- Turn it off: `PATCH /workbook/:workbookId/settings` with `{ "updates": { "live_export_engine": null } }` (null
  deletes the key). Typed client: `api.workspaces.updateSettings(workbookId, { updates: { … } })`. Returns 204.
- Use the exported constants from `@spinner/shared-types` rather than string literals:
  `LIVE_EXPORT_ENGINE_WORKBOOK_SETTING_KEY` (= `"live_export_engine"`), `LiveExportEngine.RUN_STORE` /
  `LiveExportEngine.CLASSIC`, and `liveExportEngineRequestedBySettings(settings)` to derive the checkbox state.
- The settings map is merge-patched, so only send the one key — never send the whole settings object (it
  holds other keys, e.g. `sync_routine`).

**Run history (nice to have):** each routine run now reports the engine it actually used —
`GET /workbooks/:workbookId/routine-runs[/:runId]` → `liveExportEngine` (`"run_store"`, `"classic"`, or null for
older runs). Show it as a small badge on each run in the Live Export's run history. A run can use `classic`
even when the checkbox is on: the engine falls back for exports that use asset transformers or incremental
pulls, when Scratch's git service has no room for another run store, and while Scratch's server-side kill
switch is on. The badge makes that visible.

**Behaviour to know about for run-store runs:**

- Per-record publish failures work as before: the publish step's `job.publicProgress.failedOperations` sample
  and `GET /cli/v1/workbooks/:workbookId/publish-v2/:pipelineId/failed-operations` (use the step's
  `pipelineId`, which looks like `le-rrn_….coa_…`). `GET /workbook/:workbookId/publish-v2/:pipelineId/operations`
  returns only the failed operations for these runs.
- `GET /workbook/:workbookId/publish-v2/:pipelineId` returns null for a run-store pipeline (there is no
  PublishPlan row) — don't treat that as an error; use the routine step's result instead.
- The pull steps report records pulled but no created/updated counts (a run store has no previous state to
  compare against); the sync and publish steps report changes as before.

**Acceptance:** a Live Export created with the box ticked shows `settings.live_export_engine = "run_store"` in
`GET /workbook/:id`, and one created without it shows `"classic"`; toggling the settings-page checkbox round-trips through `GET /workbook/:id` (refresh the page and it stays);
turning it off removes the key; the control is invisible to non-internal users; typecheck/lint/tests pass.
